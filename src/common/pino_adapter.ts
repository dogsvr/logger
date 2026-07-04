import {isMainThread, threadId} from "worker_threads";
import type {Logger as PinoLogger} from "pino";
import type {LoggerImpl, SpanSink} from "@dogsvr/dogsvr/main_thread";

const PID = process.pid;
const THREAD: string | number = isMainThread ? "main" : threadId;

export function defaultBase(): Record<string, unknown> {
    return {pid: PID, thread: THREAD};
}

export function wrapPino(p: PinoLogger): LoggerImpl {
    return p as unknown as LoggerImpl;
}

/** getSink is parameterised because main and worker use different dogsvr subpaths. */
export function traceContextMixin(getSink: () => SpanSink): () => Record<string, string> {
    return (): Record<string, string> => {
        const ctx = getSink().getCurrentContext();
        if (!ctx) return {};
        const {traceId, spanId} = ctx;
        if (!traceId) return {};
        return {traceId, spanId};
    };
}

