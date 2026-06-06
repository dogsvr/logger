type Flushable = {flush: () => void};

let installed = false;

export function installShutdownHooks(target: Flushable): void {
    if (installed) return;
    installed = true;
    const flush = () => {
        try { target.flush(); } catch { /* ignore */ }
    };
    process.once("beforeExit", flush);
    process.once("SIGINT", () => { flush(); process.exit(130); });
    process.once("SIGTERM", () => { flush(); process.exit(143); });
}

/** Internal: reset for tests. */
export function _resetShutdownHooksForTest(): void {
    installed = false;
}
