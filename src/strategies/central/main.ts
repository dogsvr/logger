import * as path from "path";
import {Worker, MessageChannel, type MessagePort} from "worker_threads";
import pino, {type DestinationStream} from "pino";
import {registerInternalThread} from "@dogsvr/dogsvr/main_thread";
import type {
    SetupOptions,
    WorkerInitPayload,
    OtelLogsOptions,
    Level,
    CentralTransport,
    LogFallbackOnFull,
} from "../../common/options";
import type {MainStrategy} from "../strategy";
import type {
    AttachMsg,
    AttachSabMsg,
    DetachSabMsg,
    FlushMsg,
    InitMsg,
    OtelInitFields,
    ShutdownMsg,
    TidReportMsg,
} from "./protocol";
import {SabLogWriter, DEFAULT_LOG_SAB_DATA_BYTES} from "./sab_writer";
import {makeLineSab} from "@dogsvr/dogsvr/common";

const ISOLATE_ENTRY = path.join(__dirname, "isolate_entry.js");

const DEFAULT_HIGH_WATER = 4_000_000;
const DEFAULT_LOW_WATER = 1_000_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const MAIN_PRODUCER_ID = "main";

function buildOtelInitFields(otel: OtelLogsOptions, fallbackLevel: Level): OtelInitFields {
    const levelName = otel.level ?? fallbackLevel;
    const levelNumeric = pino.levels.values[levelName] ?? 0;
    return {
        otlpEndpoint: otel.otlpEndpoint!,
        serviceName: otel.serviceName!,
        levelNumeric,
        resourceAttributes: otel.resourceAttributes,
    };
}

/**
 * Single dedicated Worker isolate owns the destination fd; all business threads
 * post NDJSON lines over either SAB ring buffers or MessagePorts.
 */
export class CentralMainStrategy implements MainStrategy {
    private centralWorker: Worker;
    private mainSink: DestinationStream;
    private mainSabWriter: SabLogWriter | null = null;
    private mainPort: MessagePort | null = null;
    private readonly destination: string | number;
    private readonly transport: CentralTransport;
    private readonly sabSizeBytes: number;
    private readonly sabFallbackOnFull: LogFallbackOnFull;
    private nextWorkerSlot = 0;
    private exitPromise: Promise<void>;
    private shuttingDown = false;
    private pendingFlushes = new Map<number, () => void>();
    private nextFlushId = 1;

    constructor(opts: SetupOptions) {
        this.destination = opts.destination ?? 1;
        const high = opts.centralBufferHighWaterMark ?? DEFAULT_HIGH_WATER;
        const low = opts.centralBufferLowWaterMark ?? DEFAULT_LOW_WATER;
        this.transport = opts.channel?.transport ?? "sab";
        this.sabSizeBytes = opts.channel?.sabSizeBytes ?? DEFAULT_LOG_SAB_DATA_BYTES;
        this.sabFallbackOnFull = opts.channel?.fallbackOnFull ?? "warn+";

        this.centralWorker = new Worker(ISOLATE_ENTRY);
        this.centralWorker.on("error", (err) => {
            try { process.stderr.write(`{"level":60,"msg":"central isolate error: ${String(err)}"}\n`); } catch { /* ignore */ }
        });
        this.centralWorker.on("message", (msg: TidReportMsg | {type: "flushed"; flushId?: number}) => {
            if (msg?.type === "tidReport") {
                const tid = msg as TidReportMsg;
                registerInternalThread("logger_central", tid.osTid, tid.nodeThreadId);
                return;
            }
            if (msg?.type === "flushed" && typeof msg.flushId === "number") {
                const cb = this.pendingFlushes.get(msg.flushId);
                if (cb) {
                    this.pendingFlushes.delete(msg.flushId);
                    cb();
                }
            }
        });
        this.exitPromise = new Promise<void>((resolve) => {
            this.centralWorker.once("exit", () => {
                this.mainSink = stderrFallback();
                resolve();
            });
        });
        this.centralWorker.postMessage({
            type: "init",
            destination: this.destination,
            highWaterMark: high,
            lowWaterMark: low,
            otel: opts.otel?.enabled ? buildOtelInitFields(opts.otel, opts.level) : undefined,
        } satisfies InitMsg);

        const mainCh = new MessageChannel();
        this.centralWorker.postMessage(
            {type: "attach", port: mainCh.port1} satisfies AttachMsg,
            [mainCh.port1],
        );
        this.mainPort = mainCh.port2;

        if (this.transport === "sab") {
            const sab = makeLineSab(this.sabSizeBytes);
            this.centralWorker.postMessage(
                {type: "attachSab", sab, producerId: MAIN_PRODUCER_ID} satisfies AttachSabMsg,
            );
            this.mainSabWriter = new SabLogWriter({
                sab,
                producerId: MAIN_PRODUCER_ID,
                fallbackPort: this.mainPort,
                fallbackOnFull: this.sabFallbackOnFull,
            });
            this.mainSink = this.mainSabWriter;
        } else {
            this.mainSink = portSink(this.mainPort);
        }
    }

