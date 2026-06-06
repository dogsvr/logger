import {isMainThread, threadId} from "worker_threads";
import * as os from "os";

const HOSTNAME = os.hostname();
const PID = process.pid;
const THREAD: string | number = isMainThread ? "main" : threadId;

export function defaultBase(): Record<string, unknown> {
    return {pid: PID, hostname: HOSTNAME, thread: THREAD};
}
