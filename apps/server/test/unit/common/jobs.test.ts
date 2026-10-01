import { Injectable, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Transaction } from 'kysely';
import { describe, expect, it } from 'vitest';
import { InMemoryJobQueue } from '../../../src/common/jobs/in-memory-job-queue';
import { JobHandler, JobHandlerRegistry, type JobHandlerInstance } from '../../../src/common/jobs/job-handler';
import type { JobRun } from '../../../src/common/jobs/job-queue';
import { discardTransactionHooks, openTransactionHooks, runAfterCommitHooks } from '../../../src/common/transaction-hooks';
import type { DB } from '../../../src/db/types';

const ORG = '00000000-0000-4000-8000-00000000a001';

/** A stand-in for a transaction opened by withTenant (only its identity matters to the hooks). */
function fakeTrx(): Transaction<DB> {
  const trx = {} as Transaction<DB>;
  openTransactionHooks(trx);
  return trx;
}

describe('in-memory job queue (E.1)', () => {
  it('runs sent jobs with the envelope and counts attempts', async () => {
    const queue = new InMemoryJobQueue({ autoRun: false });
    const runs: JobRun<'drift.evaluate'>[] = [];
    await queue.work('drift.evaluate', { concurrency: 1 }, async (job) => {
      runs.push(job);
    });
    const id = await queue.send('drift.evaluate', { orgId: ORG, requestId: 'req-1', payload: { msId: 'm-1' } });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(queue.waitingJobs('drift.evaluate')).toHaveLength(1);
    await queue.drain();
    expect(runs).toEqual([{ id, name: 'drift.evaluate', env: { orgId: ORG, requestId: 'req-1', payload: { msId: 'm-1' } }, attempt: 1 }]);
    expect(queue.completed('drift.evaluate')).toHaveLength(1);
  });

  it('keeps one waiting job per singleton key', async () => {
    const queue = new InMemoryJobQueue({ autoRun: false });
    const first = await queue.send('freshness.recompute', { orgId: ORG, payload: {} }, { singletonKey: `fr:${ORG}:all` });
    const second = await queue.send('freshness.recompute', { orgId: ORG, payload: {} }, { singletonKey: `fr:${ORG}:all` });
    const other = await queue.send('freshness.recompute', { orgId: ORG, payload: {} }, { singletonKey: `fr:${ORG}:isms` });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(other).not.toBeNull();
    expect((await queue.stats()).find((s) => s.name === 'freshness.recompute')).toMatchObject({ waiting: 2, active: 0, failed: 0 });
  });

  it('retries failed jobs up to the retry limit, then records the failure', async () => {
    const queue = new InMemoryJobQueue({ autoRun: false });
    const attempts: number[] = [];
    await queue.work('export.build', { concurrency: 1 }, async (job) => {
      attempts.push(job.attempt);
      throw new Error(`attempt ${job.attempt} failed`);
    });
    await queue.send('export.build', { orgId: ORG, payload: { taskId: 't-1' } }, { retryLimit: 2 });
    await queue.drain();
    expect(attempts).toEqual([1, 2, 3]);
    expect(queue.failed('export.build')).toEqual([expect.objectContaining({ attempt: 3, error: 'attempt 3 failed' })]);
  });

  it('honours delays and concurrency', async () => {
    const queue = new InMemoryJobQueue({ autoRun: false });
    let active = 0;
    let peak = 0;
    await queue.work('link-health.check', { concurrency: 2 }, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    for (let i = 0; i < 5; i += 1) {
      await queue.send('link-health.check', { orgId: ORG, payload: { repositoryId: 'r', storageObjectIds: [String(i)] } });
    }
    await queue.send('link-health.check', { orgId: ORG, payload: { repositoryId: 'r', storageObjectIds: ['late'] } }, { startAfterSeconds: 3600 });
    await queue.drain();
    expect(peak).toBe(2);
    expect(queue.completed('link-health.check')).toHaveLength(5);
    expect(queue.waitingJobs('link-health.check')).toHaveLength(1);
    await queue.drain({ includeDelayed: true });
    expect(queue.completed('link-health.check')).toHaveLength(6);
  });

  it('queues a transactional send only when the transaction commits (E.1)', async () => {
    const queue = new InMemoryJobQueue({ autoRun: false });
    const committed = fakeTrx();
    const rolledBack = fakeTrx();
    await queue.send('notifications.dispatch', { orgId: ORG, payload: { notificationIds: ['a'] } }, {}, committed);
    await queue.send('notifications.dispatch', { orgId: ORG, payload: { notificationIds: ['b'] } }, {}, rolledBack);
    expect(queue.waitingJobs()).toHaveLength(0);
    discardTransactionHooks(rolledBack);
    await runAfterCommitHooks(committed, (error) => {
      throw error;
    });
    expect(queue.waitingJobs().map((j) => j.env.payload)).toEqual([{ notificationIds: ['a'] }]);
    await expect(queue.send('notifications.dispatch', { orgId: ORG, payload: {} }, {}, {} as Transaction<DB>)).rejects.toThrow(/withTenant/);
  });

  it('runs automatically when autoRun is on and rejects unknown jobs', async () => {
    const queue = new InMemoryJobQueue();
    const done = new Promise<void>((resolve) => {
      void queue.work('cleanup.expired', { concurrency: 1 }, async () => resolve());
    });
    await queue.send('cleanup.expired', { orgId: null, payload: {} });
    await done;
    const untyped = queue.send.bind(queue) as unknown as (name: string, env: unknown) => Promise<string | null>;
    await expect(untyped('no.such.job', { orgId: null, payload: {} })).rejects.toThrow(/Unknown job/);
    await queue.schedule('cleanup.expired', '20 * * * *', { orgId: null, payload: {} }, 'UTC');
    expect(queue.schedules).toEqual([{ name: 'cleanup.expired', cron: '20 * * * *', env: { orgId: null, payload: {} }, tz: 'UTC' }]);
    await queue.stop();
    await expect(queue.send('cleanup.expired', { orgId: null, payload: {} })).rejects.toThrow(/stopped/);
  });
});

@Injectable()
@JobHandler('tasks.overdue', { concurrency: 2, scope: 'tenant' })
class OverdueHandler implements JobHandlerInstance<'tasks.overdue'> {
  readonly seen: string[] = [];
  async handle(job: JobRun<'tasks.overdue'>): Promise<void> {
    this.seen.push(job.env.orgId ?? 'none');
  }
}

@Injectable()
@JobHandler('cleanup.expired', { concurrency: 1, scope: 'installation' })
class CleanupHandler implements JobHandlerInstance<'cleanup.expired'> {
  async handle(): Promise<void> {}
}

@Module({ imports: [DiscoveryModule], providers: [OverdueHandler, CleanupHandler, JobHandlerRegistry] })
class HandlersModule {}

describe('@JobHandler and discovery (E.1)', () => {
  it('finds decorated providers and starts a worker per handler', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [HandlersModule] }).compile();
    await moduleRef.init();
    const registry = moduleRef.get(JobHandlerRegistry);
    expect(registry.discover().map((h) => [h.metadata.name, h.metadata.concurrency, h.metadata.scope])).toEqual([
      ['cleanup.expired', 1, 'installation'],
      ['tasks.overdue', 2, 'tenant'],
    ]);
    const queue = new InMemoryJobQueue({ autoRun: false });
    expect(await registry.registerAll(queue, { queues: ['tasks.overdue'] })).toEqual(['tasks.overdue']);
    await queue.send('tasks.overdue', { orgId: ORG, payload: {} });
    await queue.send('cleanup.expired', { orgId: null, payload: {} });
    await queue.drain();
    expect(moduleRef.get(OverdueHandler).seen).toEqual([ORG]);
    expect(queue.waitingJobs('cleanup.expired')).toHaveLength(1);
    await expect(registry.registerAll(new InMemoryJobQueue(), { queues: ['nope'] })).rejects.toThrow(/Unknown queue/);
    await moduleRef.close();
  });

  it('rejects unknown job names and bad concurrency at decoration time', () => {
    expect(() => JobHandler('nope' as never, { concurrency: 1, scope: 'tenant' })).toThrow(/unknown job/);
    expect(() => JobHandler('tasks.overdue', { concurrency: 0, scope: 'tenant' })).toThrow(/concurrency/);
  });
});
