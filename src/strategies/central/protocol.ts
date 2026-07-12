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
export interface AttachSabMsg { type: "attachSab"; sab: SharedArrayBuffer; producerId: string }
export interface DetachSabMsg { type: "detachSab"; producerId: string }
export interface SabDropReportMsg { type: "sabDropReport"; producerId: string; byLevel: Record<number, number> }
export interface FlushMsg { type: "flush"; flushId?: number }
export interface FlushedMsg { type: "flushed"; flushId?: number }
export interface ShutdownMsg { type: "shutdown" }

export type ControlMsg =
    | InitMsg
    | AttachMsg
    | AttachSabMsg
    | DetachSabMsg
    | SabDropReportMsg
    | FlushMsg
    | ShutdownMsg;

export interface TidReportMsg { type: "tidReport"; osTid: number; nodeThreadId: number }
