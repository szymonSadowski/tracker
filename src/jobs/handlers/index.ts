/** The job types this deployment can execute. Every handler lives behind one entry here. */
import { analyzePullRequest, recomputeAnalysis } from '../../analysis/service';
import {
  collectClassificationBatch,
  startClassificationBatch,
} from '../../classification/service';
import { AnthropicClassificationProvider } from '../../classification/provider';
import { gitHubContextForWorkspace, tokenProvider } from '../../github/context';
import { GitHubAuthError } from '../../github/http';
import { runBackfill } from '../../ingest/backfill';
import { enqueueWorkspaceCommitSyncs, runDefaultBranchCommitSync } from '../../ingest/commits';
import { enqueueWorkspaceFileFillIn, runFileFillIn } from '../../ingest/file-fill-in';
import { runHistorySync } from '../../ingest/history';
import { enqueueWorkspaceSyncs, runIncrementalSync } from '../../ingest/incremental';
import { reprocessFromRaw } from '../../ingest/reprocess';
import { markInstallationNeedsAttention, reconcileRepositories } from '../../installations/service';
import { findInstallationByWorkspace } from '../../installations/store';
import { GitHubInstallationGateway, toRepositoryInput } from '../../installations/github-sync';
import { loadConfig, syncDefaults } from '../../config/env';
import { PermanentError } from '../errors';
import type { HandlerRegistry, JobContext } from '../worker';

/**
 * Credentials GitHub rejects are an installation-level problem, not a job-level one: park the
 * installation for its owners to reconnect and stop scheduling work that can only fail
 * (spec: github-app-installation).
 */
