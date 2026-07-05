import { describe, expect, it } from 'vitest';
import { filterJobs } from '../../src/core/filter.js';
import type { JobSummary } from '../../src/core/types.js';

function job(overrides: Partial<JobSummary>): JobSummary {
  return {
    id: '1',
    name: 'send-email',
    attemptsMade: 0,
    timestamp: 0,
    progress: null,
    ...overrides,
  };
}

describe('filterJobs', () => {
  const jobs: JobSummary[] = [
    job({ id: '1', name: 'send-email' }),
    job({ id: '2', name: 'send-sms' }),
    job({ id: 'abc-123', name: 'report-generate' }),
  ];

  it('returns all jobs for an empty query', () => {
    expect(filterJobs(jobs, '')).toEqual(jobs);
  });

  it('returns all jobs for a whitespace-only query', () => {
    expect(filterJobs(jobs, '   ')).toEqual(jobs);
  });

  it('matches by id, case-insensitively', () => {
    expect(filterJobs(jobs, 'ABC')).toEqual([jobs[2]]);
  });

  it('matches by name, case-insensitively', () => {
    expect(filterJobs(jobs, 'SEND')).toEqual([jobs[0], jobs[1]]);
  });

  it('matches a substring in the middle of an id or name', () => {
    expect(filterJobs(jobs, 'sms')).toEqual([jobs[1]]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterJobs(jobs, 'nonexistent')).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const copy = [...jobs];
    filterJobs(jobs, 'send');
    expect(jobs).toEqual(copy);
  });
});
