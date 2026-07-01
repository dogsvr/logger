import type {MessagePort} from "worker_threads";

export interface OtelInitFields {
    otlpEndpoint: string;
    serviceName: string;
    levelNumeric: number;
    resourceAttributes?: Record<string, string>;
}

export interface InitMsg {
    type: "init";
    destination: string | number;
    highWaterMark: number;
    lowWaterMark: number;
    otel?: OtelInitFields;
}

export interface AttachMsg { type: "attach"; port: MessagePort }
export interface FlushMsg { type: "flush" }
export interface ShutdownMsg { type: "shutdown" }

export type ControlMsg = InitMsg | AttachMsg | FlushMsg | ShutdownMsg;
