import type { JobSummary } from './types.js';

/**
 * Filters a job list by a case-insensitive substring match on job id OR
 * name. An empty/whitespace-only query is treated as "no filter" — the
 * full list is returned. Pure function; no I/O.
 */
export function filterJobs(jobs: JobSummary[], query: string): JobSummary[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === '') {
    return jobs;
  }

  return jobs.filter(
    (job) => job.id.toLowerCase().includes(trimmed) || job.name.toLowerCase().includes(trimmed),
  );
}
