import {SabLineReader} from "@dogsvr/dogsvr/common";

export type OnLineFn = (line: string) => void;

export class SabLogReader {
    private line: SabLineReader;

    constructor(sab: SharedArrayBuffer, onLine: OnLineFn) {
        this.line = new SabLineReader(sab, onLine);
    }

    start(): void {
        this.line.start();
    }

    stop(): void {
        this.line.stop();
    }

    drainSync(): void {
        this.line.drainSync();
    }
}
