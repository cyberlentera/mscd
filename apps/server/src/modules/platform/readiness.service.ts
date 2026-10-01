import { Injectable } from '@nestjs/common';

export interface ReadinessCheck {
  /** Unique name shown in the readiness detail, for example `database`. */
  name: string;
  /** Resolves when ready (optionally with a detail text); rejects with the reason otherwise. */
  check(): Promise<string | void>;
  /** Default 3000 ms. */
  timeoutMs?: number;
}

export interface ReadinessCheckResult {
  name: string;
  status: 'ok' | 'fail';
  detail?: string;
  durationMs: number;
}

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checks: ReadinessCheckResult[];
}

/**
 * Readiness of this process (`GET /readyz`, D.3 "Health and metrics"). Modules register their checks at start
 * (the database module registers `SELECT 1`; WP-08 adds migrations and schema privileges, C.3); the process is
 * ready when every check passes.
 */
@Injectable()
export class ReadinessService {
  private readonly checks = new Map<string, ReadinessCheck>();

  register(check: ReadinessCheck): void {
    if (this.checks.has(check.name)) throw new Error(`Readiness check ${check.name} is already registered`);
    this.checks.set(check.name, check);
  }

  names(): string[] {
    return [...this.checks.keys()];
  }

  async evaluate(): Promise<ReadinessReport> {
    const results = await Promise.all([...this.checks.values()].map((check) => runCheck(check)));
    return { status: results.every((r) => r.status === 'ok') ? 'ready' : 'not_ready', checks: results };
  }
}

async function runCheck(check: ReadinessCheck): Promise<ReadinessCheckResult> {
  const started = performance.now();
  const timeoutMs = check.timeoutMs ?? 3000;
  let timer: NodeJS.Timeout | undefined;
  try {
    const detail = await Promise.race([
      check.check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return { name: check.name, status: 'ok', ...(detail ? { detail } : {}), durationMs: elapsed(started) };
  } catch (error) {
    return { name: check.name, status: 'fail', detail: (error as Error).message, durationMs: elapsed(started) };
  } finally {
    clearTimeout(timer);
  }
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
