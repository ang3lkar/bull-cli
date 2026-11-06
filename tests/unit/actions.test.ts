import type { Job, Queue } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_DELAY_MS,
  drainQueue,
  duplicateJob,
  pauseQueue,
  promoteJob,
  removeQueue,
  resumeQueue,
  retryFailedJobs,
  retryJob,
  togglePauseQueue,
} from '../../src/core/actions.js';

/**
 * The `catch` branches in `src/core/actions.ts` map an unexpected
 * bullmq-thrown error into `{ ok: false, message }`. The "job is missing" /
 * "wrong state" branches and the delete-a-locked-active-job branch are
 * exercised against real Redis in `tests/integration/actions.test.ts` — but
 * provoking bullmq into throwing from `job.retry()`/`job.promote()` or
 * `queue.pause()`/`resume()`/`drain()` isn't practical against a real
 * queue in a normal state. These unit tests use a minimal fake `Queue` to
 * hit those branches directly, including a non-`Error` throw (to cover
 * `toMessage`'s fallback `String(err)` branch), for the coverage gate.
 */
function fakeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    getState: async () => 'failed',
    retry: async () => undefined,
    promote: async () => undefined,
    remove: async () => undefined,
    ...overrides,
  } as unknown as Job;
}

function fakeQueue(overrides: Partial<Queue> = {}): Queue {
  return {
    getJob: async () => fakeJob(),
    pause: async () => undefined,
    resume: async () => undefined,
    isPaused: async () => false,
    drain: async () => undefined,
    ...overrides,
  } as unknown as Queue;
}

describe('retryJob error mapping', () => {
  it('normalizes a job.retry() throw into ok:false with its message', async () => {
    const queue = fakeQueue({
      getJob: async () =>
        fakeJob({
          getState: async () => 'failed',
          retry: async () => {
            throw new Error('retry boom');
          },
        }),
    });

    const result = await retryJob(queue, 'job-1');

    expect(result).toEqual({ ok: false, message: 'retry boom' });
  });

  it('normalizes a non-Error throw via String(err)', async () => {
    const queue = fakeQueue({
      getJob: async () => {
        // Intentionally a non-Error throw, to cover `toMessage`'s
        // `String(err)` fallback branch.
        throw 'not-an-error';
      },
    });

    const result = await retryJob(queue, 'job-1');

    expect(result).toEqual({ ok: false, message: 'not-an-error' });
  });
});

describe('promoteJob error mapping', () => {
  it('normalizes a job.promote() throw into ok:false with its message', async () => {
    const queue = fakeQueue({
      getJob: async () =>
        fakeJob({
          getState: async () => 'delayed',
          promote: async () => {
            throw new Error('promote boom');
          },
        }),
    });

    const result = await promoteJob(queue, 'job-1');

    expect(result).toEqual({ ok: false, message: 'promote boom' });
  });
});

describe('duplicateJob', () => {
  it('adds a clone with the same name/data, a fresh delay, and identity opts stripped', async () => {
    const added: Array<{ name: string; data: unknown; opts: unknown }> = [];
    const queue = fakeQueue({
      getJob: async () =>
        fakeJob({
          name: 'send-email',
          data: { to: 'a@b.com' },
          opts: {
            jobId: 'custom-id',
            repeat: { every: 1000 },
            deduplication: { id: 'dedup' },
            timestamp: 123,
            delay: 456,
            attempts: 5,
            priority: 2,
          },
        } as unknown as Partial<Job>),
      add: (async (name: string, data: unknown, opts: unknown) => {
        added.push({ name, data, opts });
        return fakeJob({ id: 'clone-1' } as unknown as Partial<Job>);
      }) as unknown as Queue['add'],
    });

    const result = await duplicateJob(queue, 'job-1');

    expect(result).toEqual({ ok: true, info: 'Job job-1 duplicated as delayed job clone-1' });
    expect(added).toEqual([
      {
        name: 'send-email',
        data: { to: 'a@b.com' },
        opts: { attempts: 5, priority: 2, delay: DUPLICATE_DELAY_MS },
      },
    ]);
  });

  it('reports not found for a missing job id', async () => {
    const queue = fakeQueue({ getJob: async () => undefined });

    const result = await duplicateJob(queue, 'does-not-exist');

    expect(result).toEqual({ ok: false, message: 'Job does-not-exist not found' });
  });

  it('normalizes a queue.add() throw into ok:false with its message', async () => {
    const queue = fakeQueue({
      getJob: async () => fakeJob({ name: 'j', data: {}, opts: {} } as unknown as Partial<Job>),
      add: (async () => {
        throw new Error('add boom');
      }) as unknown as Queue['add'],
    });

    const result = await duplicateJob(queue, 'job-1');

    expect(result).toEqual({
      ok: false,
      message: 'Could not duplicate job job-1: add boom',
    });
  });
});

