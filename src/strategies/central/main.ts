import * as path from "path";
import {Worker, MessageChannel, type MessagePort} from "worker_threads";
import pino, {type DestinationStream} from "pino";
import {registerInternalThread} from "@dogsvr/dogsvr/main_thread";
import type {SetupOptions, WorkerInitPayload, OtelLogsOptions, Level} from "../../common/options";
import type {MainStrategy} from "../strategy";
import type {AttachMsg, FlushMsg, InitMsg, OtelInitFields, ShutdownMsg, TidReportMsg} from "./protocol";

const ISOLATE_ENTRY = path.join(__dirname, "isolate_entry.js");

const DEFAULT_HIGH_WATER = 4_000_000;
const DEFAULT_LOW_WATER = 1_000_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

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
 * post NDJSON lines over MessagePorts, eliminating concurrent fs.write races.
 */
export class CentralMainStrategy implements MainStrategy {
    private centralWorker: Worker;
    private mainSink: DestinationStream;
    private readonly destination: string | number;
    private exitPromise: Promise<void>;
    private shuttingDown = false;

    constructor(opts: SetupOptions) {
        this.destination = opts.destination ?? 1;
        const high = opts.centralBufferHighWaterMark ?? DEFAULT_HIGH_WATER;
        const low = opts.centralBufferLowWaterMark ?? DEFAULT_LOW_WATER;

        this.centralWorker = new Worker(ISOLATE_ENTRY);
        this.centralWorker.on("error", (err) => {
            try { process.stderr.write(`{"level":60,"msg":"central isolate error: ${String(err)}"}\n`); } catch { /* ignore */ }
        });
        this.centralWorker.on("message", (msg: TidReportMsg) => {
            if (msg?.type === "tidReport") {
                registerInternalThread("logger_central", msg.osTid, msg.nodeThreadId);
            }
        });
        this.exitPromise = new Promise<void>((resolve) => {
            this.centralWorker.once("exit", () => {
                // SPOF degradation: route late-arriving lines to stderr after isolate dies.
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

        const ch = new MessageChannel();
        this.centralWorker.postMessage(
            {type: "attach", port: ch.port1} satisfies AttachMsg,
            [ch.port1],
        );
        this.mainSink = portSink(ch.port2);
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
        return {mode: "central", port};
    }

    bufferedBytes(): number {
        return 0;
    }

    flush(): void {
        try { this.centralWorker.postMessage({type: "flush"} satisfies FlushMsg); } catch { /* ignore */ }
    }

    /** Wait for the isolate to drain (sonic.flushSync + otel shutdown) before resolving. Bounded. */
    async shutdown(): Promise<void> {
        if (this.shuttingDown) return this.exitPromise;
        this.shuttingDown = true;
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
