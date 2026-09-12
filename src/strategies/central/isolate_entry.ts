import * as fs from "node:fs";
import SonicBoom from "sonic-boom";
import {parentPort, threadId, MessagePort} from "worker_threads";
import {trace, ROOT_CONTEXT, type Context} from "@opentelemetry/api";
import {SeverityNumber, type AnyValue, type AnyValueMap} from "@opentelemetry/api-logs";
import {LoggerProvider, BatchLogRecordProcessor} from "@opentelemetry/sdk-logs";
import {OTLPLogExporter} from "@opentelemetry/exporter-logs-otlp-http";
import {resourceFromAttributes} from "@opentelemetry/resources";
import type {
    AttachSabMsg,
    ControlMsg,
    DetachSabMsg,
    FlushMsg,
    FlushedMsg,
    InitMsg,
    OtelInitFields,
    SabDropReportMsg,
    TidReportMsg,
} from "./protocol";
import {SabLineReader} from "@dogsvr/dogsvr/common";
import {extractLevel} from "./pino_level";

let sonic: InstanceType<typeof SonicBoom> | null = null;
/** sonic-boom 4.x accepts Buffers in contentMode:"buffer" but its .d.ts only declares write(string). */
type BufferSink = {write(data: Buffer): boolean};
let sonicBuf: BufferSink | null = null;
let highWaterMark = 4_000_000;
let lowWaterMark = 1_000_000;
let dropMode = false;
const droppedByLevel = new Map<number, number>();
const droppedBySab = new Map<number, number>();
const attachedPorts = new Set<MessagePort>();
const attachedReaders = new Map<string, SabLineReader>();

let otelLogger: ReturnType<LoggerProvider["getLogger"]> | null = null;
let otelProvider: LoggerProvider | null = null;
let otelLevelNumeric = 0;

let metaTimer: NodeJS.Timeout | null = null;

function startMetaReporter(): void {
    if (metaTimer) return;
    metaTimer = setInterval(() => {
        if (droppedByLevel.size === 0 && droppedBySab.size === 0) return;
        const summary: Record<string, number> = {};
        for (const [level, count] of droppedByLevel) summary[String(level)] = count;
        for (const [level, count] of droppedBySab) summary[String(level)] = (summary[String(level)] ?? 0) + count;
        droppedByLevel.clear();
        droppedBySab.clear();
        try {
            process.stderr.write(
                `{"level":40,"time":"${new Date().toISOString()}","msg":"logger drop","byLevel":${JSON.stringify(summary)}}\n`,
            );
        } catch { /* ignore */ }
    }, 1000);
    metaTimer.unref();
}

function checkBackPressure(): void {
    if (!sonic) return;
    const buffered = (sonic as unknown as {_len: number})._len;
    if (!dropMode && buffered >= highWaterMark) {
        dropMode = true;
    } else if (dropMode && buffered <= lowWaterMark) {
        dropMode = false;
    }
}

function pinoLevelToSeverity(level: number): SeverityNumber {
    if (level >= 60) return SeverityNumber.FATAL;
    if (level >= 50) return SeverityNumber.ERROR;
    if (level >= 40) return SeverityNumber.WARN;
    if (level >= 30) return SeverityNumber.INFO;
    if (level >= 20) return SeverityNumber.DEBUG;
    return SeverityNumber.TRACE;
}

const ATTR_RESERVED = new Set(["level", "time", "msg", "traceId", "spanId"]);

function toAnyValue(v: unknown): AnyValue {
    if (v === null || v === undefined) return undefined;
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") return v as AnyValue;
    if (Array.isArray(v)) {
        const arr: AnyValue[] = [];
        for (const item of v) arr.push(toAnyValue(item));
        return arr;
    }
    if (t === "object") {
        const out: AnyValueMap = {};
        for (const k of Object.keys(v as Record<string, unknown>)) {
            out[k] = toAnyValue((v as Record<string, unknown>)[k]);
        }
        return out;
    }
    return String(v);
}

