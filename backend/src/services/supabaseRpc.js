import { transaction } from '../database/config.js';

const RPC_FUNCTIONS = new Map([
  ['create_booking', 2],
  ['cancel_booking', 2],
  ['reschedule_booking', 2],
  ['promote_waitlist', 1],
  ['create_recurring_series', 5],
]);

export const usesSupabaseRpc = () => (process.env.BOOKING_ENGINE || 'javascript').toLowerCase() === 'sql_rpc';

/**
 * Execute a whitelisted SECURITY DEFINER RPC under the authenticated user's
 * Supabase JWT claim context. The user id is taken only from the verified
 * Supabase Auth middleware, never from request JSON.
 */
export async function callSupabaseRpc(functionName, args, actor) {
  if (!usesSupabaseRpc()) return { used: false, result: null };
  const expectedArgs = RPC_FUNCTIONS.get(functionName);
  if (!expectedArgs || args.length !== expectedArgs) throw new Error(`Unregistered Supabase RPC: ${functionName}`);
  if (!actor?.id) {
    const error = new Error('BOOKING_ENGINE=sql_rpc requires a verified Supabase-authenticated user.');
    error.status = 401;
    throw error;
  }

  const claims = JSON.stringify({ sub: actor.id, role: 'authenticated', aud: 'authenticated' });
  const result = await transaction(async client => {
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [actor.id, claims]);
    const castArgs = args.map((_, index) => {
      if ((functionName === 'create_booking' && index === 0) || (functionName === 'reschedule_booking' && index === 1) || (functionName === 'create_recurring_series' && index === 0)) return `$${index + 1}::jsonb`;
      if (functionName === 'cancel_booking' && index === 0) return `$${index + 1}::integer`;
      if (functionName === 'cancel_booking' && index === 1) return `$${index + 1}::text`;
      if (functionName === 'reschedule_booking' && index === 0) return `$${index + 1}::integer`;
      if (functionName === 'create_booking' && index === 1) return `$${index + 1}::text`;
      if (functionName === 'promote_waitlist') return `$${index + 1}::date`;
      if (functionName === 'create_recurring_series') return `$${index + 1}::${['jsonb', 'integer', 'integer', 'boolean', 'text'][index]}`;
      return `$${index + 1}`;
    });
    // The function name and casts come exclusively from the whitelist above.
    const sql = `SELECT public.${functionName}(${castArgs.join(', ')}) AS result`;
    const response = await client.query(sql, args);
    return response.rows[0]?.result ?? null;
  });
  return { used: true, result };
}
