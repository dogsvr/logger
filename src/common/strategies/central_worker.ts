import type {MessagePort} from "worker_threads";
import type {DestinationStream} from "pino";
import type {WorkerSetupOptions} from "../options";
import type {WorkerStrategy} from "./strategy";

export class CentralWorkerStrategy implements WorkerStrategy {
    private port: MessagePort;

    constructor(opts: WorkerSetupOptions) {
        if (!opts.port) {
            throw new Error("central mode requires opts.port (transfer from main thread)");
        }
        this.port = opts.port;
    }

    workerDestination(): DestinationStream {
        const port = this.port;
        return {
            write(line: string) {
                try { port.postMessage(line); } catch { /* ignore */ }
            },
        } as unknown as DestinationStream;
    }

    // Flush + shutdown live on the central isolate; worker side is a no-op.
    flush(): void { /* noop */ }
    async shutdown(): Promise<void> { /* noop */ }
}
