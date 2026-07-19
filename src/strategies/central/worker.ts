import type {DestinationStream} from "pino";
import type {WorkerSetupOptions} from "../../common/options";
import type {WorkerStrategy} from "../strategy";
import {SabLogWriter} from "./sab_writer";

export class CentralWorkerStrategy implements WorkerStrategy {
    private sink: DestinationStream;
    private sabWriter: SabLogWriter | null = null;

    constructor(opts: WorkerSetupOptions) {
        if (!opts.port) {
            throw new Error("central mode requires opts.port (transfer from main thread)");
        }
        if (opts.sab && opts.producerId !== undefined) {
            this.sabWriter = new SabLogWriter({
                sab: opts.sab,
                producerId: opts.producerId,
                fallbackPort: opts.port,
                fallbackOnFull: opts.sabFallbackOnFull ?? "warn+",
            });
            this.sink = this.sabWriter;
        } else {
            const port = opts.port;
            this.sink = {
                write(line: string) {
                    try { port.postMessage(line); } catch { /* ignore */ }
                },
            } as unknown as DestinationStream;
        }
    }

    workerDestination(): DestinationStream {
        return this.sink;
    }

    flush(): void { /* noop; central isolate owns flush */ }

    async shutdown(): Promise<void> {
        if (this.sabWriter) this.sabWriter.stop();
    }
}
