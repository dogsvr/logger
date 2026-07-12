import type {DestinationStream} from "pino";
import type {MessagePort} from "worker_threads";
import type {LogFallbackOnFull} from "../../common/options";
import type {SabDropReportMsg} from "./protocol";
import {
    FRAME_LEN_BYTES,
    READ_INDEX,
    WRITE_INDEX,
    commitWrite,
    openSab,
    readState,
    resetIndexes,
    type SabView,
} from "./sab_shared";

const SCRATCH_BYTES = 64 * 1024;
const DROP_REPORT_INTERVAL_MS = 1000;
const WARN_LEVEL = 40;

function extractLevel(line: string): number {
    const idx = line.indexOf("\"level\":");
    if (idx < 0 || idx > 64) return 30;
    const start = idx + 8;
    let end = start;
    while (end < line.length && line.charCodeAt(end) >= 0x30 && line.charCodeAt(end) <= 0x39) end++;
    if (end === start) return 30;
    return Number(line.slice(start, end));
}

export interface SabLogWriterOpts {
    sab: SharedArrayBuffer;
    producerId: string;
    fallbackPort: MessagePort;
    fallbackOnFull: LogFallbackOnFull;
}

export class SabLogWriter implements DestinationStream {
    private view: SabView;
    private scratch: Buffer;
    private producerId: string;
    private fallbackPort: MessagePort;
    private fallbackOnFull: LogFallbackOnFull;
    private droppedByLevel = new Map<number, number>();
    private dropTimer: NodeJS.Timeout | null = null;

    constructor(opts: SabLogWriterOpts) {
        this.view = openSab(opts.sab);
        this.scratch = Buffer.allocUnsafe(SCRATCH_BYTES);
        this.producerId = opts.producerId;
        this.fallbackPort = opts.fallbackPort;
        this.fallbackOnFull = opts.fallbackOnFull;
        this.startDropReporter();
    }

    write(line: string): void {
        const maxBytes = Math.min(SCRATCH_BYTES, this.view.dataBytes - FRAME_LEN_BYTES);
        const bodyLen = this.scratch.write(line, 0, maxBytes, "utf8");
        if (bodyLen <= 0) return;
        const frameLen = FRAME_LEN_BYTES + bodyLen;

        if (this.tryWriteFrame(frameLen, bodyLen)) return;
        this.onFull(line, bodyLen);
    }

    private tryWriteFrame(frameLen: number, bodyLen: number): boolean {
        const {state, data, dataBytes} = this.view;
        let {write, read} = readState(state);

        if (write === read && write !== 0) {
            resetIndexes(state);
            write = 0;
            read = 0;
        }

        if (write >= read) {
            if (dataBytes - write < frameLen) return false;
        } else {
            if (read - write - 1 < frameLen) return false;
        }

        const view = new DataView(data.buffer, data.byteOffset + write, FRAME_LEN_BYTES);
        view.setUint32(0, bodyLen, true);
        data.set(this.scratch.subarray(0, bodyLen), write + FRAME_LEN_BYTES);
        commitWrite(state, write + frameLen);
        return true;
    }

    private onFull(line: string, _bodyLen: number): void {
        const level = extractLevel(line);
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

    signalWriterEnd(): void {
        Atomics.notify(this.view.state, 0);
    }

    readerCaughtUp(): boolean {
        const {state} = this.view;
        return Atomics.load(state, WRITE_INDEX) === Atomics.load(state, READ_INDEX);
    }
}
