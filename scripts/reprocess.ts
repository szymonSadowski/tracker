/**
 * Rebuild normalized records from retained raw payloads.
 *
 *   npm run reprocess -- --workspace <id> [--repository <id>]
 */
import { closeDatabase, db } from '../src/db/client';
import { reprocessFromRaw } from '../src/ingest/reprocess';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const workspaceId = arg('workspace');
if (!workspaceId) {
  console.error('Usage: npm run reprocess -- --workspace <id> [--repository <id>]');
  process.exit(1);
}

try {
  const outcome = await reprocessFromRaw(db(), {
    workspaceId,
    repositoryId: arg('repository'),
  });
  console.log(`Reprocessed ${outcome.pullRequests} pull requests (${outcome.skipped} skipped)`);
} finally {
  await closeDatabase();
}
