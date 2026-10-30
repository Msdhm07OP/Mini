import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const { Pool } = pg;
// PostgreSQL DATE has no time zone. Preserve it as YYYY-MM-DD instead of
// converting it to a JavaScript Date that can shift the calendar day.
pg.types.setTypeParser(1082, value => value);

// Supabase and other hosted PostgreSQL providers require TLS even while the
// application itself runs in development. Local PostgreSQL can explicitly opt out.
const databaseUrl = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
const hostedPostgres = /supabase\.(co|com)|pooler\.supabase\.com/i.test(databaseUrl || '');
const sslEnabled = process.env.DB_SSL === 'false'
  ? false
  : (process.env.DB_SSL === 'true' || process.env.NODE_ENV === 'production' || hostedPostgres);

const dbConfig = {
  connectionString: databaseUrl,
  ssl: sslEnabled ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false,
  min: parseInt(process.env.DB_POOL_MIN || '2', 10),
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || '30000', 10),
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '10000', 10),
  // Important for concurrency handling
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT || '30000', 10),
};

// Create connection pool
const pool = new Pool(dbConfig);

// Pool error handling
pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

pool.on('connect', (client) => {
  // Set session-level parameters for consistency
  client.query(`
    SET timezone = 'UTC';
    SET lock_timeout = '${process.env.BOOKING_LOCK_TIMEOUT_MS || 15000}ms';
  `).catch(err => console.error('Error setting session parameters:', err));
});

/**
 * Execute a query
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} Query result
 */
export async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;

    if (duration > 1000) {
      console.warn('Slow query detected', {
        text: text.substring(0, 100),
        duration,
        rows: result.rowCount
      });
    }

    return result;
  } catch (error) {
    console.error('Database query error', {
      text: text.substring(0, 100),
      error: error.message
    });
    throw error;
  }
}

/**
 * Get a client from the pool for transactions
 * @returns {Promise<Object>} Database client
 */
export async function getClient() {
  return await pool.connect();
}

/**
 * Execute a function within a transaction
 * @param {Function} callback - Function to execute in transaction
 * @param {Object} options - Transaction options
 * @returns {Promise<any>} Result of callback
 */
export async function transaction(callback, options = {}) {
  const client = await pool.connect();

  try {
    // Set transaction isolation level
    const isolationLevel = options.isolationLevel || 'READ COMMITTED';
    await client.query('BEGIN');
    await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);

    const result = await callback(client);

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Execute a function with automatic retry on serialization failure
 * @param {Function} callback - Function to execute
 * @param {Object} options - Retry options
 * @returns {Promise<any>} Result of callback
 */
export async function withRetry(callback, options = {}) {
  const maxRetries = options.maxRetries || parseInt(process.env.BOOKING_MAX_RETRIES || '3', 10);
  const baseDelay = options.baseDelay || parseInt(process.env.BOOKING_RETRY_DELAY_MS || '100', 10);

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;

      // Retry on serialization failures or deadlocks
      const shouldRetry =
        error.code === '40001' || // serialization_failure
        error.code === '40P01' || // deadlock_detected
        error.code === '55P03';   // lock_not_available

      if (!shouldRetry || attempt === maxRetries) {
        break;
      }

      // Exponential backoff with jitter
      const delay = baseDelay * Math.pow(2, attempt) * (1 + Math.random() * 0.1);
      await new Promise(resolve => setTimeout(resolve, delay));

      console.warn(`Retrying transaction (attempt ${attempt + 1}/${maxRetries})`, {
        error: error.message,
        code: error.code
      });
    }
  }

  throw lastError;
}

/**
 * Check database health
 * @returns {Promise<Object>} Health status
 */
export async function checkHealth() {
  try {
    const result = await pool.query('SELECT NOW() as time, version() as version');
    return {
      healthy: true,
      timestamp: result.rows[0].time,
      version: result.rows[0].version,
      poolSize: pool.totalCount,
      idleConnections: pool.idleCount,
      waitingClients: pool.waitingCount
    };
  } catch (error) {
    return {
      healthy: false,
      error: error.message
    };
  }
}

/**
 * Close all database connections
 * @returns {Promise<void>}
 */
export async function closePool() {
  await pool.end();
  console.log('Database pool closed');
}

export default pool;
