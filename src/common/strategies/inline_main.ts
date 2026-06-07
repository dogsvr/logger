import SonicBoom from "sonic-boom";
import type {DestinationStream} from "pino";
import type {Worker, MessagePort} from "worker_threads";
import type {SetupOptions, WorkerInitPayload} from "../options";
import type {MainStrategy} from "./strategy";

/** Direct sonic-boom to destination fd; no central isolate or MessagePort. */
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
        const len = (this.sonic as unknown as {writableLength?: number}).writableLength;
        return typeof len === "number" ? len : 0;
    }

    flush(): void {
        try { (this.sonic as unknown as {flushSync?: () => void}).flushSync?.(); } catch { /* ignore */ }
    }
}
