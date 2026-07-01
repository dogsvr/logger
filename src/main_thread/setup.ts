import pino, {type Logger as PinoLogger, type LoggerOptions} from "pino";
import {registerLogger, getSpanSink, onShutdown} from "@dogsvr/dogsvr/main_thread";
import {defaultBase, wrapPino, traceContextMixin} from "../common/pino_adapter";
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

/** Initialise pino + register with `@dogsvr/dogsvr`. Must be called once on the main thread. */
export function setupLogger(opts: SetupOptions): void {
    if (setupCalled) {
        throw new Error("setupLogger already called");
    }
    setupCalled = true;

    if (opts.otel?.enabled) {
        if (opts.mode !== "central") {
            throw new Error(`otel.enabled requires mode="central", got mode="${opts.mode}"`);
        }
        if (!opts.otel.otlpEndpoint || !opts.otel.serviceName) {
            throw new Error(`otel.enabled=true requires otel.otlpEndpoint and otel.serviceName`);
        }
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
    onShutdown(() => strategy.shutdown());
}