    mainDestination(): DestinationStream {
        return this.mainSink;
    }

    issueWorkerPort(): MessagePort | undefined {
        const ch = new MessageChannel();
        this.centralWorker.postMessage(
            {type: "attach", port: ch.port1} satisfies AttachMsg,
            [ch.port1],
        );
        return ch.port2;
    }

    releaseWorkerPort(_worker: Worker): void {
        // port.on('close') in the central isolate handles cleanup.
    }

    workerInitFor(port: MessagePort | undefined): WorkerInitPayload {
        const payload: WorkerInitPayload = {mode: "central", port};
        if (this.transport === "sab") {
            const producerId = String(this.nextWorkerSlot++);
            const sab = makeLineSab(this.sabSizeBytes);
            this.centralWorker.postMessage(
                {type: "attachSab", sab, producerId} satisfies AttachSabMsg,
            );
            payload.sab = sab;
            payload.producerId = producerId;
            payload.sabFallbackOnFull = this.sabFallbackOnFull;
        }
        return payload;
    }

    bufferedBytes(): number {
        return 0;
    }

    flush(): void {
        try { this.centralWorker.postMessage({type: "flush"} satisfies FlushMsg); } catch { /* ignore */ }
    }

    /** Await drain of everything currently sent so far; bounded by isolate liveness. */
    flushAwaitable(): Promise<void> {
        return new Promise<void>((resolve) => {
            const flushId = this.nextFlushId++;
            this.pendingFlushes.set(flushId, resolve);
            try {
                this.centralWorker.postMessage({type: "flush", flushId} satisfies FlushMsg);
            } catch {
                this.pendingFlushes.delete(flushId);
                resolve();
            }
        });
    }

    async shutdown(): Promise<void> {
        if (this.shuttingDown) return this.exitPromise;
        this.shuttingDown = true;
        if (this.mainSabWriter) this.mainSabWriter.stop();
        try {
            this.centralWorker.postMessage({type: "shutdown"} satisfies ShutdownMsg);
        } catch { /* ignore */ }
        await Promise.race([
            this.exitPromise,
            new Promise<void>((resolve) => {
                const t = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
                t.unref();
            }),
        ]);
    }

    /** Called by hot-update drain: signal central to detach an outgoing worker's SAB reader. */
    detachWorkerSab(producerId: string): void {
        try {
            this.centralWorker.postMessage(
                {type: "detachSab", producerId} satisfies DetachSabMsg,
            );
        } catch { /* ignore */ }
    }
}

function portSink(port: MessagePort): DestinationStream {
    return {
        write(line: string) {
            try { port.postMessage(line); } catch { /* ignore */ }
        },
    } as unknown as DestinationStream;
}

function stderrFallback(): DestinationStream {
    return {
        write(line: string) {
            try { process.stderr.write(line); } catch { /* ignore */ }
        },
    } as unknown as DestinationStream;
}
