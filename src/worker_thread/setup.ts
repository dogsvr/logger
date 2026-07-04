import pino, {type Logger as PinoLogger, type LoggerOptions} from "pino";
import {registerWorkerLogger, getSpanSink, onShutdown} from "@dogsvr/dogsvr/worker_thread";
import {defaultBase, wrapPino, traceContextMixin} from "../common/pino_adapter";
import type {WorkerSetupOptions} from "../common/options";
import type {WorkerStrategy} from "../strategies/strategy";
import {InlineWorkerStrategy} from "../strategies/inline/worker";
import {CentralWorkerStrategy} from "../strategies/central/worker";

let setupCalled = false;

function buildPinoOptions(opts: WorkerSetupOptions): LoggerOptions {
    return {
        level: opts.level,
        base: {...defaultBase(), ...(opts.base ?? {})},
        timestamp: pino.stdTimeFunctions.epochTime,
        mixin: traceContextMixin(getSpanSink),
    };
}

/** Initialise pino + register with dogsvr. Must be called once per worker_thread. */
export function setupLoggerInWorker(opts: WorkerSetupOptions): void {
    if (setupCalled) {
        throw new Error("setupLoggerInWorker already called");
    }
    setupCalled = true;

    if (opts.mode === "inline" && opts.port !== undefined) {
        process.emitWarning(
            "inline mode received port; ignoring (port is for central mode only)",
            "DogsvrLoggerWarning",
        );
    }

    let strategy: WorkerStrategy;
    switch (opts.mode) {
        case "inline":
            strategy = new InlineWorkerStrategy(opts);
            break;
        case "central":
            strategy = new CentralWorkerStrategy(opts);
            break;
        default:
            throw new Error(`unknown mode: ${(opts as {mode: string}).mode}`);
    }

    const p: PinoLogger = pino(buildPinoOptions(opts), strategy.workerDestination());
    registerWorkerLogger(wrapPino(p));
    onShutdown(() => strategy.shutdown());
}
