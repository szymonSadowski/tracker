/** Job types and their payloads. One place to look for what the worker can be asked to do. */

export const JOB_TYPES = [
  'repository.backfill',
  'repository.history_sync',
  'repository.incremental_sync',
  'repository.file_fill_in',
  'repository.commit_sync',
  'repository.reprocess',
  'workspace.schedule_syncs',
  'pull_request.analyze',
  'workspace.recompute_analysis',
  'workspace.classify_pull_requests',
  'workspace.collect_classifications',
  'installation.reconcile_repositories',
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export interface JobPayloads {
  'repository.backfill': { repositoryId: string; windowStart?: string };
  /** `from: null` means all available history (design.md D4). */
  'repository.history_sync': { repositoryId: string; from: string | null };
  'repository.incremental_sync': { repositoryId: string; reason?: 'schedule' | 'on_demand' };
  /** Fills file, comment, and commit-statistic data for already-ingested pull requests. */
  'repository.file_fill_in': { repositoryId: string };
  /** `since`/`until` bound the default-branch history window; `cursor` resumes a paged walk. */
  'repository.commit_sync': {
    repositoryId: string;
    since?: string;
    until?: string;
    cursor?: string | null;
  };
  'repository.reprocess': { repositoryId: string };
  'workspace.schedule_syncs': Record<string, never>;
  'pull_request.analyze': { pullRequestId: string };
  'workspace.recompute_analysis': {
    repositoryId?: string;
    mergedAfter?: string;
    mergedBefore?: string;
  };
  /** Enqueue a classification batch for the workspace's eligible pull requests. */
  'workspace.classify_pull_requests': Record<string, never>;
  /** Ingest a finished classification batch; re-enqueues itself while the batch is running. */
  'workspace.collect_classifications': { batchId: string };
  'installation.reconcile_repositories': { installationId: string };
}

export type JobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobRecord<T extends JobType = JobType> {
  id: string;
  workspaceId: string;
  type: T;
  payload: JobPayloads[T];
  state: JobState;
  attempts: number;
  maxAttempts: number;
  priority: number;
  runAfter: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  lastError: string | null;
  dedupeKey: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}
