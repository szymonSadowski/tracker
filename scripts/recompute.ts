/**
 * Recompute analysis records from stored data — no GitHub requests.
 *
 *   npm run recompute -- --workspace <id> [--repository <id>] [--since 2026-01-01] [--stale-only]
 */
import { closeDatabase, db } from '../src/db/client';
import { recomputeAnalysis } from '../src/analysis/service';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const workspaceId = arg('workspace');
if (!workspaceId) {
  console.error(
    'Usage: npm run recompute -- --workspace <id> [--repository <id>] [--since <date>] ' +
      '[--until <date>] [--stale-only]',
  );
  process.exit(1);
}

try {
  const outcome = await recomputeAnalysis(db(), {
    workspaceId,
    repositoryId: arg('repository'),
    mergedAfter: arg('since') ? new Date(arg('since')!) : undefined,
    mergedBefore: arg('until') ? new Date(arg('until')!) : undefined,
    staleOnly: process.argv.includes('--stale-only'),
  });
  console.log(`Recomputed ${outcome.recomputed} analysis records`);
} finally {
  await closeDatabase();
}
