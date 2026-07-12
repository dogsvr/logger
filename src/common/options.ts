import type {MessagePort} from "worker_threads";
import type {LevelWithSilent as Level} from "pino";

export type {Level};

export type Mode = "central" | "inline";

/**
 * OTLP log shipping. Central mode only.
 *
 * Required-when-enabled fields are validated at runtime in `setupLogger` rather than
 * with a discriminated union, so a single env-driven bool can flip without forking config.
 */
export interface OtelLogsOptions {
    enabled: boolean;
    /** Required when enabled=true. e.g. http://localhost:4318/v1/logs */
    otlpEndpoint?: string;
    /** Required when enabled=true. */
    serviceName?: string;
    /** OTLP-sink minimum level. Independent of `SetupOptions.level`. Defaults to it. */
    level?: Level;
    /** Merged with serviceName + defaults. */
    resourceAttributes?: Record<string, string>;
}

export type CentralTransport = "sab" | "postMessage";
export type LogFallbackOnFull = "warn+" | "drop";

/** Central-mode transport for the data path. Ignored in inline mode. */
export interface CentralChannelOptions {
    /** Default "sab". */
    transport?: CentralTransport;
    /** Ring-buffer data-area size per producer. Default 4 MiB. */
    sabSizeBytes?: number;
    /** SAB-full policy for log data path. Default "warn+". */
    fallbackOnFull?: LogFallbackOnFull;
}

export interface SetupOptions {
    mode: Mode;
    level: Level;
    destination?: string | number;
    base?: Record<string, unknown>;
    centralBufferHighWaterMark?: number;
    centralBufferLowWaterMark?: number;
    /** Central-mode data-path transport. */
    channel?: CentralChannelOptions;
    /** Throws on inline mode. */
    otel?: OtelLogsOptions;
}

export interface WorkerSetupOptions {
    mode: Mode;
    level: Level;
    destination?: string | number;
    port?: MessagePort;
    sab?: SharedArrayBuffer;
    producerId?: string;
    sabFallbackOnFull?: LogFallbackOnFull;
    base?: Record<string, unknown>;
}

/** Opaque payload injected into `workerData.loggerInit`; consumed by `setupLoggerInWorker`. */
export interface WorkerInitPayload {
    mode: Mode;
    destination?: string | number;
    port?: MessagePort;
    sab?: SharedArrayBuffer;
    producerId?: string;
    sabFallbackOnFull?: LogFallbackOnFull;
    [key: string]: unknown;
}
