import SonicBoom from "sonic-boom";
import {parentPort, MessagePort} from "worker_threads";
import {trace, ROOT_CONTEXT, type Context} from "@opentelemetry/api";
import {SeverityNumber, type AnyValue, type AnyValueMap} from "@opentelemetry/api-logs";
import {LoggerProvider, BatchLogRecordProcessor} from "@opentelemetry/sdk-logs";
import {OTLPLogExporter} from "@opentelemetry/exporter-logs-otlp-http";
import {resourceFromAttributes} from "@opentelemetry/resources";
import type {ControlMsg, InitMsg, OtelInitFields} from "./protocol";

let sonic: InstanceType<typeof SonicBoom> | null = null;
let highWaterMark = 4_000_000;
let lowWaterMark = 1_000_000;
let dropMode = false;
const droppedByLevel = new Map<number, number>();
const attachedPorts = new Set<MessagePort>();

let otelLogger: ReturnType<LoggerProvider["getLogger"]> | null = null;
let otelProvider: LoggerProvider | null = null;
let otelLevelNumeric = 0;

let metaTimer: NodeJS.Timeout | null = null;

function startMetaReporter(): void {
    if (metaTimer) return;
    metaTimer = setInterval(() => {
        if (droppedByLevel.size === 0) return;
        const summary: Record<string, number> = {};
        for (const [level, count] of droppedByLevel) summary[String(level)] = count;
        droppedByLevel.clear();
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
    // sonic-boom v4 has no public buffered-bytes accessor; `_len` is the internal
    // counter. Pinned to ^4.2.1; re-verify on minor bumps.
    const buffered = (sonic as unknown as {_len: number})._len;
    if (!dropMode && buffered >= highWaterMark) {
        dropMode = true;
    } else if (dropMode && buffered <= lowWaterMark) {
        dropMode = false;
    }
}

function extractLevel(line: string): number {
    const idx = line.indexOf("\"level\":");
    // pino emits `level` as the first cache slot; >64 is a defensive bound.
    if (idx < 0 || idx > 64) return 30;
    const start = idx + 8;
    let end = start;
    while (end < line.length && line.charCodeAt(end) >= 0x30 && line.charCodeAt(end) <= 0x39) end++;
    if (end === start) return 30;
    return Number(line.slice(start, end));
}

function pinoLevelToSeverity(level: number): SeverityNumber {
    if (level >= 60) return SeverityNumber.FATAL;
    if (level >= 50) return SeverityNumber.ERROR;
    if (level >= 40) return SeverityNumber.WARN;
    if (level >= 30) return SeverityNumber.INFO;
    if (level >= 20) return SeverityNumber.DEBUG;
    return SeverityNumber.TRACE;
}

// Mapped to dedicated LogRecord fields, not attributes.
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

    // Preserve the originating thread's wall-clock; pino `time` is epoch ms.
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

function onLine(line: string): void {
    const level = extractLevel(line);

    if (sonic) {
        // Preserve warn+ on backpressure; drop trace/debug/info.
        if (dropMode && level < 40) {
            droppedByLevel.set(level, (droppedByLevel.get(level) ?? 0) + 1);
        } else {
            sonic.write(line);
            checkBackPressure();
        }
    }

    // otel sink is independent of sonic backpressure.
    if (otelLogger && level >= otelLevelNumeric) {
        let obj: Record<string, unknown>;
        try { obj = JSON.parse(line); } catch { return; }
        emitOtel(obj, line, level);
    }
}

function attachPort(port: MessagePort): void {
    attachedPorts.add(port);
    port.on("message", (line: unknown) => {
        if (typeof line === "string") onLine(line);
    });
    port.on("close", () => {
        attachedPorts.delete(port);
    });
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
    });
    sonic.on("error", (err) => {
        try { sonic?.reopen(); } catch {
            try { process.stderr.write(`{"level":60,"msg":"central sonic error: ${String(err)}"}\n`); } catch { /* ignore */ }
        }
    });
    if (msg.otel) initOtel(msg.otel);
    startMetaReporter();
}

async function flushAll(): Promise<void> {
    try { sonic?.flushSync(); } catch { /* ignore */ }
    try { await otelProvider?.forceFlush(); } catch { /* ignore */ }
}

async function shutdown(): Promise<void> {
    if (metaTimer) { clearInterval(metaTimer); metaTimer = null; }
    // Close ports before flush so no `onLine` races with flushSync.
    for (const port of attachedPorts) {
        try { port.close(); } catch { /* ignore */ }
    }
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
        case "flush": void flushAll(); break;
        case "shutdown": void shutdown(); break;
    }
});
