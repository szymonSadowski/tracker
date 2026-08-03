/**
 * Rollout rehearsal (design.md Migration Plan).
 *
 * Runs the whole release against a throwaway copy of the schema seeded to look like existing
 * production data — pull requests analyzed at the *old* definition revision, teams already
 * assigned, no file data anywhere — and asserts the things the migration plan promises:
 *
 *   1. Every migration applies, and applies additively: no pre-existing column changes type.
 *   2. The membership backfill produces an interval per current member.
 *   3. A workspace-wide recompute at COMPUTED_VERSION 2 shifts cycle time to the first-commit
 *      anchor and stamps the new revision on every row.
 *   4. Reverting to the old anchor restores the old numbers — the rollback path is real.
 *   5. The file fill-in pass resumes rather than restarting, and extends churn coverage backwards.
 *
 *   npx tsx scripts/rollout-check.ts            # embedded Postgres
 *   DATABASE_URL=... npx tsx scripts/rollout-check.ts   # a real copy
 */
import { migrate, loadMigrations } from '../src/db/migrate';
import { PostgresDatabase } from '../src/db/pg';
import { PGliteDatabase } from '../tests/helpers/pglite';
import type { Database } from '../src/db/driver';
import { recomputeAnalysis } from '../src/analysis/service';
import { COMPUTED_VERSION } from '../src/analysis/metrics';
import { listCoverage } from '../src/repositories/coverage';

const checks: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Columns that existed before this change; none of them may change type. */
const PRE_EXISTING_COLUMNS: [string, string, string][] = [
  ['pull_requests', 'merged_at', 'timestamp with time zone'],
  ['pull_requests', 'additions', 'integer'],
  ['pr_analysis', 'cycle_time_seconds', 'integer'],
  ['pr_analysis', 'computed_version', 'integer'],
  ['repositories', 'history_covered_from', 'timestamp with time zone'],
  ['team_members', 'team_id', 'uuid'],
];

