/** Extract pino `level` number from an NDJSON line head; scan first 64 bytes only. Defaults to 30 (INFO). */
export function extractLevel(line: string): number {
    const idx = line.indexOf("\"level\":");
    if (idx < 0 || idx > 64) return 30;
    const start = idx + 8;
    let end = start;
    while (end < line.length && line.charCodeAt(end) >= 0x30 && line.charCodeAt(end) <= 0x39) end++;
    if (end === start) return 30;
    return Number(line.slice(start, end));
}
