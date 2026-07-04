import type {DestinationStream} from "pino";
import type {Worker, MessagePort} from "worker_threads";
import type {WorkerInitPayload} from "../common/options";

export interface MainStrategy {
    mainDestination(): DestinationStream;
    issueWorkerPort(): MessagePort | undefined;
    releaseWorkerPort(worker: Worker): void;
    workerInitFor(port: MessagePort | undefined): WorkerInitPayload;
    /** Health probe. Inline always returns 0. */
    bufferedBytes(): number;
    /** Fire-and-forget flush; used by `LoggerHub.flush()`. */
    flush(): void;
    /** Drain everything (incl. otel) and tear down side processes; awaited by signal handlers. */
    shutdown(): Promise<void>;
}

export interface WorkerStrategy {
    workerDestination(): DestinationStream;
    flush(): void;
    shutdown(): Promise<void>;
}