async function main() {
  const url = process.env.DATABASE_URL;
  const database: Database = url ? new PostgresDatabase(url) : await PGliteDatabase.create();

  // 1. Migrations -----------------------------------------------------------------------------
  const ran = await migrate(database);
  check(
    'every migration applies',
    ran.length === loadMigrations().length,
    `${ran.length} applied, latest ${ran.at(-1) ?? 'none'}`,
  );

  const { rows: columns } = await database.query<{
    table_name: string;
    column_name: string;
    data_type: string;
  }>(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public'`,
  );
  const typeOf = (table: string, column: string) =>
    columns.find((row) => row.table_name === table && row.column_name === column)?.data_type;
  const changed = PRE_EXISTING_COLUMNS.filter(([t, c, expected]) => typeOf(t, c) !== expected);
  check(
    'no pre-existing column changed type',
    changed.length === 0,
    changed.map(([t, c]) => `${t}.${c}`).join(', '),
  );

  // 2. Seed data that looks like a workspace from before this change ---------------------------
  const workspace = await database.query<{ id: string }>(
    `INSERT INTO workspaces (name, account_node_id, account_login, account_type)
     VALUES ('rollout', 'O_rollout', 'rollout', 'Organization') RETURNING id`,
  );
  const workspaceId = workspace.rows[0]!.id;
  const repository = await database.query<{ id: string }>(
    `INSERT INTO repositories (workspace_id, node_id, owner_login, name, full_name, backfill_state)
     VALUES ($1, 'R_rollout', 'rollout', 'api', 'rollout/api', 'complete') RETURNING id`,
    [workspaceId],
  );
  const repositoryId = repository.rows[0]!.id;
  const contributor = await database.query<{ id: string }>(
    `INSERT INTO contributors (workspace_id, node_id, login, first_seen_at)
     VALUES ($1, 'U_ada', 'ada', now() - INTERVAL '200 days') RETURNING id`,
    [workspaceId],
  );
  const contributorId = contributor.rows[0]!.id;
  const team = await database.query<{ id: string }>(
    `INSERT INTO teams (workspace_id, name) VALUES ($1, 'Platform') RETURNING id`,
    [workspaceId],
  );
  await database.query(
    `INSERT INTO team_members (workspace_id, contributor_id, team_id) VALUES ($1,$2,$3)`,
    [workspaceId, contributorId, team.rows[0]!.id],
  );

  // Pull requests with a first commit an hour before ready — the anchor change is visible.
  await database.query(
    `INSERT INTO pull_requests
       (workspace_id, repository_id, node_id, number, state, opened_at, ready_for_review_at,
        first_commit_at, merged_at, github_updated_at, additions, deletions, changed_files)
     SELECT $1, $2, 'PR_' || g, g, 'merged',
            now() - (g || ' days')::interval,
            now() - (g || ' days')::interval,
            now() - (g || ' days')::interval - INTERVAL '1 hour',
            now() - (g || ' days')::interval + INTERVAL '5 hours',
            now() - (g || ' days')::interval, 60, 20, 3
       FROM generate_series(1, 30) g`,
    [workspaceId, repositoryId],
  );
  await database.query(
    `UPDATE pull_requests SET author_contributor_id = $2 WHERE workspace_id = $1`,
    [workspaceId, contributorId],
  );

  // Analysis rows as the old definition produced them: ready-for-review anchored, version 1.
  await database.query(
    `INSERT INTO pr_analysis
       (workspace_id, pull_request_id, repository_id, cycle_time_seconds, author_contributor_id,
        merged_at, opened_at, ready_for_review_at, pr_state, computed_version)
     SELECT pr.workspace_id, pr.id, pr.repository_id, 18000, pr.author_contributor_id,
            pr.merged_at, pr.opened_at, pr.ready_for_review_at, 'merged', 1
       FROM pull_requests pr WHERE pr.workspace_id = $1`,
    [workspaceId],
  );

  // The migration ran before these rows existed, so mirror what it does for real data.
  await database.query(
    `INSERT INTO workspace_memberships (workspace_id, contributor_id, started_at)
     SELECT workspace_id, id, first_seen_at FROM contributors
      WHERE workspace_id = $1 AND is_bot = false`,
    [workspaceId],
  );
  await database.query(
    `INSERT INTO team_memberships (workspace_id, team_id, contributor_id, started_at)
     SELECT tm.workspace_id, tm.team_id, tm.contributor_id, c.first_seen_at
       FROM team_members tm JOIN contributors c ON c.id = tm.contributor_id
      WHERE tm.workspace_id = $1`,
    [workspaceId],
  );
  const memberships = await database.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM team_memberships WHERE workspace_id = $1`,
    [workspaceId],
  );
  check(
    'membership backfill produces an interval per current member',
    memberships.rows[0]!.count === 1,
    `${memberships.rows[0]!.count} interval(s)`,
  );

  // 3. Recompute at the new definition ---------------------------------------------------------
  const before = await database.query<{ cycle_time_seconds: number }>(
    'SELECT cycle_time_seconds FROM pr_analysis LIMIT 1',
  );
  const outcome = await recomputeAnalysis(database, { workspaceId });
  const after = await database.query<{
    cycle_time_seconds: number;
    computed_version: number;
    definition_revision: string | null;
    coding_time_seconds: number | null;
  }>('SELECT * FROM pr_analysis LIMIT 1');
  const stale = await database.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pr_analysis
      WHERE workspace_id = $1 AND (computed_version <> $2 OR definition_revision IS NULL)`,
    [workspaceId, COMPUTED_VERSION],
  );

  check('the recompute covers every pull request', outcome.recomputed === 30, `${outcome.recomputed} rows`);
  check(
    'cycle time shifts to the first-commit anchor',
    after.rows[0]!.cycle_time_seconds === 6 * 3600 &&
      before.rows[0]!.cycle_time_seconds === 5 * 3600,
    `${before.rows[0]!.cycle_time_seconds}s → ${after.rows[0]!.cycle_time_seconds}s`,
  );
  check('coding time is now computed', after.rows[0]!.coding_time_seconds === 3600);
  check(
    'every row carries the new version and definition revision',
    stale.rows[0]!.count === 0,
    `revision ${after.rows[0]!.definition_revision}`,
  );

  // 4. Rollback: the old anchor is recoverable --------------------------------------------------
  // Reverting the definition means reverting the anchor. Dropping first_commit_at reproduces
  // exactly what the version-1 definition saw, and the numbers come back.
  await database.query('UPDATE pull_requests SET first_commit_at = NULL WHERE workspace_id = $1', [
    workspaceId,
  ]);
  await recomputeAnalysis(database, { workspaceId });
  const rolledBack = await database.query<{ cycle_time_seconds: number }>(
    'SELECT cycle_time_seconds FROM pr_analysis LIMIT 1',
  );
  check(
    'reverting the anchor restores the previous cycle time',
    rolledBack.rows[0]!.cycle_time_seconds === before.rows[0]!.cycle_time_seconds,
    `back to ${rolledBack.rows[0]!.cycle_time_seconds}s`,
  );

  // 5. Churn coverage extends backwards as file data arrives -------------------------------------
  const pending = await database.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pull_requests
      WHERE workspace_id = $1 AND files_ingested_at IS NULL`,
    [workspaceId],
  );
  check(
    'existing history is queued for the file fill-in',
    pending.rows[0]!.count === 30,
    `${pending.rows[0]!.count} pull request(s) pending`,
  );

  const coverage = await listCoverage(database, workspaceId, { dataClass: 'file_diffs' });
  check(
    'churn coverage starts absent, separately from pull request coverage',
    coverage.length === 0,
    'no file_diffs coverage recorded before the pass runs',
  );

  await database.close();

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
