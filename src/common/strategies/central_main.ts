import * as path from "path";
import {Worker, MessageChannel, type MessagePort} from "worker_threads";
import type {DestinationStream} from "pino";
import type {SetupOptions, WorkerInitPayload} from "../options";
import type {MainStrategy} from "./strategy";

const ISOLATE_ENTRY = path.join(__dirname, "central_isolate_entry.js");

const DEFAULT_HIGH_WATER = 4_000_000;
const DEFAULT_LOW_WATER = 1_000_000;

/**
 * Single dedicated Worker isolate owns the destination fd; all business threads
 * post NDJSON lines over MessagePorts, eliminating concurrent fs.write races.
 */
export class CentralMainStrategy implements MainStrategy {
    private centralWorker: Worker;
    private mainSink: DestinationStream;
    private readonly destination: string | number;

    constructor(opts: SetupOptions) {
        this.destination = opts.destination ?? 1;
        const high = opts.centralBufferHighWaterMark ?? DEFAULT_HIGH_WATER;
        const low = opts.centralBufferLowWaterMark ?? DEFAULT_LOW_WATER;

        this.centralWorker = new Worker(ISOLATE_ENTRY);
        this.centralWorker.on("error", (err) => {
            try { process.stderr.write(`{"level":60,"msg":"central isolate error: ${String(err)}"}\n`); } catch { /* ignore */ }
        });
        // SPOF degradation: central isolate dies → fall back to stderr.
        this.centralWorker.on("exit", () => {
            this.mainSink = stderrFallback();
        });
        this.centralWorker.postMessage({
            type: "init",
            destination: this.destination,
            highWaterMark: high,
            lowWaterMark: low,
            otel: opts.otel,
        });

        const ch = new MessageChannel();
        this.centralWorker.postMessage({type: "attach", port: ch.port1}, [ch.port1]);
        this.mainSink = portSink(ch.port2);
    }

    mainDestination(): DestinationStream {
        return this.mainSink;
    }

    issueWorkerPort(): MessagePort | undefined {
        const ch = new MessageChannel();
        this.centralWorker.postMessage({type: "attach", port: ch.port1}, [ch.port1]);
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
        try { this.centralWorker.postMessage({type: "flush"}); } catch { /* ignore */ }
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
