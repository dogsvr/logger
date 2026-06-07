import pino, {type Logger as PinoLogger, type LoggerOptions} from "pino";
import {registerWorkerLogger} from "@dogsvr/dogsvr/worker_thread";
import {defaultBase, wrapPino} from "../common/pino_adapter";
import {installShutdownHooks} from "../common/shutdown";
import type {WorkerSetupOptions} from "../common/options";
import type {WorkerStrategy} from "../common/strategies/strategy";
import {InlineWorkerStrategy} from "../common/strategies/inline_worker";
import {CentralWorkerStrategy} from "../common/strategies/central_worker";

let setupCalled = false;

function buildPinoOptions(opts: WorkerSetupOptions): LoggerOptions {
    return {
        level: opts.level,
        base: {...defaultBase(), ...(opts.base ?? {})},
        timestamp: pino.stdTimeFunctions.epochTime,
    };
}

/** Initialise the pino backend inside a worker_thread and register it with dogsvr. */
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
    installShutdownHooks(strategy);
}
