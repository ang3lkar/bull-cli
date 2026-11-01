import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionOpts } from '../../src/config.js';
import { PAGE_SIZE } from '../../src/core/jobs.js';
import {
  fetchSchedulerCount,
  fetchSchedulerPage,
  getSchedulerDetail,
} from '../../src/core/schedulers.js';
import { createApp } from '../../src/wiring.js';

// Not 6: that DB belongs to jsonOutput.test.ts (JSON_OUTPUT_DB = 6); seed uses DB 0.
const SCHEDULERS_DB = 7;
const connection: ConnectionOpts = { host: 'localhost', port: 6379, db: SCHEDULERS_DB };

let redis: Redis;
let queue: Queue;

beforeAll(() => {
  redis = new Redis({ ...connection, maxRetriesPerRequest: null });
});

beforeEach(async () => {
  await redis.flushdb();
  queue = new Queue('schedQ', { connection });
});

afterEach(async () => {
  await queue.close();
});

afterAll(async () => {
  await redis.flushdb();
  redis.disconnect();
});

describe('fetchSchedulerPage', () => {
  it('returns an empty single page for a queue without schedulers', async () => {
    const page = await fetchSchedulerPage(queue, 0);
    expect(page).toEqual({ schedulers: [], totalCount: 0, page: 0, pageCount: 1 });
    expect(await fetchSchedulerCount(queue)).toBe(0);
  });

  it('maps pattern, every and limit schedulers', async () => {
    await queue.upsertJobScheduler(
      'cron-one',
      { pattern: '0 9 * * *', tz: 'Europe/Athens' },
      { name: 'digest', data: { a: 1 } },
    );
    await queue.upsertJobScheduler('every-one', { every: 60_000 }, { name: 'poll' });
    await queue.upsertJobScheduler('limited', { every: 120_000, limit: 5 }, { name: 'capped' });

    const page = await fetchSchedulerPage(queue, 0);
    expect(page.totalCount).toBe(3);
    const byKey = Object.fromEntries(page.schedulers.map((s) => [s.key, s]));

    expect(byKey['cron-one']).toMatchObject({
      key: 'cron-one',
      name: 'digest',
      pattern: '0 9 * * *',
      every: null,
      tz: 'Europe/Athens',
      iterationCount: 1,
      limit: null,
    });
    expect(byKey['cron-one'].next).toBeGreaterThan(Date.now());

    expect(byKey['every-one']).toMatchObject({
      name: 'poll',
      pattern: null,
      every: 60_000,
      tz: null,
      limit: null,
    });
    expect(byKey.limited).toMatchObject({ every: 120_000, limit: 5, name: 'capped' });
  });

  it('lists the soonest-running scheduler first', async () => {
    await queue.upsertJobScheduler('slow', { every: 3_600_000 }, { name: 'slow' });
    await queue.upsertJobScheduler('fast', { every: 1000 }, { name: 'fast' });
    await queue.upsertJobScheduler('medium', { every: 60_000 }, { name: 'medium' });

    const page = await fetchSchedulerPage(queue, 0);
    const nexts = page.schedulers.map((s) => s.next ?? 0);
    expect(nexts).toEqual([...nexts].sort((a, b) => a - b));
    expect(page.schedulers).toHaveLength(3);
  });

  it('pages and clamps out-of-range pages', async () => {
    const total = PAGE_SIZE + 3;
    for (let i = 0; i < total; i++) {
      await queue.upsertJobScheduler(`s${i}`, { every: 60_000 }, { name: `n${i}` });
    }

    const first = await fetchSchedulerPage(queue, 0);
    expect(first.totalCount).toBe(total);
    expect(first.pageCount).toBe(2);
    expect(first.schedulers).toHaveLength(PAGE_SIZE);

    const second = await fetchSchedulerPage(queue, 1);
    expect(second.page).toBe(1);
    expect(second.schedulers).toHaveLength(3);

    const keys = [...first.schedulers, ...second.schedulers].map((s) => s.key);
    expect(new Set(keys).size).toBe(total);

    expect((await fetchSchedulerPage(queue, 99)).page).toBe(1);
    expect((await fetchSchedulerPage(queue, -4)).page).toBe(0);
    expect(await fetchSchedulerCount(queue)).toBe(total);
  });

  it('lists a legacy repeatable job created with queue.add({ repeat })', async () => {
    await queue.add('legacy', { x: 1 }, { repeat: { every: 60_000 } });

    const page = await fetchSchedulerPage(queue, 0);
    expect(page.totalCount).toBe(1);
    expect(page.schedulers).toHaveLength(1);
    expect(page.schedulers[0].name).toBe('legacy');
    expect(page.schedulers[0].next).not.toBeNull();
  });
});

