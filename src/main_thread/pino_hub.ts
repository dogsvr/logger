import type {LoggerHub} from "@dogsvr/dogsvr/main_thread";
import type {MainStrategy} from "../strategies/strategy";
import {CentralMainStrategy} from "../strategies/central/main";

export function makeHub(strategy: MainStrategy): LoggerHub {
    return {
        issueWorkerPort: () => strategy.issueWorkerPort(),
        releaseWorkerPort: (w) => strategy.releaseWorkerPort(w),
        workerInitFor: (p) => strategy.workerInitFor(p),
        bufferedBytes: () => strategy.bufferedBytes(),
        flush: () => strategy.flush(),
        flushAwaitable: strategy instanceof CentralMainStrategy
            ? () => strategy.flushAwaitable()
            : undefined,
    };
}
