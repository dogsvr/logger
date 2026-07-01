import SonicBoom from "sonic-boom";
import type {DestinationStream} from "pino";
import type {Worker, MessagePort} from "worker_threads";
import type {SetupOptions, WorkerInitPayload} from "../options";
import type {MainStrategy} from "./strategy";

export class InlineMainStrategy implements MainStrategy {
    private sonic: InstanceType<typeof SonicBoom>;
    private readonly destination: string | number;

    constructor(opts: SetupOptions) {
        this.destination = opts.destination ?? 1;
        this.sonic = new SonicBoom({
            ...(typeof this.destination === "number"
                ? {fd: this.destination}
                : {dest: this.destination, mkdir: true}),
            sync: false,
            minLength: 4096,
            periodicFlush: 1000,
        });
    }

    mainDestination(): DestinationStream {
        return this.sonic as unknown as DestinationStream;
    }

    issueWorkerPort(): MessagePort | undefined {
        return undefined;
    }

    releaseWorkerPort(_worker: Worker): void { /* noop */ }

    workerInitFor(_port: MessagePort | undefined): WorkerInitPayload {
        return {mode: "inline", destination: this.destination};
    }

    bufferedBytes(): number {
        // sonic-boom v4 has no public buffered-bytes accessor; pinned to ^4.2.1.
        return (this.sonic as unknown as {_len: number})._len;
    }

    flush(): void {
        try { this.sonic.flushSync(); } catch { /* ignore */ }
    }

    async shutdown(): Promise<void> {
        try { this.sonic.flushSync(); } catch { /* ignore */ }
    }
}