describe('getSchedulerDetail', () => {
  it('returns null for a scheduler that does not exist', async () => {
    expect(await getSchedulerDetail(queue, 'nope')).toBeNull();
  });

  it('returns metadata, the template, and the confirmed next job id', async () => {
    // A far-future cron pattern, so the next job is a genuinely delayed one
    // (an `every` scheduler's first run is due immediately).
    await queue.upsertJobScheduler(
      'detail-one',
      { pattern: '0 0 1 1 *', tz: 'UTC', limit: 9 },
      { name: 'detailed', data: { hello: 'world' }, opts: { attempts: 4 } },
    );

    const detail = await getSchedulerDetail(queue, 'detail-one');
    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      key: 'detail-one',
      name: 'detailed',
      every: null,
      pattern: '0 0 1 1 *',
      tz: 'UTC',
      limit: 9,
      startDate: null,
      endDate: null,
    });
    expect(detail?.template.data).toEqual({ hello: 'world' });
    expect(detail?.template.opts).toMatchObject({ attempts: 4 });

    expect(detail?.nextJobId).toBe(`repeat:detail-one:${detail?.next}`);
    const job = await queue.getJob(detail?.nextJobId as string);
    expect(job).toBeDefined();
    expect(await job?.getState()).toBe('delayed');
  });

  it('resolves the next job id of an every scheduler to an existing job', async () => {
    await queue.upsertJobScheduler('ticker', { every: 60_000 }, { name: 'tick' });
    const detail = await getSchedulerDetail(queue, 'ticker');
    expect(detail?.nextJobId).not.toBeNull();
    expect(await queue.getJob(detail?.nextJobId as string)).toBeDefined();
  });

  it('reports a null next job id when the delayed job is gone', async () => {
    await queue.upsertJobScheduler('orphan', { every: 60_000 }, { name: 'orphaned' });
    const before = await getSchedulerDetail(queue, 'orphan');
    expect(before?.nextJobId).not.toBeNull();
    // `queue.remove` refuses scheduler-owned jobs, so delete the job hash directly.
    await redis.del(`bull:schedQ:${before?.nextJobId}`);

    const after = await getSchedulerDetail(queue, 'orphan');
    expect(after).not.toBeNull();
    expect(after?.nextJobId).toBeNull();
  });

  it('returns null for a removed scheduler whose id contains a colon', async () => {
    await queue.upsertJobScheduler('tenant:42:sync', { every: 60_000 }, { name: 'tenant-sync' });
    expect((await getSchedulerDetail(queue, 'tenant:42:sync'))?.name).toBe('tenant-sync');

    await queue.removeJobScheduler('tenant:42:sync');
    expect(await getSchedulerDetail(queue, 'tenant:42:sync')).toBeNull();
  });

  it('carries start and end dates through', async () => {
    const startDate = Date.now() + 3_600_000;
    const endDate = Date.now() + 7_200_000;
    await queue.upsertJobScheduler(
      'dated',
      { every: 60_000, startDate, endDate },
      { name: 'dated' },
    );
    const detail = await getSchedulerDetail(queue, 'dated');
    expect(detail?.startDate).toBe(startDate);
    expect(detail?.endDate).toBe(endDate);
  });
});

describe('createApp: schedulers through the wired store', () => {
  it('lists schedulers on the tab, opens one, and reaches its next job', async () => {
    await queue.upsertJobScheduler(
      'wired',
      { pattern: '0 0 1 1 *', tz: 'UTC' },
      { name: 'wired-job', data: { v: 1 } },
    );
    const app = createApp(`redis://localhost:6379/${SCHEDULERS_DB}`, 'bull');
    try {
      await app.start();
      const { store } = app;
      await vi.waitFor(() => expect(store.getSnapshot().selectedQueueName).toBe('schedQ'));

      store.pushJobsView();
      await vi.waitFor(() => expect(store.getSnapshot().schedulerCount).toBe(1));

      store.selectTab('schedulers');
      await vi.waitFor(() => expect(store.getSnapshot().selectedSchedulerKey).toBe('wired'));

      await store.openSchedulerDetail();
      expect(store.getSnapshot().schedulerDetail?.template.data).toEqual({ v: 1 });

      await store.openSchedulerNextJob();
      const view = store.getSnapshot().currentView;
      expect(view.kind).toBe('detail');
      expect(store.getSnapshot().detail?.state).toBe('delayed');
    } finally {
      await app.stop();
    }
  });
});
