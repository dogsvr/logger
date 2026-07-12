import {
    FRAME_LEN_BYTES,
    SEQ_INDEX,
    commitRead,
    openSab,
    readState,
    type SabView,
} from "./sab_shared";

export type OnLineFn = (line: string) => void;

interface WaitAsyncResult {
    async: boolean;
    value: "ok" | "not-equal" | "timed-out" | Promise<"ok" | "not-equal" | "timed-out">;
}

interface AtomicsAsync {
    waitAsync?: (typedArray: Int32Array, index: number, value: number) => WaitAsyncResult;
}

const asyncApi = Atomics as unknown as AtomicsAsync;

export class SabLogReader {
    private view: SabView;
    private producerId: string;
    private onLine: OnLineFn;
    private stopped = false;
    private waiter: Promise<"ok" | "not-equal" | "timed-out"> | null = null;

    constructor(sab: SharedArrayBuffer, producerId: string, onLine: OnLineFn) {
        this.view = openSab(sab);
        this.producerId = producerId;
        this.onLine = onLine;
    }

    getProducerId(): string {
        return this.producerId;
    }

    start(): void {
        this.stopped = false;
        this.loop();
    }

    stop(): void {
        this.stopped = true;
    }

    /** Best-effort synchronous drain of everything currently visible. */
    drainSync(): void {
        this.pumpOnce();
    }

    private loop(): void {
        if (this.stopped) return;
        const hadData = this.pumpOnce();
        if (this.stopped) return;
        if (hadData) {
            setImmediate(() => this.loop());
            return;
        }
        this.waitForData();
    }

    private waitForData(): void {
        if (this.stopped) return;
        const {state} = this.view;
        const seq = Atomics.load(state, SEQ_INDEX);
        const {write, read} = readState(state);
        if (write !== read) {
            setImmediate(() => this.loop());
            return;
        }
        if (!asyncApi.waitAsync) {
            setImmediate(() => this.loop());
            return;
        }
        const res = asyncApi.waitAsync(state, SEQ_INDEX, seq);
        if (!res.async) {
            setImmediate(() => this.loop());
            return;
        }
        this.waiter = res.value as Promise<"ok" | "not-equal" | "timed-out">;
        this.waiter.then(() => {
            this.waiter = null;
            if (!this.stopped) this.loop();
        });
    }

    private pumpOnce(): boolean {
        const {state, data} = this.view;
        const {write, read} = readState(state);
        if (write === read) return false;

        let cursor = read;
        const end = write;
        while (cursor < end) {
            if (end - cursor < FRAME_LEN_BYTES) break;
            const view = new DataView(data.buffer, data.byteOffset + cursor, FRAME_LEN_BYTES);
            const bodyLen = view.getUint32(0, true);
            if (bodyLen === 0 || cursor + FRAME_LEN_BYTES + bodyLen > end) break;
            const bodyStart = cursor + FRAME_LEN_BYTES;
            const buf = Buffer.from(data.buffer, data.byteOffset + bodyStart, bodyLen);
            let line: string;
            try { line = buf.toString("utf8"); } catch { line = ""; }
            if (line.length > 0) {
                try { this.onLine(line); } catch { /* isolate central onLine already swallows */ }
            }
            cursor = bodyStart + bodyLen;
        }
        if (cursor > read) commitRead(state, cursor);
        return cursor > read;
    }
}