describe('pauseQueue / resumeQueue error mapping', () => {
  it('pauseQueue normalizes a queue.pause() throw', async () => {
    const queue = fakeQueue({
      pause: async () => {
        throw new Error('pause boom');
      },
    });

    const result = await pauseQueue(queue);

    expect(result).toEqual({ ok: false, message: 'Could not pause queue: pause boom' });
  });

  it('resumeQueue normalizes a queue.resume() throw', async () => {
    const queue = fakeQueue({
      resume: async () => {
        throw new Error('resume boom');
      },
    });

    const result = await resumeQueue(queue);

    expect(result).toEqual({ ok: false, message: 'Could not resume queue: resume boom' });
  });
});

describe('togglePauseQueue error mapping', () => {
  it('normalizes a queue.isPaused() throw', async () => {
    const queue = fakeQueue({
      isPaused: async () => {
        throw new Error('isPaused boom');
      },
    });

    const result = await togglePauseQueue(queue);

    expect(result).toEqual({
      ok: false,
      message: 'Could not toggle queue pause state: isPaused boom',
    });
  });

  it('normalizes a queue.pause() throw reached while toggling from unpaused', async () => {
    const queue = fakeQueue({
      isPaused: async () => false,
      pause: async () => {
        throw new Error('pause boom');
      },
    });

    const result = await togglePauseQueue(queue);

    expect(result).toEqual({
      ok: false,
      message: 'Could not toggle queue pause state: pause boom',
    });
  });
});

describe('drainQueue error mapping', () => {
  it('normalizes a queue.drain() throw', async () => {
    const queue = fakeQueue({
      drain: async () => {
        throw new Error('drain boom');
      },
    });

    const result = await drainQueue(queue);

    expect(result).toEqual({ ok: false, message: 'Could not drain queue: drain boom' });
  });
});

describe('removeQueue (fake queue)', () => {
  function removable(overrides: Partial<Queue> = {}) {
    const calls: string[] = [];
    const queue = fakeQueue({
      name: 'emails',
      getActiveCount: async () => 0,
      isPaused: async () => false,
      obliterate: async (opts?: { force?: boolean }) => {
        calls.push(`obliterate:${opts?.force === true}`);
      },
      resume: async () => {
        calls.push('resume');
      },
      ...overrides,
    } as Partial<Queue>);
    return { queue, calls };
  }

  it('obliterates an idle queue and reports it', async () => {
    const { queue, calls } = removable();
    expect(await removeQueue(queue)).toEqual({ ok: true, info: 'Queue "emails" removed' });
    expect(calls).toEqual(['obliterate:false']);
  });

  it('refuses without touching the queue while jobs are active', async () => {
    const { queue, calls } = removable({ getActiveCount: async () => 2 });
    const result = await removeQueue(queue);
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('Queue has 2 active jobs'),
    });
    expect(calls).toEqual([]);
    const one = await removeQueue(removable({ getActiveCount: async () => 1 }).queue);
    expect(one).toEqual({ ok: false, message: expect.stringContaining('1 active job;') });
  });

  it('with force, skips the active check and passes force to bullmq', async () => {
    let counted = false;
    const { queue, calls } = removable({
      getActiveCount: async () => {
        counted = true;
        return 3;
      },
    });
    expect((await removeQueue(queue, { force: true })).ok).toBe(true);
    expect(counted).toBe(false);
    expect(calls).toEqual(['obliterate:true']);
  });

  it('resumes a queue that was running when obliterate fails, since obliterate pauses first', async () => {
    const { queue, calls } = removable({
      obliterate: async () => {
        throw new Error('Cannot obliterate queue with active jobs');
      },
    });
    expect(await removeQueue(queue)).toEqual({
      ok: false,
      message: 'Could not remove queue: Cannot obliterate queue with active jobs',
    });
    expect(calls).toEqual(['resume']);
  });

  it('leaves an already-paused queue paused when obliterate fails', async () => {
    const { queue, calls } = removable({
      isPaused: async () => true,
      obliterate: async () => {
        throw 'boom';
      },
    });
    expect(await removeQueue(queue)).toEqual({
      ok: false,
      message: 'Could not remove queue: boom',
    });
    expect(calls).toEqual([]);
  });

  it('does not resume when it failed before reading the pause state, and survives a failing resume', async () => {
    const early = removable({
      getActiveCount: async () => {
        throw new Error('conn lost');
      },
    });
    expect(await removeQueue(early.queue)).toEqual({
      ok: false,
      message: 'Could not remove queue: conn lost',
    });
    expect(early.calls).toEqual([]);

    const late = removable({
      obliterate: async () => {
        throw new Error('x');
      },
      resume: async () => {
        throw new Error('resume failed too');
      },
    });
    expect(await removeQueue(late.queue)).toEqual({
      ok: false,
      message: 'Could not remove queue: x',
    });
  });
});

