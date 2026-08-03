/**
 * Per-class coverage (spec: github-data-sync "A repository records how far back its coverage
 * extends", design.md D5).
 *
 * Pull request coverage and file-level coverage move at different speeds, so a churn surface can
 * say "covered from" separately from the pull request coverage the surfaces already show. Every
 * class is read through this module; `repositories.history_covered_from` remains the pull request
 * class's own store and is mirrored into the table by the ingestion paths.
 */
import type { Queryable } from '../db/driver';

export const DATA_CLASSES = ['pull_requests', 'file_diffs', 'default_branch_commits'] as const;

export type DataClass = (typeof DATA_CLASSES)[number];

export interface CoverageRecord {
  repositoryId: string;
  dataClass: DataClass;
  coveredFrom: Date | null;
  complete: boolean;
}

/**
 * Extend a class's coverage backwards. Coverage never moves later: `LEAST` over a NULL column
 * yields NULL in Postgres, so the update is written as an explicit comparison instead.
 */
export async function recordCoverage(
  db: Queryable,
  input: {
    workspaceId: string;
    repositoryId: string;
    dataClass: DataClass;
    coveredFrom: Date | null;
    complete?: boolean;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO repository_coverage
       (workspace_id, repository_id, data_class, covered_from, complete)
     VALUES ($1, $2, $3, $4, COALESCE($5, false))
     ON CONFLICT (workspace_id, repository_id, data_class) DO UPDATE
       SET covered_from = CASE
             WHEN EXCLUDED.covered_from IS NULL THEN repository_coverage.covered_from
             WHEN repository_coverage.covered_from IS NULL THEN EXCLUDED.covered_from
             ELSE LEAST(repository_coverage.covered_from, EXCLUDED.covered_from)
           END,
           complete = repository_coverage.complete OR EXCLUDED.complete,
           updated_at = now()
     WHERE repository_coverage.covered_from IS DISTINCT FROM EXCLUDED.covered_from
        OR repository_coverage.complete IS DISTINCT FROM EXCLUDED.complete`,
    [
      input.workspaceId,
      input.repositoryId,
      input.dataClass,
      input.coveredFrom,
      input.complete ?? false,
    ],
  );
}

export async function listCoverage(
  db: Queryable,
  workspaceId: string,
  options: { dataClass?: DataClass; repositoryIds?: readonly string[] } = {},
): Promise<CoverageRecord[]> {
  const { rows } = await db.query<{
    repository_id: string;
    data_class: DataClass;
    covered_from: Date | null;
    complete: boolean;
  }>(
    `SELECT repository_id, data_class, covered_from, complete
       FROM repository_coverage
      WHERE workspace_id = $1
        AND ($2::text IS NULL OR data_class = $2)
        AND ($3::uuid[] IS NULL OR repository_id = ANY($3::uuid[]))`,
    [workspaceId, options.dataClass ?? null, options.repositoryIds ? [...options.repositoryIds] : null],
  );
  return rows.map((row) => ({
    repositoryId: row.repository_id,
    dataClass: row.data_class,
    coveredFrom: row.covered_from,
    complete: row.complete,
  }));
}

/**
 * The point from which a class is completely covered across the given repositories: the latest of
 * their coverage starts, since a period is only fully covered when every repository covers it. A
 * repository with no record at all bounds coverage at "unknown", which is reported as `null`
 * coverage together with `unknownRepositories` so a surface can say why rather than implying
 * completeness.
 */
export function coverageStart(
  records: readonly CoverageRecord[],
  repositoryIds: readonly string[],
): { start: Date | null; unknownRepositories: string[] } {
  const byRepository = new Map(records.map((record) => [record.repositoryId, record]));
  const unknown: string[] = [];
  let latest: Date | null = null;

  for (const repositoryId of repositoryIds) {
    const record = byRepository.get(repositoryId);
    if (!record || (record.coveredFrom === null && !record.complete)) {
      unknown.push(repositoryId);
      continue;
    }
    // A repository walked back to its first record bounds nothing.
    if (record.complete && record.coveredFrom === null) continue;
    if (record.coveredFrom !== null && (latest === null || record.coveredFrom > latest)) {
      latest = record.coveredFrom;
    }
  }

  return { start: latest, unknownRepositories: unknown };
}
