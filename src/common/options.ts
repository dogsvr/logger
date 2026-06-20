import type {MessagePort} from "worker_threads";
import type {Level} from "@dogsvr/dogsvr/main_thread";

export type Mode = "central" | "inline";

/** Shipping logs to an OTLP backend (Jaeger / Tempo / SaaS). Central mode only. */
export interface OtelLogsOptions {
    /** OTLP HTTP endpoint, e.g. http://localhost:4318/v1/logs. */
    otlpEndpoint: string;
    serviceName: string;
    /** Extra resource attributes; merged with serviceName + defaults. */
    resourceAttributes?: Record<string, string>;
}

/** `level` is the only field dogsvr core inspects. */
export interface SetupOptions {
    mode: Mode;
    level: Level;
    destination?: string | number;
    base?: Record<string, unknown>;
    centralBufferHighWaterMark?: number;
    centralBufferLowWaterMark?: number;
    /** When set, central isolate also ships logs to OTLP. Throws on inline mode. */
    otel?: OtelLogsOptions;
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
