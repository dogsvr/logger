import type {DestinationStream} from "pino";
import type {Worker, MessagePort} from "worker_threads";
import type {WorkerInitPayload} from "../options";

export interface MainStrategy {
    mainDestination(): DestinationStream;
    issueWorkerPort(): MessagePort | undefined;
    releaseWorkerPort(worker: Worker): void;
    workerInitFor(port: MessagePort | undefined): WorkerInitPayload;
    /** Health probe. Inline always returns 0. */
    bufferedBytes(): number;
    flush(): void;
}

export interface WorkerStrategy {
    workerDestination(): DestinationStream;
    flush(): void;
}
