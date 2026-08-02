import { PostgresDatabase } from '../src/db/pg';
import { migrate } from '../src/db/migrate';

const url = process.env.DATABASE_URL;
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
