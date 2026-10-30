import dotenv from 'dotenv';
import path from 'node:path';

// Run this entrypoint from the backend directory. It intentionally refuses to
// launch unless an explicit test DB is configured, to avoid stress-testing real data.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
if (!process.env.TEST_DATABASE_URL) {
  console.error('Refusing to start: set TEST_DATABASE_URL to a dedicated disposable PostgreSQL database.');
  process.exit(1);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
await import('../server.js');
