import SonicBoom from "sonic-boom";
import {parentPort, MessagePort} from "worker_threads";

// Central isolate: single writer drains NDJSON lines from all business threads + main
// into one sonic-boom. Accepts MessagePorts via postMessage control protocol:
//   { type: 'init', destination, highWaterMark, lowWaterMark }
//   { type: 'attach', port }
//   { type: 'flush' }
//   { type: 'shutdown' }
interface InitMsg {
    type: "init";
    destination: string | number;
    highWaterMark: number;
    lowWaterMark: number;
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
    // Cheap level extraction: look for `"level":N` near the start of NDJSON.
    const idx = line.indexOf("\"level\":");
    if (idx < 0 || idx > 64) return 30;
    const start = idx + 8;
    let end = start;
    while (end < line.length && line.charCodeAt(end) >= 0x30 && line.charCodeAt(end) <= 0x39) end++;
    if (end === start) return 30;
    return Number(line.slice(start, end));
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
    startMetaReporter();
}

function flushAll(): void {
    try { (sonic as unknown as {flushSync?: () => void} | null)?.flushSync?.(); } catch { /* ignore */ }
}

function shutdown(): void {
    if (metaTimer) { clearInterval(metaTimer); metaTimer = null; }
    for (const port of attachedPorts) {
        try { port.close(); } catch { /* ignore */ }
    }
    attachedPorts.clear();
    flushAll();
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
