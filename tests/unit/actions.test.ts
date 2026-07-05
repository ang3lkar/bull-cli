import type { Job, Queue } from 'bullmq';
import { describe, expect, it } from 'vitest';
import {
  drainQueue,
  pauseQueue,
  promoteJob,
  resumeQueue,
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