describe('retryFailedJobs (fake queue)', () => {
  function failedJob(id: string, finishedOn: number, overrides: Partial<Job> = {}): Job {
    return fakeJob({ id, finishedOn, ...overrides } as Partial<Job>);
  }

  it('all: counts, calls retryJobs for the failed state, and reports every job retried', async () => {
    const calls: unknown[] = [];
    const queue = fakeQueue({
      getFailedCount: async () => 5,
      retryJobs: async (opts: unknown) => {
        calls.push(opts);
      },
    } as Partial<Queue>);
    const result = await retryFailedJobs(queue);
    expect(result).toEqual({ matched: 5, retried: 5, errored: 0, errors: [] });
    expect(calls).toEqual([expect.objectContaining({ state: 'failed' })]);
  });

  it('all: a dry run, or no failed jobs, never calls retryJobs', async () => {
    let called = false;
    const retryJobs = async () => {
      called = true;
    };
    const dry = await retryFailedJobs(
      fakeQueue({ getFailedCount: async () => 2, retryJobs } as Partial<Queue>),
      { dryRun: true },
    );
    expect(dry).toEqual({ matched: 2, retried: 0, errored: 0, errors: [] });
    const none = await retryFailedJobs(
      fakeQueue({ getFailedCount: async () => 0, retryJobs } as Partial<Queue>),
    );
    expect(none).toEqual({ matched: 0, retried: 0, errored: 0, errors: [] });
    expect(called).toBe(false);
  });

  it('all: a retryJobs throw re-reads the count to split retried from errored', async () => {
    const counts = [5, 2];
    const queue = fakeQueue({
      getFailedCount: async () => counts.shift() ?? 0,
      retryJobs: async () => {
        throw new Error('script boom');
      },
    } as Partial<Queue>);
    expect(await retryFailedJobs(queue)).toEqual({
      matched: 5,
      retried: 3,
      errored: 2,
      errors: [{ jobId: null, message: 'script boom' }],
    });
  });

  it('all: falls back to "none retried" when the re-read fails too', async () => {
    let first = true;
    const queue = fakeQueue({
      getFailedCount: async () => {
        if (first) {
          first = false;
          return 4;
        }
        throw new Error('gone');
      },
      retryJobs: async () => {
        throw new Error('script boom');
      },
    } as Partial<Queue>);
    const result = await retryFailedJobs(queue);
    expect(result).toMatchObject({ matched: 4, retried: 0, errored: 4 });
  });

  it('failedSince: pages newest-first, stops at the first older job, and skips removed jobs', async () => {
    const pages: Array<Array<Job | undefined>> = [
      [
        failedJob('new-1', 300),
        undefined as unknown as Job,
        failedJob('new-2', 200),
        failedJob('old-1', 50),
      ],
    ];
    const retried: string[] = [];
    const queue = fakeQueue({
      getFailed: async () => pages.shift() ?? [],
      getJob: async (id: string) =>
        failedJob(id, 0, {
          retry: async () => {
            retried.push(id);
          },
        }),
    } as Partial<Queue>);
    const result = await retryFailedJobs(queue, { failedSince: 100 });
    expect(result).toEqual({ matched: 2, retried: 2, errored: 0, errors: [] });
    expect(retried).toEqual(['new-1', 'new-2']);
  });

  it('failedSince: reads further pages while every job on a page is recent', async () => {
    const full = Array.from({ length: 200 }, (_, i) => failedJob(`p1-${i}`, 1000));
    const pages = [full, [failedJob('p2-0', 1000)]];
    const queue = fakeQueue({ getFailed: async () => pages.shift() ?? [] } as Partial<Queue>);
    const result = await retryFailedJobs(queue, { failedSince: 0, dryRun: true });
    expect(result).toEqual({ matched: 201, retried: 0, errored: 0, errors: [] });
  });

  it('failedSince: counts a job once when new failures shift it onto the next page', async () => {
    const full = Array.from({ length: 200 }, (_, i) => failedJob(`j${i}`, 1000));
    // A new failure arrived between the two reads: j199 moved down to page 2.
    const pages = [full, [failedJob('j199', 1000), failedJob('old', 1)]];
    const queue = fakeQueue({ getFailed: async () => pages.shift() ?? [] } as Partial<Queue>);
    const result = await retryFailedJobs(queue, { failedSince: 100, dryRun: true });
    expect(result.matched).toBe(200);
  });

  it('failedSince: a per-job failure is counted and reported, the rest still run', async () => {
    const queue = fakeQueue({
      getFailed: async () => [failedJob('a', 10), failedJob('b', 10)],
      getJob: async (id: string) => (id === 'a' ? undefined : failedJob(id, 10)),
    } as Partial<Queue>);
    expect(await retryFailedJobs(queue, { failedSince: 0 })).toEqual({
      matched: 2,
      retried: 1,
      errored: 1,
      errors: [{ jobId: 'a', message: 'Job a not found' }],
    });
  });

  it('jobId: retries a failed job, previews it on a dry run', async () => {
    let retries = 0;
    const queue = fakeQueue({
      getJob: async () =>
        fakeJob({
          retry: async () => {
            retries++;
          },
        }),
    });
    expect(await retryFailedJobs(queue, { jobId: 'job-1', dryRun: true })).toEqual({
      matched: 1,
      retried: 0,
      errored: 0,
      errors: [],
    });
    expect(retries).toBe(0);
    expect(await retryFailedJobs(queue, { jobId: 'job-1' })).toEqual({
      matched: 1,
      retried: 1,
      errored: 0,
      errors: [],
    });
    expect(retries).toBe(1);
  });

  it('jobId: a missing or non-failed job matches nothing and is an error', async () => {
    const missing = await retryFailedJobs(fakeQueue({ getJob: async () => undefined }), {
      jobId: 'x',
    });
    expect(missing).toEqual({
      matched: 0,
      retried: 0,
      errored: 0,
      errors: [{ jobId: 'x', message: 'Job x not found' }],
    });
    const active = await retryFailedJobs(
      fakeQueue({ getJob: async () => fakeJob({ getState: async () => 'active' }) }),
      { jobId: 'job-1', dryRun: true },
    );
    expect(active.errors[0].message).toContain('is active, not failed');
    expect(active.matched).toBe(0);
  });

  it('jobId: a job.retry() throw is reported against the job', async () => {
    const queue = fakeQueue({
      getJob: async () =>
        fakeJob({
          retry: async () => {
            throw new Error('locked');
          },
        }),
    });
    expect(await retryFailedJobs(queue, { jobId: 'job-1' })).toEqual({
      matched: 1,
      retried: 0,
      errored: 1,
      errors: [{ jobId: 'job-1', message: 'locked' }],
    });
  });

  it('never throws: an unexpected error becomes a batch-level error', async () => {
    const queue = fakeQueue({
      getFailedCount: async () => {
        throw 'string boom';
      },
    } as Partial<Queue>);
    expect(await retryFailedJobs(queue)).toEqual({
      matched: 0,
      retried: 0,
      errored: 0,
      errors: [{ jobId: null, message: 'string boom' }],
    });
  });
});
