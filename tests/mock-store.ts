// In-memory stand-in for a Netlify Blobs store: etags, onlyIfMatch / onlyIfNew, and async jitter
// so concurrent requests genuinely interleave between read and write.
export class MockStore {
  data = new Map<string, { value: string; etag: string }>();
  seq = 0;
  reads = 0;
  writes = 0;
  conflicts = 0;
  jitter: number;
  constructor(jitter = 3) { this.jitter = jitter; }
  private wait() { return new Promise((r) => setTimeout(r, Math.floor(Math.random() * this.jitter))); }
  async getWithMetadata(key: string, _opts: { type: "json"; consistency?: string }) {
    this.reads++;
    await this.wait();
    const e = this.data.get(key);
    return e ? { data: JSON.parse(e.value), etag: e.etag } : null;
  }
  async setJSON(key: string, value: unknown, opts: { onlyIfMatch?: string; onlyIfNew?: boolean } = {}) {
    await this.wait();
    const cur = this.data.get(key);
    if (opts.onlyIfNew && cur) { this.conflicts++; return { modified: false }; }
    if (opts.onlyIfMatch !== undefined && (!cur || cur.etag !== opts.onlyIfMatch)) { this.conflicts++; return { modified: false }; }
    const etag = `"e${++this.seq}"`;
    this.data.set(key, { value: JSON.stringify(value), etag });
    this.writes++;
    return { modified: true, etag };
  }
  room(code: string) { return JSON.parse(this.data.get(`room-${code}`)!.value); }
}
