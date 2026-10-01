// After-commit hooks of the transactions `withTenant` and `withPlatform` open (build plan F.10). Work that must
// happen only when the business transaction commits (for example handing a job to an in-memory queue) registers a
// hook; the hooks run in order after the commit and are dropped on rollback.
import type { Transaction } from 'kysely';

type Hook = () => void | Promise<void>;

const hooks = new WeakMap<object, Hook[]>();

/** Called by the transaction owner (TenantScope) right after the transaction began. */
export function openTransactionHooks<DB>(trx: Transaction<DB>): void {
  hooks.set(trx, []);
}

/** True when `trx` was opened by `withTenant` or `withPlatform` and accepts after-commit hooks. */
export function acceptsAfterCommit<DB>(trx: Transaction<DB>): boolean {
  return hooks.has(trx);
}

/** Runs `fn` after `trx` commits; nothing happens when it rolls back. */
export function afterCommit<DB>(trx: Transaction<DB>, fn: Hook): void {
  const list = hooks.get(trx);
  if (!list) {
    throw new Error('afterCommit: the transaction was not opened by withTenant or withPlatform');
  }
  list.push(fn);
}

/**
 * Called by the transaction owner after the commit: runs and forgets the hooks. A failing hook is reported to
 * `onError` and does not stop the others (the transaction is already committed).
 */
export async function runAfterCommitHooks<DB>(trx: Transaction<DB>, onError: (error: unknown) => void): Promise<void> {
  const list = hooks.get(trx) ?? [];
  hooks.delete(trx);
  for (const hook of list) {
    try {
      await hook();
    } catch (error) {
      onError(error);
    }
  }
}

/** Called by the transaction owner after a rollback: forgets the hooks. */
export function discardTransactionHooks<DB>(trx: Transaction<DB>): void {
  hooks.delete(trx);
}
