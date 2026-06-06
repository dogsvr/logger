# @dogsvr/logger

High-performance NDJSON logger for the `@dogsvr/*` ecosystem, built on [pino](https://github.com/pinojs/pino). It is the default implementation of the logger interface defined by [`@dogsvr/dogsvr`](https://github.com/dogsvr/dogsvr); two operating modes — `inline` for bare-metal/PM2 throughput and `central` for K8s-friendly single-writer stdout — selectable per process.

## Install

```sh
npm install @dogsvr/logger
```

`@dogsvr/dogsvr` is a peer dependency — install it alongside.

## Quick start

`@dogsvr/dogsvr` exposes the `log` proxy and the registration slot; `@dogsvr/logger` is the implementation that plugs in. Call `setupLogger()` once on the main thread (and `setupLoggerInWorker()` once per worker_thread) before any `log.*` call:

```ts
// main.ts
import {setupLogger} from "@dogsvr/logger/main_thread";
import {log} from "@dogsvr/dogsvr/main_thread";

setupLogger({mode: "central", level: "info", base: {svrId: "zonesvr-1"}});
// dogsvr.startServer(cfg) automatically picks up the registered logger and
// propagates per-worker init via workerData.loggerInit — no extra wiring.

log.info("server started");
log.info({userId: 42}, "user joined");
log.error({err: new Error("boom"), txnId: 99}, "transaction failed");
```

```ts
// worker.ts (any business worker_thread)
import {workerData} from "node:worker_threads";
import {setupLoggerInWorker, type WorkerInitPayload} from "@dogsvr/logger/worker_thread";
import {log} from "@dogsvr/dogsvr/worker_thread";

const init = (workerData as {loggerInit?: WorkerInitPayload}).loggerInit!;
setupLoggerInWorker({
    ...init,                         // mode + port (central) or destination (inline)
    level: "info",
    base: {role: "worker"},
});

log.info("worker ready");
```

If you don't use worker_threads, omit the worker step — `setupLogger()` alone is enough.

Output (NDJSON, one JSON object per line):

```
{"level":30,"time":"2026-05-31T10:23:45.123Z","pid":12345,"hostname":"box1","thread":"main","svrId":"zonesvr-1","msg":"server started"}
{"level":30,"time":"2026-05-31T10:23:45.456Z","pid":12345,"hostname":"box1","thread":"main","svrId":"zonesvr-1","userId":42,"msg":"user joined"}
{"level":50,"time":"2026-05-31T10:23:45.789Z","pid":12345,"hostname":"box1","thread":"main","svrId":"zonesvr-1","err":{"type":"Error","message":"boom","stack":"Error: boom\n    at ..."},"txnId":99,"msg":"transaction failed"}
```

## Package layout

The package exposes two subpaths and no root export, mirroring `@dogsvr/dogsvr`. Importing `@dogsvr/logger` directly throws `ERR_PACKAGE_PATH_NOT_EXPORTED` — pick the side that matches the thread:

- `@dogsvr/logger/main_thread` — `setupLogger`, `SetupOptions`, `Mode`
- `@dogsvr/logger/worker_thread` — `setupLoggerInWorker`, `WorkerSetupOptions`, `WorkerInitPayload`, `Mode`

The `log` proxy itself lives in `@dogsvr/dogsvr/{main,worker}_thread`, since dogsvr owns the logger interface (`Log`, `LoggerImpl`, `LoggerHub`, `Level`).

## Mode selection

Two modes ship in this package. They differ in **where the destination fd is owned and written**:

| Mode | Where pino writes | Threads | Pick when |
|---|---|---|---|
| `inline` | each business thread owns its own sonic-boom; writes the destination fd directly | N+1 isolates (no extra) | bare-metal / PM2 — max throughput; pair with file destination for safe O_APPEND |
| `central` | a dedicated central isolate owns the destination fd; every business thread sends NDJSON lines to it via MessagePort | N+2 isolates (+1 for central, ~10-15 MB RSS) | K8s, or any deployment that wants 12-Factor stdout — single-writer eliminates >4KB pipe interleaving; broadest compat |

When in doubt, pick `central`: the only cost is one extra isolate.

## Destination orthogonality

The `destination` option is **independent of mode**. Both modes accept either an fd number (default `1` = stdout) or a file path:

| Combination | fd type | writers | >4KB risk | Use |
|---|---|---|---|---|
| inline + stdout (fd=1) | pipe | N+1 | ⚠️ pipe atomicity is only 4KB | local dev / TTY only |
| **inline + file path** | regular file + O_APPEND | N+1 | ✅ kernel guarantees full-size atomic on Linux | bare-metal best |
| **central + stdout (fd=1)** | pipe | 1 | ✅ single writer, no concurrency | K8s best |
| central + file path | regular file + O_APPEND | 1 | ✅ double safeguard | central + extra durability |

Example (bare-metal, file destination):

```ts
setupLogger({mode: "inline", level: "info", destination: "/var/log/myapp/app.log"});
```

Example (K8s, default stdout):

```ts
setupLogger({mode: "central", level: "info"});
```

When writing to a file, point `pm2-logrotate` (or any external rotation tool) at that file. PM2's stdout capture remains useful for crash dumps and stray `console.log`.

## Module context

For each `.ts` file, derive a child logger labelled with the module path. `log` comes from dogsvr (since dogsvr owns the logger interface), not from this package:

```ts
import {log as rootLog} from "@dogsvr/dogsvr/main_thread";   // or /worker_thread
const log = rootLog.child({module: "zonesvr/cmd_handler"});

log.info("handler ready");  // → {"module":"zonesvr/cmd_handler","msg":"handler ready",...}
```

`child()` is a one-time ~1µs cost per module; subsequent log calls have zero extra overhead.

## Error logging

Always pass `Error` instances under the `err` key. Pino's built-in `err` serializer expands `err.stack` (file, line, function name) into the output:

```ts
try {
  doWork();
} catch (e) {
  log.error({err: e, gid}, "doWork failed");
}
```

## Custom logger impl

This package is one implementation of the `LoggerImpl` interface that `@dogsvr/dogsvr` consumes. To plug in a different backend (winston, bunyan, an in-memory test double), import `registerLogger` / `registerWorkerLogger` from `@dogsvr/dogsvr` and call them yourself instead of installing this package. See the `@dogsvr/dogsvr` README's "Custom logger" section for details.

## Architecture

### Inline mode

```
┌──────────────────────────────────────────────────────────────────┐
│  Process (PM2 fork / K8s container)                              │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐    ┌──────────────┐           │
│  │ main thread │  │ worker_thread│ .. │ worker_thread│           │
│  │  pino       │  │  pino        │    │  pino        │           │
│  │   ↓         │  │   ↓          │    │   ↓          │           │
│  │  sonic-boom │  │  sonic-boom  │    │  sonic-boom  │           │
│  │   ↓         │  │   ↓          │    │   ↓          │           │
│  │  fs.write   │  │  fs.write    │    │  fs.write    │           │
│  └──────│──────┘  └──────│───────┘    └──────│───────┘           │
│         │                │                    │                  │
│         └────────────────┴───────┬────────────┘                  │
│                                  ▼                               │
└──────────────────────────────────┼───────────────────────────────┘
                                   │ (N+1 writers)
                                   ▼
                        destination fd (file with O_APPEND, or stdout)
```

N+1 isolates total. Atomicity at >4KB requires a regular file with O_APPEND (see Destination orthogonality).

### Central mode

```
┌──────────────────────────────────────────────────────────────────────┐
│  Process                                                             │
│                                                                      │
│  ┌─────────────┐  ┌──────────────┐    ┌──────────────┐               │
│  │ main thread │  │ worker_thread│ .. │ worker_thread│               │
│  │  pino       │  │  pino        │    │  pino        │               │
│  │   ↓         │  │   ↓          │    │   ↓          │               │
│  │  port.send  │  │  port.send   │    │  port.send   │               │
│  └──────│──────┘  └──────│───────┘    └──────│───────┘               │
│         │                │                    │                      │
│         └────────────────┴─────┬──────────────┘ MessagePort × (N+1)  │
│                                ▼                                     │
│                     ┌─────────────────────┐                          │
│                     │ central isolate     │                          │
│                     │  attached ports → write line                   │
│                     │  sonic-boom (1 writer)                         │
│                     │  back-pressure: drop low-level on high-water  │
│                     │  SPOF degradation: stderr fallback             │
│                     └──────────┬──────────┘                          │
│                                │                                     │
└────────────────────────────────┼─────────────────────────────────────┘
                                 │ (1 writer)
                                 ▼
                        destination fd (stdout pipe, or file)
```

N+2 isolates total. Single writer eliminates pipe interleaving regardless of line size. The MessagePort hop adds ~3-10 μs per line; sonic-boom drains its buffer asynchronously via libuv pool, so `fs.write` never blocks the business event loop in either mode.

## PM2 notes

When running under PM2 in fork mode, set `time: false` on each app so PM2 doesn't prepend its own timestamp and corrupt the JSON line:

```js
// ecosystem.config.js
module.exports = {
  apps: [{
    name: "zonesvr",
    script: "dist/zonesvr/main.js",
    exec_mode: "fork",
    time: false,
  }]
};
```

`mode` / `level` / `destination` are passed to `setupLogger()` directly by the application — typically read from a JSON config file or hard-coded in the entry. PM2 env vars are not involved.

Use `pm2-logrotate` for rotation if you write to files (inline + file destination):

```sh
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 14
```

## Optional: build-time call-site injection

Pino does not capture file/line/function at log time, and runtime stack inspection (e.g., `pino-caller`) drops throughput by ~90%. The performance-compatible alternative is a TypeScript transformer that bakes call-site metadata in at build time — `ts-patch` + [`@bitpatty/ts-transformer-log-position`](https://github.com/bitpatty/ts-transformer-log-position) is a known-working stack. This package does not ship integration; downstream packages that opt in should verify `declarationMap`, `rootDir`, and cross-package `npm link` behaviour under the patched compiler before adopting. The framework packages `@dogsvr/logger` and `@dogsvr/dogsvr` are built with stock `tsc`.

## Role in dogsvr

`@dogsvr/dogsvr` owns the logger contract — `log`, `LoggerImpl`, `LoggerHub`, `Level` — but ships only a console-based fallback. `@dogsvr/logger` is the recommended pino-based implementation that registers itself when business code calls `setupLogger()` / `setupLoggerInWorker()`. Other connection-layer packages (`@dogsvr/cl-tsrpc`, `@dogsvr/cl-grpc`) and downstream business code import `log` from `@dogsvr/dogsvr`, never from here, so swapping the implementation is a one-package change.

## See also

- [`@dogsvr/dogsvr`](https://github.com/dogsvr/dogsvr) — main/worker thread game server framework.
- [`@dogsvr/cl-tsrpc`](https://github.com/dogsvr/cl-tsrpc) / [`@dogsvr/cl-grpc`](https://github.com/dogsvr/cl-grpc) — connection layers.

## Compatibility

Tested on Node.js v24.13.0 on Linux (x86-64); other maintained LTS lines expected to work but not routinely exercised.

## Appendix: Concurrency safety internals

Why concurrent writes are not a problem here. Two questions tend to come up; both turn out to be non-issues, but for very different reasons.

**Q1: Inside one isolate, does sonic-boom itself race against multiple `fs.write` calls on the same fd?**

No. Each sonic-boom instance is a **single producer** for its destination fd, enforced by an internal `_writing` flag. Verified against `sonic-boom@4.2.1` (`node_modules/sonic-boom/index.js`):

- Every `sonic.write(line)` call only appends to an in-memory JS buffer (`_bufs`). New writes that arrive while `_writing` is true are buffered, not dispatched (`writeUtf8` line 332, `writeBuffer` line 366):

  ```js
  if (!this._writing && this._len >= this.minLength) {
    this._actualWrite()
  }
  ```

- The async `fs.write` is issued from exactly one place (line 140):

  ```js
  fsWrite = () => fs.write(this.fd, this._writingBuf, this.release)
  ```

- `this.release` is the kernel callback (line 175). It processes the result, then either continues writing the remaining bytes of the current chunk, schedules the next chunk if one is buffered, or clears `_writing = false` (lines 206, 234, 244). Only after `_writing` is cleared can the next write be dispatched.

So at any moment **exactly one `fs.write` is in flight per sonic-boom instance**. libuv assigns that one request to one of its worker threads (default 4, configurable via `UV_THREADPOOL_SIZE`); even though the pool has multiple threads, sonic-boom never hands it more than one job at a time, so there is no opportunity for two `write(2)` syscalls to run in parallel on the same fd.

This is why central mode's "single writer" guarantee holds even when N+1 business threads send lines concurrently: every line funnels through the central isolate's one sonic-boom, which serializes them by construction.

**Q2: When PM2 runs multiple apps (e.g. `dir`, `zonesvr`, `battlesvr`), do they fight for the same stdout?**

No — but the reason is more specific than "fork isolation". Important precision: a POSIX `fork(2)` system call does **share** the parent's fd table with the child (same file descriptions, same offsets, same `O_APPEND` flag). Node.js `child_process.fork` is **not** a POSIX fork; it is a specialized form of `child_process.spawn`, and what matters here is the `stdio` option PM2 picks when spawning each app.

PM2 spawns every app with `stdio: 'pipe'`, which creates **a fresh pipe per spawn**. Each app's child process receives the *write* end of its own pipe as `fd=1`; the PM2 daemon holds the *read* end. So three apps means three completely independent pipes:

```
exp-dir       (PID A) ──pipe A (write end is its fd=1)──▶ PM2 daemon ──▶ ~/.pm2/logs/exp-dir-out.log
exp-zonesvr   (PID B) ──pipe B (write end is its fd=1)──▶ PM2 daemon ──▶ ~/.pm2/logs/exp-zonesvr-out.log
exp-battlesvr (PID C) ──pipe C (write end is its fd=1)──▶ PM2 daemon ──▶ ~/.pm2/logs/exp-battlesvr-out.log
```

Concrete mechanics:

- The daemon (single-threaded) reads each pipe independently and writes the bytes to a **per-app** `out_file`.
- `merge_logs` is `false` by default in both fork and cluster modes, so even multiple instances of the same app keep separate `out_file`s (named with `${PM2_ID}` placeholders).

Therefore inline mode + default stdout: writers per app = N+1 (>4KB pipe interleaving still possible **within one app**, addressed by switching to a file destination — see Destination orthogonality). Central mode + default stdout: writers per app = 1, and apps are isolated, so no concurrency at any layer.

The same isolation applies to K8s Deployment replicas (each pod gets its own host log file via kubelet). Cases where shared-fd concurrency *does* arise:

- Node `cluster` module spawning workers with `stdio: 'inherit'` — every worker shares the master's `fd=1` file description, so multiple workers writing stdout fall under PIPE_BUF=4KB pipe atomicity.
- A user manually spawning with `stdio: ['ignore', 1, 2]` — same shared-fd outcome.
- Multiple apps deliberately pointing `destination` at one shared file (`/shared/path/all.log`).

In all of those, Linux's O_APPEND on regular files (sonic-boom opens files with `flags = 'a'`, see `index.js` line 75) jointly with the daemon's serialized read-write loop guarantee atomicity for full-size writes. PM2 fork mode with default `stdio: 'pipe'` is *not* one of these cases.
