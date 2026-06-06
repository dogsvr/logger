import type {LoggerHub} from "@dogsvr/dogsvr/main_thread";
import type {MainStrategy} from "../common/strategies/strategy";

/**
 * Wrap a MainStrategy into the LoggerHub shape expected by dogsvr.
 */
export function makeHub(strategy: MainStrategy): LoggerHub {
    return {
        issueWorkerPort: () => strategy.issueWorkerPort(),
        releaseWorkerPort: (w) => strategy.releaseWorkerPort(w),
        workerInitFor: (p) => strategy.workerInitFor(p),
        bufferedBytes: () => strategy.bufferedBytes(),
        flush: () => strategy.flush(),
    };
}
