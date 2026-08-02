/** Drop and recreate the public schema, then migrate. Local development only. */
import { PostgresDatabase } from '../src/db/pg';
import { migrate } from '../src/db/migrate';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to reset the database in production');
  process.exit(1);
}

const database = new PostgresDatabase(url);
try {
  await database.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const ran = await migrate(database);
  console.log(`Reset. Applied ${ran.length} migrations.`);
} finally {
  await database.close();
}
