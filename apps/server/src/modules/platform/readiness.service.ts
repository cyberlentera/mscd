import { Injectable } from '@nestjs/common';

export interface ReadinessCheck {
  /** Unique name shown in the readiness detail, for example `database`. */
  name: string;
  /** Resolves when ready (optionally with a detail text); rejects with the reason otherwise. */
  check(): Promise<string | void>;
  /** Default 3000 ms. */
  timeoutMs?: number;
  /**
   * Name of a check that must pass first (for example `database`). While it fails, this check is not run and not
   * listed: the report names the cause, not its consequences.
   */
  after?: string;
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
 * (the database module registers `SELECT 1`; the tenancy module adds migrations and schema privileges, C.3); the
 * process is ready when every check passes. Checks with `after` run once their prerequisite passed.
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
    const all = [...this.checks.values()];
    const first = await Promise.all(all.filter((check) => !check.after).map((check) => runCheck(check)));
    const passed = new Set(first.filter((r) => r.status === 'ok').map((r) => r.name));
    const second = await Promise.all(
      all.filter((check) => check.after !== undefined && passed.has(check.after)).map((check) => runCheck(check)),
    );
    const byName = new Map([...first, ...second].map((r) => [r.name, r]));
    const results = all.map((check) => byName.get(check.name)).filter((r): r is ReadinessCheckResult => r !== undefined);
    const skipped = all.some((check) => !byName.has(check.name));
    return { status: !skipped && results.every((r) => r.status === 'ok') ? 'ready' : 'not_ready', checks: results };
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
