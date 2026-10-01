// Ring buffer of the most recent log lines of this process (build plan D.3 `POST /ops/diagnostics`, F.12).
//
// The buffer taps the output stream of the pino loggers, so it holds exactly the JSON lines the process wrote to
// stdout, after pino applied the F.12 redaction paths and the request URL serializer: nothing that never reached
// the log can reach the diagnostics archive, and nothing reaches it unredacted. The diagnostics archive scrubs the
// lines once more against the configured secret values (defence in depth).
import { symbols, type Logger as PinoInstance } from 'pino';

/** D.3: the archive carries the last 1,000 log lines. */
export const LOG_RING_CAPACITY = 1000;

/** Longer lines are cut (a single line never fills the archive). */
export const LOG_RING_MAX_LINE_CHARS = 16_384;

const TAPPED = Symbol.for('mscd.logRing.tapped');

export class LogRing {
  private readonly buffer: string[] = [];
  private next = 0;
  private filled = false;

  constructor(
    readonly capacity: number = LOG_RING_CAPACITY,
    private readonly maxLineChars: number = LOG_RING_MAX_LINE_CHARS,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('LogRing capacity must be a positive integer');
  }

  /** Adds the lines of one chunk written to the log stream. */
  push(chunk: unknown): void {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : '';
    if (text === '') return;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const kept = line.length > this.maxLineChars ? `${line.slice(0, this.maxLineChars)}...[cut]` : line;
      this.buffer[this.next] = kept;
      this.next = (this.next + 1) % this.capacity;
      if (this.next === 0) this.filled = true;
    }
  }

  /** The buffered lines, oldest first. */
  lines(): string[] {
    if (!this.filled) return this.buffer.slice(0, this.next);
    return [...this.buffer.slice(this.next), ...this.buffer.slice(0, this.next)];
  }

  get size(): number {
    return this.filled ? this.capacity : this.next;
  }

  clear(): void {
    this.buffer.length = 0;
    this.next = 0;
    this.filled = false;
  }
}

/** The ring buffer of this process: one process writes one log stream. */
export const LOG_RING = new LogRing();

interface WritableLike {
  write: (chunk: unknown, ...rest: unknown[]) => unknown;
  [TAPPED]?: LogRing;
}

/**
 * Copies every line the pino logger writes into `ring`. Child loggers share the parent's stream, so tapping the
 * root logger covers every request logger. Returns false when the logger has no stream that can be tapped.
 * Tapping the same stream twice does nothing.
 */
export function tapPinoLogger(logger: PinoInstance | undefined | null, ring: LogRing = LOG_RING): boolean {
  if (!logger) return false;
  const stream = (logger as unknown as Record<symbol, unknown>)[symbols.streamSym] as WritableLike | undefined;
  if (!stream || typeof stream.write !== 'function') return false;
  if (stream[TAPPED]) return true;
  const original = stream.write;
  stream.write = function tappedWrite(this: unknown, chunk: unknown, ...rest: unknown[]): unknown {
    try {
      ring.push(chunk);
    } catch {
      // The copy must never break logging.
    }
    return original.call(this, chunk, ...rest);
  };
  stream[TAPPED] = ring;
  return true;
}
