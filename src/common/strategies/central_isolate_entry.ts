import SonicBoom from "sonic-boom";
import {parentPort, MessagePort} from "worker_threads";
import {trace, ROOT_CONTEXT, type Context} from "@opentelemetry/api";
import {SeverityNumber} from "@opentelemetry/api-logs";
import {LoggerProvider, BatchLogRecordProcessor} from "@opentelemetry/sdk-logs";
import {OTLPLogExporter} from "@opentelemetry/exporter-logs-otlp-http";
import {resourceFromAttributes} from "@opentelemetry/resources";

// Central isolate: single worker drains NDJSON lines from all threads into one sonic-boom.
// Control protocol (postMessage):
//   { type: 'init', destination, highWaterMark, lowWaterMark, otel? }
//   { type: 'attach', port }
//   { type: 'flush' }
//   { type: 'shutdown' }
interface OtelInitFields {
    otlpEndpoint: string;
    serviceName: string;
    resourceAttributes?: Record<string, string>;
}
interface InitMsg {
    type: "init";
    destination: string | number;
    highWaterMark: number;
    lowWaterMark: number;
    otel?: OtelInitFields;
}
interface AttachMsg { type: "attach"; port: MessagePort }
interface FlushMsg { type: "flush" }
interface ShutdownMsg { type: "shutdown" }
type ControlMsg = InitMsg | AttachMsg | FlushMsg | ShutdownMsg;

let sonic: InstanceType<typeof SonicBoom> | null = null;
let highWaterMark = 4_000_000;
let lowWaterMark = 1_000_000;
let dropMode = false;
const droppedByLevel = new Map<number, number>();
const attachedPorts = new Set<MessagePort>();

let otelLogger: ReturnType<LoggerProvider["getLogger"]> | null = null;
let otelProvider: LoggerProvider | null = null;

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
    metaTimer.unref?.();
}

function checkBackPressure(): void {
    if (!sonic) return;
    const buffered = (sonic as unknown as {writableLength?: number}).writableLength ?? 0;
    if (!dropMode && buffered >= highWaterMark) {
        dropMode = true;
    } else if (dropMode && buffered <= lowWaterMark) {
        dropMode = false;
    }
}

function extractLevel(line: string): number {
    const idx = line.indexOf("\"level\":");
    if (idx < 0 || idx > 64) return 30;
    const start = idx + 8;
    let end = start;
    while (end < line.length && line.charCodeAt(end) >= 0x30 && line.charCodeAt(end) <= 0x39) end++;
    if (end === start) return 30;
    return Number(line.slice(start, end));
}

/**
 * Map pino numeric level to otel SeverityNumber.
 * (10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal)
 */
function pinoLevelToSeverity(level: number): SeverityNumber {
    if (level >= 60) return SeverityNumber.FATAL;
    if (level >= 50) return SeverityNumber.ERROR;
    if (level >= 40) return SeverityNumber.WARN;
    if (level >= 30) return SeverityNumber.INFO;
    if (level >= 20) return SeverityNumber.DEBUG;
    return SeverityNumber.TRACE;
}

function emitOtel(line: string): void {
    if (!otelLogger) return;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line); } catch { return; }
    const level = typeof obj.level === "number" ? obj.level : 30;
    const traceId = typeof obj.traceId === "string" ? obj.traceId : undefined;
    const spanId = typeof obj.spanId === "string" ? obj.spanId : undefined;

    let ctx: Context | undefined;
    if (traceId && spanId) {
        ctx = trace.setSpanContext(ROOT_CONTEXT, {traceId, spanId, traceFlags: 1});
    }

    const attributes: Record<string, string> = {};
    for (const k of Object.keys(obj)) {
        if (k === "msg" || k === "traceId" || k === "spanId") continue;
        const v = obj[k];
        if (v == null) continue;
        attributes[k] = typeof v === "string" ? v : JSON.stringify(v);
    }

    try {
        otelLogger.emit({
            severityNumber: pinoLevelToSeverity(level),
            body: typeof obj.msg === "string" ? obj.msg : line,
            attributes,
            context: ctx,
        });
    } catch { /* ignore */ }
}

function onLine(line: string): void {
    if (!sonic) return;
    if (dropMode) {
        const level = extractLevel(line);
    // Always preserve warn/error/fatal (40+); drop trace/debug/info on pressure.
        if (level < 40) {
            droppedByLevel.set(level, (droppedByLevel.get(level) ?? 0) + 1);
            return;
        }
    }
    sonic.write(line);
    emitOtel(line);
    checkBackPressure();
}

function attachPort(port: MessagePort): void {
    attachedPorts.add(port);
    port.on("message", (line: unknown) => {
        if (typeof line === "string") onLine(line);
    });
    port.on("close", () => {
        attachedPorts.delete(port);
    });
    port.start?.();
}

function initOtel(otel: OtelInitFields): void {
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
        try { (sonic as unknown as {reopen?: (file?: string) => void}).reopen?.(); } catch {
            try { process.stderr.write(`{"level":60,"msg":"central sonic error: ${String(err)}"}\n`); } catch { /* ignore */ }
        }
    });
    if (msg.otel) initOtel(msg.otel);
    startMetaReporter();
}

function flushAll(): void {
    try { (sonic as unknown as {flushSync?: () => void} | null)?.flushSync?.(); } catch { /* ignore */ }
    try { otelProvider?.forceFlush(); } catch { /* ignore */ }
}

function shutdown(): void {
    if (metaTimer) { clearInterval(metaTimer); metaTimer = null; }
    for (const port of attachedPorts) {
        try { port.close(); } catch { /* ignore */ }
    }
    attachedPorts.clear();
    flushAll();
    try { otelProvider?.shutdown(); } catch { /* ignore */ }
    process.exit(0);
}

if (!parentPort) {
    throw new Error("central_isolate_entry must run inside a Worker");
}

parentPort.on("message", (msg: ControlMsg) => {
    switch (msg.type) {
        case "init": init(msg); break;
        case "attach": attachPort(msg.port); break;
        case "flush": flushAll(); break;
        case "shutdown": shutdown(); break;
    }
});
