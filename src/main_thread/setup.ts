import pino, {type Logger as PinoLogger, type LoggerOptions} from "pino";
import {registerLogger} from "@dogsvr/dogsvr/main_thread";
import {defaultBase} from "../common/thread_identity";
import {wrapPino} from "../common/pino_impl";
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
        timestamp: pino.stdTimeFunctions.isoTime,
    };
}

/** Initialise the pino backend and register it with `@dogsvr/dogsvr` on the main thread. */
export function setupLogger(opts: SetupOptions): void {
    if (setupCalled) {
        throw new Error("setupLogger already called");
    }
    setupCalled = true;

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
