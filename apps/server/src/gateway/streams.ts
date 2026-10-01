// Stream helpers of the storage gateway (build plan D.5): every uploaded byte passes through a meter that computes
// the SHA-256 of the plaintext, counts bytes against the upload's `maxBytes` and keeps the first 4 KiB for the file
// type detection. No temporary file is written. The pass-through adapters (WP-15) use the same meter.
import { createHash, type Hash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { DETECTION_BYTES, detectFileType } from './file-type';
import { tooLarge } from './problems';

/** Hash, size and head of a stream, filled while the bytes pass. */
export class ContentMeter extends Transform {
  private readonly hash: Hash = createHash('sha256');
  private readonly headParts: Buffer[] = [];
  private headLength = 0;
  private total = 0;
  private digest: string | null = null;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.total += chunk.length;
    if (this.total > this.maxBytes) {
      callback(tooLarge(this.maxBytes));
      return;
    }
    if (this.headLength < DETECTION_BYTES) {
      const part = chunk.subarray(0, DETECTION_BYTES - this.headLength);
      this.headParts.push(Buffer.from(part));
      this.headLength += part.length;
    }
    this.hash.update(chunk);
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    this.digest = this.hash.digest('hex');
    callback();
  }

  /** Bytes seen so far. */
  get size(): number {
    return this.total;
  }

  /** Lower-case hex SHA-256 of every byte; available once the stream ended. */
  get sha256(): string {
    if (this.digest === null) throw new Error('The stream has not ended');
    return this.digest;
  }

  /** The first 4 KiB. */
  get head(): Buffer {
    return Buffer.concat(this.headParts);
  }

  /** The type detected from the first 4 KiB (D.5). */
  get detectedType(): string {
    return detectFileType(this.head);
  }
}

/** SHA-256 hasher that passes bytes through (re-hash of a decrypted stream). */
export class HashingPassThrough extends Transform {
  private readonly hash: Hash = createHash('sha256');
  private digest: string | null = null;
  private total = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.hash.update(chunk);
    this.total += chunk.length;
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    this.digest = this.hash.digest('hex');
    callback();
  }

  get sha256(): string {
    if (this.digest === null) throw new Error('The stream has not ended');
    return this.digest;
  }

  get size(): number {
    return this.total;
  }
}
