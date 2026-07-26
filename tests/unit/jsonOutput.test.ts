import { describe, expect, it } from 'vitest';
import { buildQueuesJson } from '../../src/jsonOutput.js';

describe('buildQueuesJson', () => {
  it('returns all queues when no filter is provided', () => {
    const discoveredQueues = [
      { name: 'alpha', isPaused: false },
      { name: 'beta', isPaused: true },
    ];
    const countsByQueue = {
      alpha: { active: 1, waiting: 2, completed: 3, failed: 4, delayed: 5 },
      beta: { active: 6, waiting: 7, completed: 8, failed: 9, delayed: 10 },
    };

    expect(buildQueuesJson(discoveredQueues, countsByQueue)).toEqual({
      queues: [
        {
          name: 'alpha',
          isPaused: false,
          counts: { active: 1, waiting: 2, completed: 3, failed: 4, delayed: 5 },
        },
        {
          name: 'beta',
          isPaused: true,
          counts: { active: 6, waiting: 7, completed: 8, failed: 9, delayed: 10 },
        },
      ],
    });
  });

  it('returns one queue when a queue filter is provided', () => {
    const discoveredQueues = [
      { name: 'alpha', isPaused: false },
      { name: 'beta', isPaused: true },
    ];
    const countsByQueue = {
      alpha: { active: 1, waiting: 2, completed: 3, failed: 4, delayed: 5 },
      beta: { active: 6, waiting: 7, completed: 8, failed: 9, delayed: 10 },
    };

    expect(buildQueuesJson(discoveredQueues, countsByQueue, 'beta')).toEqual({
      queues: [
        {
          name: 'beta',
          isPaused: true,
          counts: { active: 6, waiting: 7, completed: 8, failed: 9, delayed: 10 },
        },
      ],
    });
  });

  it('throws when the requested queue does not exist', () => {
    const discoveredQueues = [{ name: 'alpha', isPaused: false }];
    const countsByQueue = {
      alpha: { active: 1, waiting: 2, completed: 3, failed: 4, delayed: 5 },
    };

    expect(() => buildQueuesJson(discoveredQueues, countsByQueue, 'missing')).toThrow(
      'Queue "missing" not found',
    );
  });
});
