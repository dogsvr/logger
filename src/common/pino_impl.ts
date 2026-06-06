import type {Logger as PinoLogger} from "pino";
import type {LoggerImpl} from "@dogsvr/dogsvr/main_thread";

export function wrapPino(p: PinoLogger): LoggerImpl {
    return {
        trace: (a: object | string, b?: string, ...c: unknown[]) => (p.trace as Function)(a, b, ...c),
        debug: (a: object | string, b?: string, ...c: unknown[]) => (p.debug as Function)(a, b, ...c),
        info: (a: object | string, b?: string, ...c: unknown[]) => (p.info as Function)(a, b, ...c),
        warn: (a: object | string, b?: string, ...c: unknown[]) => (p.warn as Function)(a, b, ...c),
        error: (a: object | string, b?: string, ...c: unknown[]) => (p.error as Function)(a, b, ...c),
        fatal: (a: object | string, b?: string, ...c: unknown[]) => (p.fatal as Function)(a, b, ...c),
        isLevelEnabled: (level: string) => p.isLevelEnabled(level),
        child: (bindings: Record<string, unknown>) => wrapPino(p.child(bindings)),
        flush: () => {
            const f = (p as unknown as {flush?: (cb?: (e?: Error) => void) => void}).flush;
            if (typeof f === "function") f.call(p);
        },
    };
}
