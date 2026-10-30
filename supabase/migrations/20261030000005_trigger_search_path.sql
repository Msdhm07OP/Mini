-- The booking RPCs run with search_path = '' and fire these trigger functions,
-- which reference tables without a schema prefix. Pin their search_path so
-- unqualified names resolve to public regardless of the caller's path.
ALTER FUNCTION public.log_booking_status_change() SET search_path = public, pg_temp;
ALTER FUNCTION public.ensure_event_order_for_confirmed_booking() SET search_path = public, pg_temp;
ALTER FUNCTION public.update_updated_at_column() SET search_path = public, pg_temp;
ALTER FUNCTION public.set_event_order_updated_at() SET search_path = public, pg_temp;