async function withInstallationHealth<T>(
  ctx: Pick<JobContext, 'db' | 'workspaceId'>,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GitHubAuthError) {
      const installation = await findInstallationByWorkspace(ctx.db, ctx.workspaceId);
      if (installation) tokenProvider().invalidate(installation.githubInstallationId);
      await markInstallationNeedsAttention(ctx.db, ctx.workspaceId, error.message);
      throw new PermanentError(`Installation needs attention: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

export const handlers: HandlerRegistry = {
  'repository.backfill': async (ctx) => {
    await withInstallationHealth(ctx, async () => {
      const github = await gitHubContextForWorkspace(ctx.db, ctx.workspaceId);
      const outcome = await runBackfill(
        ctx.db,
        { workspaceId: ctx.workspaceId, repositoryId: ctx.payload.repositoryId },
        {
          graphql: github.graphql,
          rateLimit: github.rateLimit,
          backfillWindowDays: github.sync.backfillWindowDays,
        },
      );
      ctx.log('backfill run', { ...outcome, repositoryId: ctx.payload.repositoryId });
    });
  },

  'repository.history_sync': async (ctx) => {
    await withInstallationHealth(ctx, async () => {
      const github = await gitHubContextForWorkspace(ctx.db, ctx.workspaceId);
      const outcome = await runHistorySync(
        ctx.db,
        {
          workspaceId: ctx.workspaceId,
          repositoryId: ctx.payload.repositoryId,
          from: ctx.payload.from ? new Date(ctx.payload.from) : null,
        },
        {
          graphql: github.graphql,
          rateLimit: github.rateLimit,
          pagesPerRun: github.sync.historyPagesPerRun,
        },
      );
      ctx.log('history sync run', { ...outcome, repositoryId: ctx.payload.repositoryId });
    });
  },

  'repository.incremental_sync': async (ctx) => {
    await withInstallationHealth(ctx, async () => {
      const github = await gitHubContextForWorkspace(ctx.db, ctx.workspaceId);
      const outcome = await runIncrementalSync(
        ctx.db,
        { workspaceId: ctx.workspaceId, repositoryId: ctx.payload.repositoryId },
        {
          rest: github.rest,
          rateLimit: github.rateLimit,
          overlapMinutes: github.sync.syncOverlapMinutes,
        },
      );
      ctx.log('incremental sync', {
        pullRequests: outcome.pullRequests,
        repositoryId: ctx.payload.repositoryId,
      });
    });
  },

  'repository.file_fill_in': async (ctx) => {
    await withInstallationHealth(ctx, async () => {
      const github = await gitHubContextForWorkspace(ctx.db, ctx.workspaceId);
      const outcome = await runFileFillIn(
        ctx.db,
        { workspaceId: ctx.workspaceId, repositoryId: ctx.payload.repositoryId },
        { graphql: github.graphql, rest: github.rest, rateLimit: github.rateLimit },
      );
      ctx.log('file fill-in', { ...outcome, repositoryId: ctx.payload.repositoryId });
    });
  },

  'repository.commit_sync': async (ctx) => {
    await withInstallationHealth(ctx, async () => {
      const github = await gitHubContextForWorkspace(ctx.db, ctx.workspaceId);
      const since = ctx.payload.since
        ? new Date(ctx.payload.since)
        : new Date(Date.now() - github.sync.backfillWindowDays * 24 * 3600_000);
      const outcome = await runDefaultBranchCommitSync(
        ctx.db,
        {
          workspaceId: ctx.workspaceId,
          repositoryId: ctx.payload.repositoryId,
          since,
          until: ctx.payload.until ? new Date(ctx.payload.until) : undefined,
          cursor: ctx.payload.cursor ?? null,
        },
        { graphql: github.graphql, rateLimit: github.rateLimit },
      );
      ctx.log('default-branch commit sync', {
        ...outcome,
        repositoryId: ctx.payload.repositoryId,
      });
    });
  },

  'workspace.schedule_syncs': async (ctx) => {
    const enqueued = await enqueueWorkspaceSyncs(ctx.db, ctx.workspaceId);
    // Commit activity and the file fill-in ride the same schedule at lower priority, so neither
    // can delay a repository's incremental sync (spec: "The fill-in pass competes with sync").
    const commitSyncs = await enqueueWorkspaceCommitSyncs(ctx.db, ctx.workspaceId, {
      windowDays: syncDefaults().backfillWindowDays,
    });
    const fillIns = await enqueueWorkspaceFileFillIn(ctx.db, ctx.workspaceId);
    ctx.log('workspace syncs enqueued', { enqueued, commitSyncs, fillIns });
  },

  'repository.reprocess': async (ctx) => {
    const outcome = await reprocessFromRaw(ctx.db, {
      workspaceId: ctx.workspaceId,
      repositoryId: ctx.payload.repositoryId,
    });
    ctx.log('reprocessed from raw', { ...outcome });
  },

  'pull_request.analyze': async (ctx) => {
    await ctx.db.transaction(async (tx) => {
      await analyzePullRequest(tx, ctx.payload.pullRequestId);
    });
  },

  'workspace.recompute_analysis': async (ctx) => {
    const outcome = await recomputeAnalysis(ctx.db, {
      workspaceId: ctx.workspaceId,
      repositoryId: ctx.payload.repositoryId,
      mergedAfter: ctx.payload.mergedAfter ? new Date(ctx.payload.mergedAfter) : undefined,
      mergedBefore: ctx.payload.mergedBefore ? new Date(ctx.payload.mergedBefore) : undefined,
    });
    ctx.log('analysis recomputed', { ...outcome });
  },

  /**
   * Classification runs at the lowest priority in the queue and never blocks anything. A provider
   * that is unreachable leaves the pull requests unclassified and eligible for a later run — the
   * job fails, the queue retries it, and no deterministic metric is affected either way.
   */
  'workspace.classify_pull_requests': async (ctx) => {
    const outcome = await startClassificationBatch(ctx.db, ctx.workspaceId, {
      provider: new AnthropicClassificationProvider(),
    });
    ctx.log('classification batch', { ...outcome });
  },

  'workspace.collect_classifications': async (ctx) => {
    const outcome = await collectClassificationBatch(
      ctx.db,
      ctx.workspaceId,
      ctx.payload.batchId,
      { provider: new AnthropicClassificationProvider() },
    );
    ctx.log('classifications collected', { ...outcome, batchId: ctx.payload.batchId });
  },

  'installation.reconcile_repositories': async (ctx) => {
    await withInstallationHealth(ctx, async () => {
      const installation = await findInstallationByWorkspace(ctx.db, ctx.workspaceId);
      if (!installation) throw new PermanentError('No installation for workspace');
      const config = loadConfig();
      const gateway = new GitHubInstallationGateway(tokenProvider(), config.github.apiBaseUrl);
      const repositories = await gateway.listRepositories(installation.githubInstallationId);
      const result = await reconcileRepositories(
        ctx.db,
        ctx.workspaceId,
        repositories.map(toRepositoryInput),
      );
      ctx.log('repository selection reconciled', {
        added: result.added.length,
        removed: result.removed.length,
      });
    });
  },
};