function emitOtel(obj: Record<string, unknown>, line: string, level: number): void {
    if (!otelLogger) return;
    const traceId = typeof obj.traceId === "string" ? obj.traceId : undefined;
    const spanId = typeof obj.spanId === "string" ? obj.spanId : undefined;

    let ctx: Context | undefined;
    if (traceId && spanId) {
        ctx = trace.setSpanContext(ROOT_CONTEXT, {traceId, spanId, traceFlags: 1});
    }

    const attributes: AnyValueMap = {};
    for (const k of Object.keys(obj)) {
        if (ATTR_RESERVED.has(k)) continue;
        const v = toAnyValue(obj[k]);
        if (v === undefined) continue;
        attributes[k] = v;
    }

    const timestamp = typeof obj.time === "number" ? obj.time : undefined;

    try {
        otelLogger.emit({
            timestamp,
            severityNumber: pinoLevelToSeverity(level),
            body: typeof obj.msg === "string" ? obj.msg : line,
            attributes,
            context: ctx,
        });
    } catch { /* ignore */ }
}

/**
 * The copy is required, not defensive: sonic-boom retains whatever Buffer it is handed
 * (`bufs.push([data])`), so passing the live ring slice lets the producer overwrite the
 * bytes before they reach disk.
 */
function onRecord(buf: Buffer, off: number, len: number, level: number): void {
    if (sonicBuf) {
        if (dropMode && level < 40) {
            droppedByLevel.set(level, (droppedByLevel.get(level) ?? 0) + 1);
        } else {
            const copy = Buffer.allocUnsafe(len);
            buf.copy(copy, 0, off, off + len);
            sonicBuf.write(copy);
            checkBackPressure();
        }
    }

    // Decode lazily — only the OTel path needs a string, and it is usually off.
    if (otelLogger && level >= otelLevelNumeric) {
        const line = buf.toString("utf8", off, off + len);
        let obj: Record<string, unknown>;
        try { obj = JSON.parse(line); } catch { return; }
        emitOtel(obj, line, level);
    }
}

/** postMessage fallback path (SAB-full overflow, stderr sink) — still string-based. */
function onLine(line: string): void {
    const level = extractLevel(line);

    if (sonicBuf) {
        if (dropMode && level < 40) {
            droppedByLevel.set(level, (droppedByLevel.get(level) ?? 0) + 1);
        } else {
            sonicBuf.write(Buffer.from(line, "utf8"));
            checkBackPressure();
        }
    }

    if (otelLogger && level >= otelLevelNumeric) {
        let obj: Record<string, unknown>;
        try { obj = JSON.parse(line); } catch { return; }
        emitOtel(obj, line, level);
    }
}

function attachPort(port: MessagePort): void {
    attachedPorts.add(port);
    port.on("message", (msg: unknown) => {
        if (typeof msg === "string") {
            onLine(msg);
            return;
        }
        if (msg && typeof msg === "object" && (msg as {type?: string}).type === "sabDropReport") {
            const rpt = msg as SabDropReportMsg;
            for (const [level, count] of Object.entries(rpt.byLevel)) {
                const n = Number(level);
                if (!Number.isFinite(n)) continue;
                droppedBySab.set(n, (droppedBySab.get(n) ?? 0) + count);
            }
        }
    });
    port.on("close", () => {
        attachedPorts.delete(port);
    });
}

function attachSab(msg: AttachSabMsg): void {
    const existing = attachedReaders.get(msg.producerId);
    if (existing) existing.stop();
    const reader = new SabLineReader(msg.sab, onRecord);
    attachedReaders.set(msg.producerId, reader);
    reader.start();
}

function detachSab(msg: DetachSabMsg): void {
    const reader = attachedReaders.get(msg.producerId);
    if (!reader) return;
    reader.drainSync();
    reader.stop();
    attachedReaders.delete(msg.producerId);
}

