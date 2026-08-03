import { PostgresDatabase } from '../src/db/pg';
import { directDatabaseUrl } from '../src/db/client';
import { migrate } from '../src/db/migrate';

// Schema changes prefer a direct connection. A transaction pooler will usually carry them — each
// migration is one transaction with no session state — but it is the wrong tool for DDL, and the
// failure would land mid-release. Falls back to DATABASE_URL where there is only one endpoint.
const url = directDatabaseUrl() ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const database = new PostgresDatabase(url);
try {
  const ran = await migrate(database);
  console.log(ran.length ? `Applied:\n  ${ran.join('\n  ')}` : 'Schema already up to date');
} finally {
  await database.close();
}
