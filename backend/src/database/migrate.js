import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, getClient } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Create migrations tracking table
 */
async function createMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      version VARCHAR(255) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * Get applied migrations
 */
async function getAppliedMigrations() {
  try {
    const result = await query('SELECT version FROM schema_migrations ORDER BY version');
    return result.rows.map(row => row.version);
  } catch (error) {
    if (error.code === '42P01') { // table does not exist
      return [];
    }
    throw error;
  }
}

/**
 * Get pending migrations
 */
async function getPendingMigrations() {
  const files = await fs.readdir(MIGRATIONS_DIR);
  const migrationFiles = files
    .filter(f => f.endsWith('.sql'))
    .sort();

  const applied = await getAppliedMigrations();
  const appliedSet = new Set(applied);

  return migrationFiles
    .map(f => {
      const version = f.replace('.sql', '');
      return {
        version,
        filename: f,
        filepath: path.join(MIGRATIONS_DIR, f),
        applied: appliedSet.has(version)
      };
    })
    .filter(m => !m.applied);
}

/**
 * Apply a single migration
 */
async function applyMigration(migration) {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    console.log(`Applying migration: ${migration.version}`);

    // Read and execute migration SQL
    const sql = await fs.readFile(migration.filepath, 'utf-8');
    await client.query(sql);

    // Record migration
    await client.query(
      'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
      [migration.version, migration.version]
    );

    await client.query('COMMIT');
    console.log(`✓ Migration ${migration.version} applied successfully`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`✗ Migration ${migration.version} failed:`, error.message);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run all pending migrations
 */
async function migrate() {
  try {
    console.log('Starting database migration...\n');

    await createMigrationsTable();

    const pending = await getPendingMigrations();

    if (pending.length === 0) {
      console.log('No pending migrations');
      return;
    }

    console.log(`Found ${pending.length} pending migration(s):\n`);

    for (const migration of pending) {
      await applyMigration(migration);
    }

    console.log('\n✓ All migrations completed successfully');
  } catch (error) {
    console.error('\n✗ Migration failed:', error);
    process.exit(1);
  }
}

/**
 * Rollback last migration
 */
async function rollback() {
  try {
    console.log('Rolling back last migration...\n');

    const applied = await getAppliedMigrations();

    if (applied.length === 0) {
      console.log('No migrations to rollback');
      return;
    }

    const lastMigration = applied[applied.length - 1];
    console.log(`WARNING: Rolling back ${lastMigration}`);
    console.log('This operation is destructive and may result in data loss!');
    console.log('Rollback functionality requires manual SQL scripts.');
    console.log('Please create a rollback script or reset the database.');

    // For safety, we don't auto-rollback without explicit rollback scripts
    // In production, you'd have separate rollback SQL files

  } catch (error) {
    console.error('Rollback failed:', error);
    process.exit(1);
  }
}

/**
 * Show migration status
 */
async function status() {
  try {
    await createMigrationsTable();

    const files = await fs.readdir(MIGRATIONS_DIR);
    const migrationFiles = files.filter(f => f.endsWith('.sql')).sort();

    const applied = await getAppliedMigrations();
    const appliedSet = new Set(applied);

    console.log('Migration Status:\n');
    console.log('Version'.padEnd(30), 'Status'.padEnd(15), 'Applied At');
    console.log('-'.repeat(70));

    for (const file of migrationFiles) {
      const version = file.replace('.sql', '');
      const isApplied = appliedSet.has(version);

      if (isApplied) {
        const result = await query(
          'SELECT applied_at FROM schema_migrations WHERE version = $1',
          [version]
        );
        const appliedAt = result.rows[0]?.applied_at || 'Unknown';
        console.log(version.padEnd(30), '✓ Applied'.padEnd(15), appliedAt);
      } else {
        console.log(version.padEnd(30), '○ Pending'.padEnd(15), '-');
      }
    }

    console.log('\n');
  } catch (error) {
    console.error('Failed to check migration status:', error);
    process.exit(1);
  }
}

// CLI handling
const command = process.argv[2];

switch (command) {
  case 'rollback':
    rollback().then(() => process.exit(0));
    break;
  case 'status':
    status().then(() => process.exit(0));
    break;
  default:
    migrate().then(() => process.exit(0));
}