function drainAllSab(): void {
    for (const reader of attachedReaders.values()) reader.drainSync();
}

function initOtel(otel: OtelInitFields): void {
    otelLevelNumeric = otel.levelNumeric;
    const resource = resourceFromAttributes({
        "service.name": otel.serviceName,
        ...(otel.resourceAttributes ?? {}),
    });
    const exporter = new OTLPLogExporter({url: otel.otlpEndpoint});
    otelProvider = new LoggerProvider({
        resource,
        processors: [new BatchLogRecordProcessor(exporter)],
    });
    otelLogger = otelProvider.getLogger("@dogsvr/logger", "1.0.0");
}

function init(msg: InitMsg): void {
    if (sonic) return;
    highWaterMark = msg.highWaterMark;
    lowWaterMark = msg.lowWaterMark;
    sonic = new SonicBoom({
        ...(typeof msg.destination === "number"
            ? {fd: msg.destination}
            : {dest: msg.destination, mkdir: true}),
        sync: false,
        minLength: 4096,
        periodicFlush: 1000,
        // Records arrive as SAB slices; buffer mode avoids a decode/re-encode per line.
        contentMode: "buffer",
    });
    sonicBuf = sonic as unknown as BufferSink;
    sonic.on("error", (err) => {
        try { sonic?.reopen(); } catch {
            try { process.stderr.write(`{"level":60,"msg":"central sonic error: ${String(err)}"}\n`); } catch { /* ignore */ }
        }
    });
    if (msg.otel) initOtel(msg.otel);
    startMetaReporter();
    reportSelfTid();
}

function getSelfOsTid(): number | null {
    if (process.platform !== "linux") return null;
    try {
        const target = fs.readlinkSync("/proc/thread-self");
        const slash = target.lastIndexOf("/");
        const tid = Number(slash >= 0 ? target.slice(slash + 1) : target);
        return Number.isFinite(tid) ? tid : null;
    } catch {
        return null;
    }
}

function reportSelfTid(): void {
    if (!parentPort) return;
    const osTid = getSelfOsTid();
    if (osTid === null) return;
    try {
        parentPort.postMessage({type: "tidReport", osTid, nodeThreadId: threadId} satisfies TidReportMsg);
    } catch { /* ignore */ }
}

async function flushAll(flushId?: number): Promise<void> {
    drainAllSab();
    try { sonic?.flushSync(); } catch { /* ignore */ }
    try { await otelProvider?.forceFlush(); } catch { /* ignore */ }
    if (typeof flushId === "number" && parentPort) {
        try { parentPort.postMessage({type: "flushed", flushId} satisfies FlushedMsg); } catch { /* ignore */ }
    }
}

async function shutdown(): Promise<void> {
    if (metaTimer) { clearInterval(metaTimer); metaTimer = null; }
    for (const reader of attachedReaders.values()) reader.stop();
    for (const port of attachedPorts) {
        try { port.close(); } catch { /* ignore */ }
    }
    attachedReaders.clear();
    attachedPorts.clear();
    await flushAll();
    try { await otelProvider?.shutdown(); } catch { /* ignore */ }
    process.exit(0);
}

if (!parentPort) {
    throw new Error("isolate_entry must run inside a Worker");
}

parentPort.on("message", (msg: ControlMsg) => {
    switch (msg.type) {
        case "init": init(msg); break;
        case "attach": attachPort(msg.port); break;
        case "attachSab": attachSab(msg); break;
        case "detachSab": detachSab(msg); break;
        case "sabDropReport": {
            const rpt = msg;
            for (const [level, count] of Object.entries(rpt.byLevel)) {
                const n = Number(level);
                if (!Number.isFinite(n)) continue;
                droppedBySab.set(n, (droppedBySab.get(n) ?? 0) + count);
            }
            break;
        }
        case "flush": void flushAll((msg as FlushMsg).flushId); break;
        case "shutdown": void shutdown(); break;
    }
});
