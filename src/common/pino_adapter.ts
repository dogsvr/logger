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

/**
 * Build a pino mixin that injects traceId/spanId from the active span.
 * getSink is parameterised because main and worker use different dogsvr subpaths.
 */
export function traceContextMixin(getSink: () => SpanSink): () => Record<string, string> {
    const empty: Record<string, string> = {};
    return () => {
        const span = getSink().getCurrent();
        if (!span) return empty;
        const ctx = span.context();
        if (!ctx.traceId) return empty;
        return {traceId: ctx.traceId, spanId: ctx.spanId};
    };
}

