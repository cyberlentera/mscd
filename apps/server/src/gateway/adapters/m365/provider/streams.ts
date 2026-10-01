// Stream helpers of the provider adapters (D.5, TS 5.3, WP-15). Pass-through uploads run through the gateway's
// `ContentMeter` (SHA-256, size limit, first 4 KiB for type detection) and are cut into fragments in memory: no
// temporary file is written and at most one fragment is held. Downloads keep their first 4 KiB back until the type
// is detected, then replay them ahead of the rest.
import { Readable } from 'node:stream';
import { DETECTION_BYTES, detectFileType } from '../../../file-type';
import { ContentMeter } from '../../../streams';

/** Reads exact byte counts from an async iterator of chunks. */
export class ByteReader {
  private parts: Buffer[] = [];
  private length = 0;
  private ended = false;

  constructor(private readonly iterator: AsyncIterator<unknown>) {}

  /** Up to `count` bytes; fewer only when the source ended. */
  async read(count: number): Promise<Buffer> {
    while (this.length < count && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      const value = next.value;
      const chunk = Buffer.isBuffer(value) ? value : typeof value === 'string' ? Buffer.from(value) : Buffer.from(value as Uint8Array);
      if (chunk.length === 0) continue;
      this.parts.push(chunk);
      this.length += chunk.length;
    }
    const all = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts, this.length);
    const out = all.subarray(0, count);
    const rest = all.subarray(out.length);
    this.parts = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
    return out;
  }

  /** Puts bytes back in front of what is still to be read. */
  unshift(bytes: Buffer): void {
    if (bytes.length === 0) return;
    this.parts.unshift(bytes);
    this.length += bytes.length;
  }

  /** True when the source ended and every byte was read. */
  get done(): boolean {
    return this.ended && this.length === 0;
  }
}

/** An upload body metered while it is read. */
export interface MeteredUpload {
  meter: ContentMeter;
  reader: ByteReader;
  /** Stops reading after a failure: the request body and the meter are destroyed. */
  abort(): void;
}

export function meterUpload(body: Readable, maxBytes: number): MeteredUpload {
  const meter = new ContentMeter(maxBytes);
  body.once('error', (error) => meter.destroy(error));
  body.pipe(meter);
  return {
    meter,
    reader: new ByteReader(meter[Symbol.asyncIterator]()),
    abort() {
      body.unpipe(meter);
      body.destroy();
      meter.destroy();
    },
  };
}

/** A stream whose first bytes were read for the type detection and are replayed ahead of the rest. */
export async function detectAndReplay(source: Readable): Promise<{ stream: Readable; detectedType: string }> {
  const iterator = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const parts: Buffer[] = [];
  let length = 0;
  let ended = false;
  try {
    while (length < DETECTION_BYTES) {
      const next = await iterator.next();
      if (next.done) {
        ended = true;
        break;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      parts.push(chunk);
      length += chunk.length;
    }
  } catch (error) {
    source.destroy();
    throw error;
  }
  const head = Buffer.concat(parts, length);
  async function* replay(): AsyncGenerator<Buffer> {
    try {
      if (head.length > 0) yield head;
      if (ended) return;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      }
    } finally {
      source.destroy();
    }
  }
  return { stream: Readable.from(replay(), { objectMode: false }), detectedType: detectFileType(head) };
}
