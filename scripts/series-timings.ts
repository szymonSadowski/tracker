/**
 * Measure the on-read rollup query (design.md D3).
 *
 * D3 keeps aggregation on-read and names the point at which that stops being the right trade:
 * when a 90-bucket daily series exceeds ~200ms at p95. This script is how we know whether we have
 * crossed it, rather than guessing. It seeds synthetic analysis rows at a few representative
 * volumes and times the query the charts actually issue.
 *
 *   npx tsx scripts/series-timings.ts [--rows 1000,10000,50000] [--samples 20]
 *
 * With no DATABASE_URL it runs against the embedded Postgres the test suite uses, which is the
 * same engine but not the same hardware — treat those numbers as a floor, and re-run against a
 * production-shaped server before acting on them.
 */
import { migrate } from '../src/db/migrate';
import { PostgresDatabase } from '../src/db/pg';
import { PGliteDatabase } from '../tests/helpers/pglite';
import type { Database } from '../src/db/driver';
import { workspaceScope } from '../src/db/scope';
import { metricSeries } from '../src/analysis/series';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const rowCounts = (arg('rows') ?? '1000,10000,50000').split(',').map(Number);
const samples = Number(arg('samples') ?? 20);
const END = new Date('2026-08-01T00:00:00Z');
const START = new Date(END.getTime() - 90 * 86_400_000);

async function seed(database: Database, rows: number) {
  const workspace = await database.query<{ id: string }>(
    `INSERT INTO workspaces (name, account_node_id, account_login, account_type)
     VALUES ('bench', 'O_bench_' || gen_random_uuid(), 'bench', 'Organization') RETURNING id`,
  );
  const workspaceId = workspace.rows[0]!.id;
  const repository = await database.query<{ id: string }>(
    `INSERT INTO repositories (workspace_id, node_id, owner_login, name, full_name)
     VALUES ($1, 'R_' || gen_random_uuid(), 'bench', 'api', 'bench/api') RETURNING id`,
    [workspaceId],
  );
  const repositoryId = repository.rows[0]!.id;

  // 20 contributors, pull requests spread evenly over the 90 days.
  await database.query(
    `INSERT INTO contributors (workspace_id, node_id, login)
     SELECT $1, 'U_' || g, 'dev-' || g FROM generate_series(1, 20) g`,
    [workspaceId],
  );
  await database.query(
    `INSERT INTO workspace_memberships (workspace_id, contributor_id, started_at)
     SELECT $1, id, $2 FROM contributors WHERE workspace_id = $1`,
    [workspaceId, START],
  );
  await database.query(
    `INSERT INTO pull_requests
       (workspace_id, repository_id, node_id, number, state, opened_at, ready_for_review_at,
        merged_at, github_updated_at, additions, deletions, changed_files, files_ingested_at)
     SELECT $1, $2, 'PR_' || g, g, 'merged',
            $3::timestamptz + (g % 90) * INTERVAL '1 day',
            $3::timestamptz + (g % 90) * INTERVAL '1 day',
            $3::timestamptz + (g % 90) * INTERVAL '1 day' + INTERVAL '6 hours',
            $3::timestamptz + (g % 90) * INTERVAL '1 day',
            100, 40, 5, now()
       FROM generate_series(1, $4) g`,
    [workspaceId, repositoryId, START, rows],
  );
  await database.query(
    `INSERT INTO pr_analysis
       (workspace_id, pull_request_id, repository_id, cycle_time_seconds, coding_time_seconds,
        pickup_time_seconds, review_time_seconds, time_to_first_review_seconds,
        time_to_approval_seconds, time_to_merge_after_approval_seconds, review_cycles,
        additions, deletions, files_changed, size_bucket, author_contributor_id, author_is_bot,
        merged_at, opened_at, ready_for_review_at, pr_state, computed_version,
        new_code_lines, refactor_lines, rework_lines, excluded_lines, review_depth, pr_maturity)
     SELECT pr.workspace_id, pr.id, pr.repository_id, 21600, 7200, 3600, 10800, 3600, 5400, 1800, 2,
            pr.additions, pr.deletions, pr.changed_files, 'm',
            (SELECT id FROM contributors WHERE workspace_id = pr.workspace_id
              ORDER BY node_id LIMIT 1 OFFSET (pr.number % 20)),
            false, pr.merged_at, pr.opened_at, pr.ready_for_review_at, 'merged', 2,
            60, 30, 10, 5, 3, 0.8
       FROM pull_requests pr WHERE pr.workspace_id = $1`,
    [workspaceId],
  );

  return { workspaceId, repositoryId };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

async function main() {
  const url = process.env.DATABASE_URL;
  const database: Database = url ? new PostgresDatabase(url) : await PGliteDatabase.create();
  await migrate(database);

  console.log(`engine: ${url ? 'postgres' : 'pglite (embedded)'}  samples: ${samples}`);
  console.log('rows\tp50 ms\tp95 ms\tmax ms');

  for (const rows of rowCounts) {
    const { workspaceId, repositoryId } = await seed(database, rows);
    const scope = workspaceScope(database, workspaceId);
    const filter = {
      period: { start: START, end: END, label: '90 days' },
      repositoryIds: [repositoryId],
    };

    const timings: number[] = [];
    for (let i = 0; i < samples; i++) {
      const started = performance.now();
      await metricSeries(scope, filter, { granularity: 'day' });
      timings.push(performance.now() - started);
    }

    console.log(
      `${rows}\t${percentile(timings, 0.5).toFixed(1)}\t` +
        `${percentile(timings, 0.95).toFixed(1)}\t${Math.max(...timings).toFixed(1)}`,
    );
  }

  await database.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
