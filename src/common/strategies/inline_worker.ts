import SonicBoom from "sonic-boom";
import type {DestinationStream} from "pino";
import type {WorkerSetupOptions} from "../options";
import type {WorkerStrategy} from "./strategy";

/**
 * Each worker owns its own sonic-boom to the same fd (typically a file path,
 * for O_APPEND atomicity across N+1 writers).
 */
export class InlineWorkerStrategy implements WorkerStrategy {
    private sonic: InstanceType<typeof SonicBoom>;

    constructor(opts: WorkerSetupOptions) {
        const destination = opts.destination ?? 1;
        this.sonic = new SonicBoom({
            ...(typeof destination === "number"
                ? {fd: destination}
                : {dest: destination, mkdir: true}),
            sync: false,
            minLength: 4096,
        });
    }

    workerDestination(): DestinationStream {
        return this.sonic as unknown as DestinationStream;
    }

    flush(): void {
        try { (this.sonic as unknown as {flushSync?: () => void}).flushSync?.(); } catch { /* ignore */ }
    }
}
