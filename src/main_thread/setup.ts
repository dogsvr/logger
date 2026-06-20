import pino, {type Logger as PinoLogger, type LoggerOptions} from "pino";
import {registerLogger, getSpanSink} from "@dogsvr/dogsvr/main_thread";
import {defaultBase, wrapPino, traceContextMixin} from "../common/pino_adapter";
import {installShutdownHooks} from "../common/shutdown";
import type {SetupOptions} from "../common/options";
import type {MainStrategy} from "../common/strategies/strategy";
import {InlineMainStrategy} from "../common/strategies/inline_main";
import {CentralMainStrategy} from "../common/strategies/central_main";
import {makeHub} from "./pino_hub";

let setupCalled = false;

function buildPinoOptions(opts: SetupOptions): LoggerOptions {
    return {
        level: opts.level,
        base: {...defaultBase(), ...(opts.base ?? {})},
        timestamp: pino.stdTimeFunctions.epochTime,
        mixin: traceContextMixin(getSpanSink),
    };
}

/** Initialise the pino backend and register it with `@dogsvr/dogsvr` on the main thread. */
export function setupLogger(opts: SetupOptions): void {
    if (setupCalled) {
        throw new Error("setupLogger already called");
    }
    setupCalled = true;

    if (opts.otel && opts.mode !== "central") {
        throw new Error(`otel option requires mode="central", got mode="${opts.mode}"`);
    }

    let strategy: MainStrategy;
    switch (opts.mode) {
        case "inline":
            strategy = new InlineMainStrategy(opts);
            break;
        case "central":
            strategy = new CentralMainStrategy(opts);
            break;
        default:
            throw new Error(`unknown mode: ${(opts as {mode: string}).mode}`);
    }

    const p: PinoLogger = pino(buildPinoOptions(opts), strategy.mainDestination());
    registerLogger(wrapPino(p), makeHub(strategy));
    installShutdownHooks(strategy);
}

/**
 * Sugar over setupLogger that pins mode=central and forwards otel options.
 */
export function setupLoggerWithOtel(
    opts: Omit<SetupOptions, "mode" | "otel"> & {otel: NonNullable<SetupOptions["otel"]>},
): void {
    setupLogger({...opts, mode: "central"});
}

