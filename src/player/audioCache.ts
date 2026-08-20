/**
 * LRU cache for synthesized audio, bounded by BOTH entry count and total bytes.
 * Replaces the previous count-only FIFO cap: audio chunks vary wildly in size
 * (a WAV sentence can be megabytes), so a byte budget is what actually bounds
 * extension-host memory over a long session.
 */
export class AudioCache {
  private entries = new Map<string, ArrayBuffer>();
  private bytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number
  ) {}

  get totalBytes(): number {
    return this.bytes;
  }

  get(key: string): ArrayBuffer | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // refresh recency: Map preserves insertion order, oldest = first key
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: ArrayBuffer): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.entries.delete(key);
      this.bytes -= existing.byteLength;
    }
    if (value.byteLength > this.maxBytes) return; // would evict everything and still not fit
    this.entries.set(key, value);
    this.bytes += value.byteLength;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.entries.get(oldest)!.byteLength;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}
