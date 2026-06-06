import type {MessagePort} from "worker_threads";
import type {Level} from "@dogsvr/dogsvr/main_thread";

export type Mode = "central" | "inline";

/** `level` is the only field dogsvr core inspects; everything else is pino-specific. */
export interface SetupOptions {
    mode: Mode;
    level: Level;
    destination?: string | number;
    base?: Record<string, unknown>;
    centralBufferHighWaterMark?: number;
    centralBufferLowWaterMark?: number;
}

export interface WorkerSetupOptions {
    mode: Mode;
    level: Level;
    destination?: string | number;
    port?: MessagePort;
    base?: Record<string, unknown>;
}

/** Opaque payload injected into `workerData.loggerInit`; consumed by `setupLoggerInWorker`. */
export interface WorkerInitPayload {
    mode: Mode;
    destination?: string | number;
    port?: MessagePort;
    [key: string]: unknown;
}
