import type {DestinationStream} from "pino";
import type {MessagePort} from "worker_threads";
import type {LogFallbackOnFull} from "../../common/options";
import type {SabDropReportMsg} from "./protocol";
import {SabLineWriter} from "@dogsvr/dogsvr/common";
import {extractLevel} from "./pino_level";

export const DEFAULT_LOG_SAB_DATA_BYTES = 4 * 1024 * 1024;

const DROP_REPORT_INTERVAL_MS = 1000;
const WARN_LEVEL = 40;

export interface SabLogWriterOpts {
    sab: SharedArrayBuffer;
    producerId: string;
    fallbackPort: MessagePort;
    fallbackOnFull: LogFallbackOnFull;
}

export class SabLogWriter implements DestinationStream {
    private line: SabLineWriter;
    private producerId: string;
    private fallbackPort: MessagePort;
    private fallbackOnFull: LogFallbackOnFull;
    private droppedByLevel = new Map<number, number>();
    private dropTimer: NodeJS.Timeout | null = null;

    constructor(opts: SabLogWriterOpts) {
        this.line = new SabLineWriter(opts.sab);
        this.producerId = opts.producerId;
        this.fallbackPort = opts.fallbackPort;
        this.fallbackOnFull = opts.fallbackOnFull;
        this.startDropReporter();
    }

    write(line: string): void {
        // pino hands us a string only; parsing level here lets the consumer filter
        // before decoding anything.
        const level = extractLevel(line);
        if (this.line.tryWrite(line, level)) return;
        this.onFull(line, level);
    }

    private onFull(line: string, level: number): void {
        if (this.fallbackOnFull === "warn+" && level >= WARN_LEVEL) {
            try { this.fallbackPort.postMessage(line); } catch { /* ignore */ }
            return;
        }
        this.droppedByLevel.set(level, (this.droppedByLevel.get(level) ?? 0) + 1);
    }

    private startDropReporter(): void {
        this.dropTimer = setInterval(() => this.reportDrops(), DROP_REPORT_INTERVAL_MS);
        this.dropTimer.unref();
    }

    private reportDrops(): void {
        if (this.droppedByLevel.size === 0) return;
        const byLevel: Record<number, number> = {};
        for (const [lv, cnt] of this.droppedByLevel) byLevel[lv] = cnt;
        this.droppedByLevel.clear();
        try {
            this.fallbackPort.postMessage({
                type: "sabDropReport",
                producerId: this.producerId,
                byLevel,
            } satisfies SabDropReportMsg);
        } catch { /* ignore */ }
    }

    stop(): void {
        if (this.dropTimer) { clearInterval(this.dropTimer); this.dropTimer = null; }
        this.reportDrops();
    }
}
