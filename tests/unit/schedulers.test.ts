import type { JobSchedulerJson, Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { PAGE_SIZE } from '../../src/core/jobs.js';
import {
  fetchSchedulerCount,
  fetchSchedulerPage,
  getSchedulerDetail,
} from '../../src/core/schedulers.js';

interface FakeQueueOptions {
  count?: number;
  schedulers?: Array<JobSchedulerJson | undefined>;
  scheduler?: JobSchedulerJson | undefined;
  existingJobIds?: string[];
}

/** Minimal stand-in for the bullmq `Queue` methods `schedulers.ts` calls. */
function fakeQueue(options: FakeQueueOptions = {}) {
  const existing = new Set(options.existingJobIds ?? []);
  const queue = {
    getJobSchedulersCount: vi.fn(async () => options.count ?? 0),
    getJobSchedulers: vi.fn(
      async (_start: number, _end: number, _asc: boolean) => options.schedulers ?? [],
    ),
    getJobScheduler: vi.fn(async (_key: string) => options.scheduler),
    getJob: vi.fn(async (id: string) => (existing.has(id) ? { id } : undefined)),
  };
  return { queue, asQueue: queue as unknown as Queue };
}

const NOW = 1_700_000_000_000;

function raw(overrides: Partial<JobSchedulerJson> = {}): JobSchedulerJson {
  return {
    key: 'digest',
    name: 'send-digest',
    pattern: '0 9 * * *',
    tz: 'Europe/Athens',
    next: NOW + 60_000,
    iterationCount: 4,
    limit: 10,
    ...overrides,
  } as JobSchedulerJson;
}

describe('fetchSchedulerCount', () => {
  it('returns the number of schedulers on the queue', async () => {
    const { asQueue, queue } = fakeQueue({ count: 7 });
    expect(await fetchSchedulerCount(asQueue)).toBe(7);
    expect(queue.getJobSchedulersCount).toHaveBeenCalledOnce();
  });
});

describe('fetchSchedulerPage', () => {
  it('maps raw scheduler JSON to summaries, with missing fields as null or 0', async () => {
    const { asQueue } = fakeQueue({
      count: 2,
      schedulers: [
        raw(),
        { key: 'every-one', name: 'poll', every: 30_000, next: NOW } as JobSchedulerJson,
      ],
    });

    const page = await fetchSchedulerPage(asQueue, 0);

    expect(page).toEqual({
      schedulers: [
        {
          key: 'digest',
          name: 'send-digest',
          pattern: '0 9 * * *',
          every: null,
          tz: 'Europe/Athens',
          next: NOW + 60_000,
          iterationCount: 4,
          limit: 10,
        },
        {
          key: 'every-one',
          name: 'poll',
          pattern: null,
          every: 30_000,
          tz: null,
          next: NOW,
          iterationCount: 0,
          limit: null,
        },
      ],
      totalCount: 2,
      page: 0,
      pageCount: 1,
    });
  });

  it('asks bullmq for the soonest-running schedulers first, one page at a time', async () => {
    const { asQueue, queue } = fakeQueue({ count: 1 });
    await fetchSchedulerPage(asQueue, 0);
    expect(queue.getJobSchedulers).toHaveBeenCalledWith(0, PAGE_SIZE - 1, true);
  });

  it('drops entries bullmq returns as undefined (no backing hash)', async () => {
    const { asQueue } = fakeQueue({ count: 2, schedulers: [undefined, raw()] });
    const page = await fetchSchedulerPage(asQueue, 0);
    expect(page.schedulers.map((s) => s.key)).toEqual(['digest']);
  });

  it('reports one empty page for a queue without schedulers', async () => {
    const { asQueue } = fakeQueue({ count: 0 });
    expect(await fetchSchedulerPage(asQueue, 0)).toEqual({
      schedulers: [],
      totalCount: 0,
      page: 0,
      pageCount: 1,
    });
  });

  it('computes the page count and offset, clamping out-of-range pages', async () => {
    const count = PAGE_SIZE * 2 + 1;
    const { asQueue, queue } = fakeQueue({ count });

    const beyond = await fetchSchedulerPage(asQueue, 99);
    expect(beyond.pageCount).toBe(3);
    expect(beyond.page).toBe(2);
    expect(queue.getJobSchedulers).toHaveBeenLastCalledWith(PAGE_SIZE * 2, PAGE_SIZE * 3 - 1, true);

    const negative = await fetchSchedulerPage(asQueue, -4);
    expect(negative.page).toBe(0);
    expect(queue.getJobSchedulers).toHaveBeenLastCalledWith(0, PAGE_SIZE - 1, true);
  });
});

describe('getSchedulerDetail', () => {
  it('returns null and skips the next-job lookup when the scheduler is missing', async () => {
    const { asQueue, queue } = fakeQueue({ scheduler: undefined });
    expect(await getSchedulerDetail(asQueue, 'nope')).toBeNull();
    expect(queue.getJobScheduler).toHaveBeenCalledWith('nope');
    expect(queue.getJob).not.toHaveBeenCalled();
  });

  it('maps the full payload and confirms the next job id exists', async () => {
    const data = { hello: 'world' };
    const opts = { attempts: 4 };
    const { asQueue, queue } = fakeQueue({
      scheduler: raw({
        key: 'detail-one',
        startDate: NOW - 1000,
        endDate: NOW + 1000,
        offset: 250,
        template: { data, opts } as JobSchedulerJson['template'],
      }),
      existingJobIds: [`repeat:detail-one:${NOW + 60_000}`],
    });

    const detail = await getSchedulerDetail(asQueue, 'detail-one');

    expect(detail).toEqual({
      key: 'detail-one',
      name: 'send-digest',
      pattern: '0 9 * * *',
      every: null,
      tz: 'Europe/Athens',
      next: NOW + 60_000,
      iterationCount: 4,
      limit: 10,
      startDate: NOW - 1000,
      endDate: NOW + 1000,
      offset: 250,
      template: { data, opts },
      nextJobId: `repeat:detail-one:${NOW + 60_000}`,
    });
    expect(queue.getJob).toHaveBeenCalledWith(`repeat:detail-one:${NOW + 60_000}`);
  });

  it('reports a null nextJobId when the candidate job does not exist', async () => {
    const { asQueue } = fakeQueue({ scheduler: raw({ key: 'orphan' }) });
    const detail = await getSchedulerDetail(asQueue, 'orphan');
    expect(detail?.nextJobId).toBeNull();
  });

  it('treats a scheduler with no next run as missing (bullmq key-derived ghost)', async () => {
    const { asQueue, queue } = fakeQueue({
      scheduler: {
        key: 'tenant:42:sync',
        name: 'tenant',
        id: 'tenant:42:sync',
      } as JobSchedulerJson,
    });
    expect(await getSchedulerDetail(asQueue, 'tenant:42:sync')).toBeNull();
    expect(queue.getJob).not.toHaveBeenCalled();
  });

  it('builds the next job id from the key, not the id', async () => {
    const id = `repeat:digest:${NOW + 60_000}`;
    const { asQueue } = fakeQueue({
      scheduler: raw({ id: 'other' }),
      existingJobIds: [id],
    });
    expect((await getSchedulerDetail(asQueue, 'digest'))?.nextJobId).toBe(id);
  });

  it('defaults the optional dates, offset and template to null/undefined', async () => {
    const { asQueue } = fakeQueue({
      scheduler: { key: 'bare', name: 'bare', next: NOW } as JobSchedulerJson,
    });
    const detail = await getSchedulerDetail(asQueue, 'bare');
    expect(detail).toMatchObject({
      key: 'bare',
      name: 'bare',
      pattern: null,
      every: null,
      tz: null,
      next: NOW,
      iterationCount: 0,
      limit: null,
      startDate: null,
      endDate: null,
      offset: null,
      template: { data: undefined, opts: undefined },
      nextJobId: null,
    });
  });
});
