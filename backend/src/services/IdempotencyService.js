import crypto from 'crypto';
import { query } from '../database/config.js';
import logger from '../utils/logger/index.js';

function stableStringify(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

class IdempotencyService {
  hashRequest(requestBody) {
    return crypto.createHash('sha256').update(stableStringify(requestBody)).digest('hex');
  }

  async acquireKeyLock(client, key) {
    // Transaction-scoped lock serializes requests that reuse the same key.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('eventsync-idempotency:' || $1, 0))",
      [key]
    );
  }

  async checkIdempotencyKey(key, requestBody, client = null) {
    if (!key) return { isDuplicate: false };
    const runner = client || { query };
    const requestHash = this.hashRequest(requestBody);

    // Expired keys are eligible for reuse. Remove while holding the transactional
    // key lock when called from the booking transaction.
    if (client) {
      await client.query(
        'DELETE FROM idempotency_records WHERE idempotency_key = $1 AND expires_at <= NOW()',
        [key]
      );
    }

    const result = await runner.query(
      'SELECT request_hash, response_data FROM idempotency_records WHERE idempotency_key = $1 AND expires_at > NOW()',
      [key]
    );
    if (result.rows.length === 0) return { isDuplicate: false, requestHash };

    const record = result.rows[0];
    if (record.request_hash !== requestHash) {
      const error = new Error('Idempotency key already used with a different request payload');
      error.status = 409;
      error.code = 'IDEMPOTENCY_KEY_REUSE';
      throw error;
    }
    logger.info('Idempotent booking retry detected', { idempotencyKey: key });
    return { isDuplicate: true, cachedResponse: record.response_data, requestHash };
  }

  async storeResult(key, requestBody, bookingId, response, client = null) {
    if (!key) return;
    const requestHash = this.hashRequest(requestBody);
    const expiresAt = new Date(Date.now() + Number(process.env.IDEMPOTENCY_KEY_EXPIRY_HOURS || 24) * 60 * 60 * 1000);

    const sql = `
      INSERT INTO idempotency_records (idempotency_key, request_hash, booking_id, response_data, expires_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (idempotency_key) DO UPDATE
      SET request_hash = EXCLUDED.request_hash,
          booking_id = EXCLUDED.booking_id,
          response_data = EXCLUDED.response_data,
          created_at = NOW(),
          expires_at = EXCLUDED.expires_at
      WHERE idempotency_records.expires_at <= NOW()
      RETURNING id
    `;
    const args = [key, requestHash, bookingId ?? null, JSON.stringify(response), expiresAt];
    if (client) {
      const result = await client.query(sql, args);
      if (!result.rowCount) {
        const error = new Error('Could not persist idempotency result; the key is already in use');
        error.status = 409;
        throw error;
      }
      return;
    }

    // Compatibility path for callers outside a booking transaction. A DB error
    // must not be silently treated as a successful idempotency write.
    await query(sql, args);
  }

  async cleanupExpired() {
    const result = await query('DELETE FROM idempotency_records WHERE expires_at < NOW()');
    return result.rowCount;
  }
}

export default new IdempotencyService();
