import {isMainThread, threadId} from "worker_threads";
import type {Logger as PinoLogger} from "pino";
import type {LoggerImpl} from "@dogsvr/dogsvr/main_thread";

const PID = process.pid;
const THREAD: string | number = isMainThread ? "main" : threadId;

export function defaultBase(): Record<string, unknown> {
    return {pid: PID, thread: THREAD};
}

export function wrapPino(p: PinoLogger): LoggerImpl {
    return p as unknown as LoggerImpl;
}
