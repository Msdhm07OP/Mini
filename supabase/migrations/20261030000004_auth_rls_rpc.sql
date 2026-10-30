-- EventSync 3.0: Supabase identity, least-privilege RLS, and transactional RPC entry points.
-- Apply only after migrations 00001-00003. Existing browser/API clients must use a Supabase Auth JWT.

ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_auth_user_fk
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.events_sync_touch_profile()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id, role, display_name)
  VALUES (
    NEW.id,
    'client',
    COALESCE(NEW.raw_user_meta_data ->> 'display_name', NEW.raw_user_meta_data ->> 'full_name', split_part(COALESCE(NEW.email, ''), '@', 1))
  )
  ON CONFLICT (user_id) DO UPDATE
    SET display_name = COALESCE(public.user_profiles.display_name, EXCLUDED.display_name),
        updated_at = NOW();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_auth_user_created_events_sync ON auth.users;
CREATE TRIGGER on_auth_user_created_events_sync
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.events_sync_touch_profile();

CREATE OR REPLACE FUNCTION public.eventsync_role()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT up.role FROM public.user_profiles up WHERE up.user_id = auth.uid()
$$;
CREATE OR REPLACE FUNCTION public.eventsync_is_staff()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE(public.eventsync_role() IN ('admin', 'manager', 'staff'), false)
$$;
CREATE OR REPLACE FUNCTION public.eventsync_is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE(public.eventsync_role() = 'admin', false)
$$;
CREATE OR REPLACE FUNCTION public.eventsync_client_id()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT up.client_id FROM public.user_profiles up WHERE up.user_id = auth.uid()
$$;

-- Keep authorization helpers unavailable to anonymous callers. RLS policies execute as
-- the authenticated caller, so grant only the minimum helper execution they require.
REVOKE ALL ON FUNCTION public.eventsync_role() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.eventsync_is_staff() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.eventsync_is_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.eventsync_client_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.eventsync_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.eventsync_is_staff() TO authenticated;
GRANT EXECUTE ON FUNCTION public.eventsync_is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.eventsync_client_id() TO authenticated;

-- RLS is a second boundary for direct Supabase Data API access. The Express API additionally
-- verifies tokens/roles; do not put a service-role key in the frontend.
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.venues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.halls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.venue_resource_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_resource_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_profiles_select_self_or_admin ON public.user_profiles;
CREATE POLICY user_profiles_select_self_or_admin ON public.user_profiles
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.eventsync_is_admin());
DROP POLICY IF EXISTS user_profiles_admin_manage ON public.user_profiles;
CREATE POLICY user_profiles_admin_manage ON public.user_profiles
  FOR ALL TO authenticated USING (public.eventsync_is_admin()) WITH CHECK (public.eventsync_is_admin());

DROP POLICY IF EXISTS venues_read_authenticated ON public.venues;
CREATE POLICY venues_read_authenticated ON public.venues FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS venues_admin_write ON public.venues;
CREATE POLICY venues_admin_write ON public.venues FOR ALL TO authenticated USING (public.eventsync_is_admin()) WITH CHECK (public.eventsync_is_admin());

DROP POLICY IF EXISTS halls_read_authenticated ON public.halls;
CREATE POLICY halls_read_authenticated ON public.halls FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS halls_admin_write ON public.halls;
CREATE POLICY halls_admin_write ON public.halls FOR ALL TO authenticated USING (public.eventsync_is_admin()) WITH CHECK (public.eventsync_is_admin());

DROP POLICY IF EXISTS resource_types_read_authenticated ON public.resource_types;
CREATE POLICY resource_types_read_authenticated ON public.resource_types FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS resource_types_admin_write ON public.resource_types;
CREATE POLICY resource_types_admin_write ON public.resource_types FOR ALL TO authenticated USING (public.eventsync_is_admin()) WITH CHECK (public.eventsync_is_admin());

DROP POLICY IF EXISTS venue_resource_capacity_read_authenticated ON public.venue_resource_capacity;
CREATE POLICY venue_resource_capacity_read_authenticated ON public.venue_resource_capacity FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS venue_resource_capacity_admin_write ON public.venue_resource_capacity;
CREATE POLICY venue_resource_capacity_admin_write ON public.venue_resource_capacity FOR ALL TO authenticated USING (public.eventsync_is_admin()) WITH CHECK (public.eventsync_is_admin());

DROP POLICY IF EXISTS clients_staff_manage ON public.clients;
DROP POLICY IF EXISTS clients_manager_manage ON public.clients;
CREATE POLICY clients_manager_manage ON public.clients FOR ALL TO authenticated
  USING (public.eventsync_role() IN ('admin', 'manager'))
  WITH CHECK (public.eventsync_role() IN ('admin', 'manager'));
DROP POLICY IF EXISTS clients_read_self ON public.clients;
CREATE POLICY clients_read_self ON public.clients FOR SELECT TO authenticated USING (id = public.eventsync_client_id());

DROP POLICY IF EXISTS bookings_staff_read ON public.bookings;
CREATE POLICY bookings_staff_read ON public.bookings FOR SELECT TO authenticated USING (public.eventsync_is_staff());
DROP POLICY IF EXISTS bookings_client_read_own ON public.bookings;
CREATE POLICY bookings_client_read_own ON public.bookings FOR SELECT TO authenticated USING (client_id = public.eventsync_client_id());
-- Mutations must pass through the transactional RPC functions below; no direct table writes.
DROP POLICY IF EXISTS booking_allocations_staff_read ON public.booking_resource_allocations;
CREATE POLICY booking_allocations_staff_read ON public.booking_resource_allocations
  FOR SELECT TO authenticated USING (public.eventsync_is_staff());
DROP POLICY IF EXISTS booking_allocations_client_read_own ON public.booking_resource_allocations;
CREATE POLICY booking_allocations_client_read_own ON public.booking_resource_allocations
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.bookings b WHERE b.id = booking_id AND b.client_id = public.eventsync_client_id()
  ));

DROP POLICY IF EXISTS audit_events_staff_read ON public.audit_events;
CREATE POLICY audit_events_staff_read ON public.audit_events FOR SELECT TO authenticated USING (public.eventsync_is_staff());
DROP POLICY IF EXISTS audit_events_client_read_own ON public.audit_events;
CREATE POLICY audit_events_client_read_own ON public.audit_events FOR SELECT TO authenticated USING (
  client_id = public.eventsync_client_id()
);
DROP POLICY IF EXISTS booking_history_staff_read ON public.booking_status_history;
CREATE POLICY booking_history_staff_read ON public.booking_status_history FOR SELECT TO authenticated USING (public.eventsync_is_staff());
DROP POLICY IF EXISTS booking_history_client_read_own ON public.booking_status_history;
CREATE POLICY booking_history_client_read_own ON public.booking_status_history FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.bookings b WHERE b.id = booking_id AND b.client_id = public.eventsync_client_id())
);
DROP POLICY IF EXISTS event_orders_staff_manage ON public.event_orders;
CREATE POLICY event_orders_staff_manage ON public.event_orders FOR ALL TO authenticated
  USING (public.eventsync_is_staff()) WITH CHECK (public.eventsync_is_staff());

-- Table privileges complement RLS: a policy alone does not grant a table privilege.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT ON public.user_profiles, public.venues, public.halls, public.resource_types,
  public.venue_resource_capacity, public.clients, public.bookings,
  public.booking_resource_allocations, public.audit_events, public.booking_status_history,
  public.event_orders TO authenticated;
GRANT SELECT ON public.active_bookings, public.resource_utilization,
  public.v_booking_request_outcomes, public.v_hall_utilisation, public.v_venue_utilisation,
  public.v_resource_peak_demand, public.v_demand_heatmap, public.v_rejection_analysis,
  public.v_lifecycle_trends, public.v_data_quality_findings TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.venues, public.halls, public.resource_types,
  public.venue_resource_capacity, public.clients, public.event_orders TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
-- No policies or grants are defined for idempotency_records: authenticated clients cannot access them directly.

-- PostgreSQL 15+ supports invoker-security views. Prevent views from accidentally bypassing base-table RLS.
ALTER VIEW public.active_bookings SET (security_invoker = true);
ALTER VIEW public.resource_utilization SET (security_invoker = true);
ALTER VIEW public.v_booking_request_outcomes SET (security_invoker = true);
ALTER VIEW public.v_hall_utilisation SET (security_invoker = true);
ALTER VIEW public.v_venue_utilisation SET (security_invoker = true);
ALTER VIEW public.v_resource_peak_demand SET (security_invoker = true);
ALTER VIEW public.v_demand_heatmap SET (security_invoker = true);
ALTER VIEW public.v_rejection_analysis SET (security_invoker = true);
ALTER VIEW public.v_lifecycle_trends SET (security_invoker = true);
ALTER VIEW public.v_data_quality_findings SET (security_invoker = true);

-- Common deterministic advisory-lock ordering, shared with the Node allocator (venue id, UTC day number).
CREATE OR REPLACE FUNCTION public._eventsync_lock_dates(p_dates date[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d date; v record; day_key integer;
BEGIN
  FOR d IN SELECT DISTINCT date_value FROM unnest(p_dates) AS dates(date_value) WHERE date_value IS NOT NULL ORDER BY date_value LOOP
    day_key := d - DATE '1970-01-01';
    FOR v IN SELECT id FROM public.venues ORDER BY id LOOP
      PERFORM pg_advisory_xact_lock(v.id, day_key);
    END LOOP;
  END LOOP;
END;
$$;

-- Returns a proposed allocation without changing data. Used by all booking RPC operations.
CREATE OR REPLACE FUNCTION public._eventsync_find_allocation(p_request jsonb, p_exclude_booking_id integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_client_id integer := (p_request ->> 'client_id')::integer;
  v_preferred_venue_id integer := (p_request ->> 'preferred_venue_id')::integer;
  v_event_date date := (p_request ->> 'event_date')::date;
  v_start time := (p_request ->> 'event_start')::time;
  v_end time := (p_request ->> 'event_end')::time;
  v_reserved_start time;
  v_reserved_end time;
  v_attendees integer := (p_request ->> 'attendees')::integer;
  v_projectors integer := COALESCE((p_request ->> 'projectors_requested')::integer, 0);
  v_audio integer := COALESCE((p_request ->> 'audio_systems_requested')::integer, 0);
  v_staff integer := COALESCE((p_request ->> 'staff_requested')::integer, 0);
  cand record;
  req record;
  v_peak integer;
  v_capacity integer;
  v_name text;
  v_valid boolean := true;
  v_reason text := NULL;
BEGIN
  IF v_client_id IS NULL OR v_preferred_venue_id IS NULL OR v_event_date IS NULL
     OR v_start IS NULL OR v_end IS NULL OR v_attendees IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Required booking fields are missing.');
  END IF;
  IF v_start >= v_end OR v_attendees < 1 OR v_projectors < 0 OR v_audio < 0 OR v_staff < 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Invalid event interval, attendance, or resource quantity.');
  END IF;
  v_reserved_start := v_start - INTERVAL '30 minutes';
  v_reserved_end := v_end + INTERVAL '30 minutes';
  IF v_reserved_start < TIME '08:00' OR v_reserved_end > TIME '22:00' THEN
    RETURN jsonb_build_object('success', false, 'message', 'The complete event including 30-minute setup and cleanup buffers must be within 08:00–22:00.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id = v_client_id AND c.is_active)
     OR NOT EXISTS (SELECT 1 FROM public.venues v WHERE v.id = v_preferred_venue_id) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Client does not exist or is inactive, or preferred venue does not exist.');
  END IF;

  FOR cand IN
    SELECT v.id AS venue_id, v.name AS venue_name, h.id AS hall_id, h.name AS hall_name, h.capacity AS hall_capacity
    FROM public.venues v
    JOIN public.halls h ON h.venue_id = v.id AND h.is_active AND h.capacity >= v_attendees
    ORDER BY CASE WHEN v.id = v_preferred_venue_id THEN 0 ELSE 1 END, v.id, h.capacity, h.id
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.status = 'confirmed' AND b.hall_id = cand.hall_id
        AND b.event_date = v_event_date AND (p_exclude_booking_id IS NULL OR b.id <> p_exclude_booking_id)
        AND tsrange((b.event_date + b.reserved_start)::timestamp, (b.event_date + b.reserved_end)::timestamp, '[)')
            && tsrange((v_event_date + v_reserved_start)::timestamp, (v_event_date + v_reserved_end)::timestamp, '[)')
    ) THEN
      CONTINUE;
    END IF;

    v_valid := true;
    FOR req IN
      SELECT rt.id AS resource_type_id, rt.name,
        CASE rt.name WHEN 'projector' THEN v_projectors WHEN 'audio_system' THEN v_audio WHEN 'support_staff' THEN v_staff ELSE 0 END AS quantity,
        COALESCE(vrc.capacity, 0) AS capacity
      FROM public.resource_types rt
      LEFT JOIN public.venue_resource_capacity vrc ON vrc.resource_type_id = rt.id AND vrc.venue_id = cand.venue_id
      WHERE rt.name IN ('projector', 'audio_system', 'support_staff')
    LOOP
      IF req.quantity > req.capacity THEN v_valid := false; EXIT; END IF;
      IF req.quantity = 0 THEN CONTINUE; END IF;
      WITH points AS (
        SELECT v_reserved_start AS t
        UNION
        SELECT b.reserved_start
        FROM public.bookings b
        WHERE b.status = 'confirmed' AND b.venue_id = cand.venue_id AND b.event_date = v_event_date
          AND (p_exclude_booking_id IS NULL OR b.id <> p_exclude_booking_id)
          AND b.reserved_start >= v_reserved_start AND b.reserved_start < v_reserved_end
          AND EXISTS (
            SELECT 1 FROM public.booking_resource_allocations x
            WHERE x.booking_id = b.id AND x.resource_type_id = req.resource_type_id AND x.quantity_allocated > 0
          )
      ), usage_at_point AS (
        SELECT p.t, COALESCE(SUM(a.quantity_allocated), 0)::integer AS used
        FROM points p
        LEFT JOIN public.bookings b
          ON b.status = 'confirmed' AND b.venue_id = cand.venue_id AND b.event_date = v_event_date
         AND (p_exclude_booking_id IS NULL OR b.id <> p_exclude_booking_id)
         AND b.reserved_start <= p.t AND b.reserved_end > p.t
        LEFT JOIN public.booking_resource_allocations a ON a.booking_id = b.id AND a.resource_type_id = req.resource_type_id
        GROUP BY p.t
      )
      SELECT COALESCE(MAX(used), 0) INTO v_peak FROM usage_at_point;
      IF v_peak + req.quantity > req.capacity THEN v_valid := false; EXIT; END IF;
    END LOOP;

    IF v_valid THEN
      RETURN jsonb_build_object(
        'success', true, 'venue_id', cand.venue_id, 'venue_name', cand.venue_name,
        'hall_id', cand.hall_id, 'hall_name', cand.hall_name, 'hall_capacity', cand.hall_capacity,
        'reserved_start', v_reserved_start, 'reserved_end', v_reserved_end
      );
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success', false, 'message', 'No feasible hall and shared-resource allocation is available for the requested interval.');
END;
$$;

-- Private helper: FIFO waitlist promotion; called inside cancellation/reschedule transactions.
CREATE OR REPLACE FUNCTION public._eventsync_promote_waitlist(p_event_date date, p_actor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w record; alloc jsonb; promoted jsonb := '[]'::jsonb; new_venue integer; new_hall integer; r record;
BEGIN
  FOR w IN SELECT * FROM public.bookings WHERE status = 'waitlisted' AND event_date = p_event_date ORDER BY created_at, id FOR UPDATE LOOP
    alloc := public._eventsync_find_allocation(to_jsonb(w), NULL);
    IF COALESCE((alloc->>'success')::boolean, false) IS NOT TRUE THEN CONTINUE; END IF;
    new_venue := (alloc->>'venue_id')::integer; new_hall := (alloc->>'hall_id')::integer;
    UPDATE public.bookings SET status = 'confirmed', venue_id = new_venue, hall_id = new_hall,
      reserved_start = (alloc->>'reserved_start')::time, reserved_end = (alloc->>'reserved_end')::time,
      rejection_reason = NULL, rejection_code = NULL, updated_at = NOW()
      WHERE id = w.id AND status = 'waitlisted';
    IF NOT FOUND THEN CONTINUE; END IF;
    DELETE FROM public.booking_resource_allocations WHERE booking_id = w.id;
    INSERT INTO public.booking_resource_allocations (booking_id, resource_type_id, quantity_allocated)
    SELECT w.id, rt.id, x.qty FROM (VALUES ('projector', w.projectors_requested), ('audio_system', w.audio_systems_requested), ('support_staff', w.staff_requested)) x(name, qty)
    JOIN public.resource_types rt ON rt.name = x.name WHERE x.qty > 0;
    INSERT INTO public.audit_events (event_type, booking_id, client_id, actor, event_data)
    VALUES ('waitlist_promoted', w.id, w.client_id, p_actor::text,
      jsonb_build_object('venue_id', new_venue, 'hall_id', new_hall, 'reason', 'Promoted automatically after capacity was released'));
    promoted := promoted || jsonb_build_array(jsonb_build_object('id', w.id, 'venue_id', new_venue, 'hall_id', new_hall, 'venue_name', alloc->>'venue_name', 'hall_name', alloc->>'hall_name'));
  END LOOP;
  RETURN promoted;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_booking(p_request jsonb, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := auth.uid(); role_name text; mapped_client integer; req jsonb := p_request; alloc jsonb;
  cid integer; preferred integer; event_day date; event_start time; event_end time; rs time; re time;
  inserted public.bookings%ROWTYPE; response jsonb; scoped_key text; cached public.idempotency_records%ROWTYPE; window_ok boolean;
BEGIN
  SELECT role, client_id INTO role_name, mapped_client FROM public.user_profiles WHERE user_id = uid;
  IF uid IS NULL OR role_name IS NULL THEN RAISE EXCEPTION 'Authenticated EventSync profile required' USING ERRCODE='42501'; END IF;
  IF role_name NOT IN ('admin','manager','staff','client') THEN RAISE EXCEPTION 'Role is not allowed to create bookings' USING ERRCODE='42501'; END IF;
  cid := COALESCE((req->>'client_id')::integer, mapped_client);
  IF role_name = 'client' THEN
    IF mapped_client IS NULL OR cid IS DISTINCT FROM mapped_client THEN RAISE EXCEPTION 'Clients may only create bookings for their linked client account' USING ERRCODE='42501'; END IF;
    req := jsonb_set(req, '{client_id}', to_jsonb(mapped_client), true);
  END IF;

  -- Return a cached response before time-sensitive business validation so retries
  -- remain idempotent even if the event date has since passed or data changed.
  IF p_idempotency_key IS NOT NULL THEN
    IF length(p_idempotency_key) > 258 OR length(p_idempotency_key) = 0 THEN RAISE EXCEPTION 'Invalid idempotency key'; END IF;
    scoped_key := uid::text || ':' || p_idempotency_key;
    PERFORM pg_advisory_xact_lock(hashtext('eventsync-idempotency:' || scoped_key));
    SELECT * INTO cached FROM public.idempotency_records WHERE idempotency_key = scoped_key AND expires_at > NOW();
    IF FOUND THEN
      IF cached.request_hash <> md5(req::text) THEN RAISE EXCEPTION 'Idempotency key was reused with a different request' USING ERRCODE='23505'; END IF;
      RETURN cached.response_data;
    END IF;
  END IF;

  preferred := (req->>'preferred_venue_id')::integer;
  event_day := (req->>'event_date')::date;
  event_start := (req->>'event_start')::time;
  event_end := (req->>'event_end')::time;

  -- Validate the payload inside the database as well as at the HTTP boundary.
  -- These RPCs are exposed to authenticated Supabase callers, so malformed requests
  -- must not fall through to a table constraint error or create invalid rejected rows.
  IF event_day IS NULL OR event_day < CURRENT_DATE THEN
    RETURN jsonb_build_object('success', false, 'booking', NULL, 'message', 'Event date must be today or in the future.');
  END IF;
  IF event_start IS NULL OR event_end IS NULL OR event_start >= event_end THEN
    RETURN jsonb_build_object('success', false, 'booking', NULL, 'message', 'Event start must be before event end.');
  END IF;
  IF event_start < TIME '00:30' OR event_end > TIME '23:29' THEN
    RETURN jsonb_build_object('success', false, 'booking', NULL, 'message', 'Event times must leave room for the 30-minute buffers within one calendar day.');
  END IF;
  IF length(btrim(COALESCE(req->>'event_name', ''))) < 1 OR length(req->>'event_name') > 255 THEN
    RETURN jsonb_build_object('success', false, 'booking', NULL, 'message', 'Event name is required and must be at most 255 characters.');
  END IF;
  IF COALESCE((req->>'attendees')::integer, 0) < 1 THEN
    RETURN jsonb_build_object('success', false, 'booking', NULL, 'message', 'Attendees must be a positive integer.');
  END IF;
  IF COALESCE((req->>'projectors_requested')::integer, 0) < 0
     OR COALESCE((req->>'audio_systems_requested')::integer, 0) < 0
     OR COALESCE((req->>'staff_requested')::integer, 0) < 0 THEN
    RETURN jsonb_build_object('success', false, 'booking', NULL, 'message', 'Resource quantities cannot be negative.');
  END IF;

  IF cid IS NULL OR NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id = cid AND c.is_active) THEN
    RETURN jsonb_build_object('success', false, 'booking', NULL, 'message', 'Client does not exist or is inactive.');
  END IF;
  IF preferred IS NULL OR NOT EXISTS (SELECT 1 FROM public.venues v WHERE v.id = preferred) THEN
    RETURN jsonb_build_object('success', false, 'booking', NULL, 'message', 'Preferred venue does not exist.');
  END IF;
  PERFORM public._eventsync_lock_dates(ARRAY[event_day]);
  window_ok := event_start >= TIME '08:30' AND event_end <= TIME '21:30' AND event_start < event_end;
  alloc := public._eventsync_find_allocation(req, NULL);
  rs := (alloc->>'reserved_start')::time; re := (alloc->>'reserved_end')::time;
  IF rs IS NULL OR re IS NULL THEN
    -- TIME cannot represent a reservation that wraps across midnight. Return a controlled
    -- failure for these malformed intervals instead of violating the stored interval constraints.
    IF event_start < TIME '00:30' OR event_end >= TIME '23:30' THEN
      RETURN jsonb_build_object('success', false, 'booking', NULL, 'message',
        'The event plus its 30-minute buffers cannot be represented within a single calendar day.');
    END IF;
    rs := event_start - INTERVAL '30 minutes'; re := event_end + INTERVAL '30 minutes';
  END IF;
  INSERT INTO public.bookings (client_id, hall_id, venue_id, preferred_venue_id,
    projectors_requested, audio_systems_requested, staff_requested, event_name, event_date,
    event_start, event_end, reserved_start, reserved_end, attendees, status,
    rejection_reason, rejection_code, created_by, correlation_id)
  VALUES (cid, CASE WHEN COALESCE((alloc->>'success')::boolean,false) THEN (alloc->>'hall_id')::integer ELSE NULL END,
    CASE WHEN COALESCE((alloc->>'success')::boolean,false) THEN (alloc->>'venue_id')::integer ELSE preferred END,
    preferred, COALESCE((req->>'projectors_requested')::integer,0), COALESCE((req->>'audio_systems_requested')::integer,0),
    COALESCE((req->>'staff_requested')::integer,0), req->>'event_name', event_day, event_start, event_end, rs, re,
    (req->>'attendees')::integer,
    CASE WHEN NOT window_ok THEN 'rejected'::public.booking_status
         WHEN COALESCE((alloc->>'success')::boolean,false) THEN 'confirmed'::public.booking_status
         WHEN COALESCE((req->>'waitlist_if_full')::boolean,false) THEN 'waitlisted'::public.booking_status ELSE 'rejected'::public.booking_status END,
    CASE WHEN COALESCE((alloc->>'success')::boolean,false) THEN NULL ELSE COALESCE(alloc->>'message','No feasible allocation was found') END,
    CASE WHEN COALESCE((alloc->>'success')::boolean,false) THEN NULL WHEN NOT window_ok THEN 'OUTSIDE_OPERATING_HOURS' ELSE 'NO_AVAILABILITY' END,
    uid::text, NULL)
  RETURNING * INTO inserted;
  IF inserted.status = 'confirmed' THEN
    INSERT INTO public.booking_resource_allocations (booking_id, resource_type_id, quantity_allocated)
    SELECT inserted.id, rt.id, x.qty FROM (VALUES ('projector', inserted.projectors_requested), ('audio_system', inserted.audio_systems_requested), ('support_staff', inserted.staff_requested)) x(name, qty)
    JOIN public.resource_types rt ON rt.name = x.name WHERE x.qty > 0;
    INSERT INTO public.audit_events(event_type, booking_id, client_id, actor, event_data)
    VALUES ('booking_confirmed', inserted.id, inserted.client_id, uid::text,
      jsonb_build_object('venue_id', alloc->>'venue_id','hall_id',alloc->>'hall_id','source','supabase_rpc'));
  ELSIF inserted.status = 'waitlisted' THEN
    INSERT INTO public.audit_events(event_type, booking_id, client_id, actor, event_data)
    VALUES ('booking_waitlisted', inserted.id, inserted.client_id, uid::text, jsonb_build_object('reason', inserted.rejection_reason));
  ELSE
    INSERT INTO public.audit_events(event_type, booking_id, client_id, actor, event_data)
    VALUES ('booking_rejected', inserted.id, inserted.client_id, uid::text, jsonb_build_object('reason', inserted.rejection_reason));
  END IF;
  response := jsonb_build_object('success', inserted.status='confirmed', 'waitlisted', inserted.status='waitlisted',
    'booking', to_jsonb(inserted), 'allocation', alloc, 'message', CASE WHEN inserted.status='confirmed' THEN
      'Event confirmed at ' || (alloc->>'venue_name') || ' - ' || (alloc->>'hall_name') ELSE inserted.rejection_reason END);
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO public.idempotency_records(idempotency_key, request_hash, booking_id, response_data, expires_at)
    VALUES (scoped_key, md5(req::text), inserted.id, response, NOW() + INTERVAL '24 hours')
    ON CONFLICT (idempotency_key) DO UPDATE SET request_hash=EXCLUDED.request_hash, response_data=EXCLUDED.response_data, booking_id=EXCLUDED.booking_id, expires_at=EXCLUDED.expires_at;
  END IF;
  RETURN response;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_booking(p_booking_id integer, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := auth.uid(); role_name text; mapped_client integer; b public.bookings%ROWTYPE; released jsonb; promoted jsonb; locked_date date;
BEGIN
  SELECT role, client_id INTO role_name, mapped_client FROM public.user_profiles WHERE user_id=uid;
  IF uid IS NULL OR role_name IS NULL OR role_name NOT IN ('admin','manager','staff','client') THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  -- Lock allocation dates before locking the booking row, matching the global lock order.
  SELECT * INTO b FROM public.bookings WHERE id=p_booking_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found'; END IF;
  locked_date := b.event_date;
  PERFORM public._eventsync_lock_dates(ARRAY[locked_date]);
  SELECT * INTO b FROM public.bookings WHERE id=p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found'; END IF;
  IF b.event_date IS DISTINCT FROM locked_date THEN RAISE EXCEPTION 'Booking changed concurrently; retry the cancellation' USING ERRCODE='40001'; END IF;
  IF b.status <> 'confirmed' THEN RAISE EXCEPTION 'Booking is not in confirmed status'; END IF;
  IF role_name='client' AND b.client_id IS DISTINCT FROM mapped_client THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE='P0002'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('resource_type',rt.name,'quantity',a.quantity_allocated)), '[]'::jsonb)
    INTO released FROM public.booking_resource_allocations a JOIN public.resource_types rt ON rt.id=a.resource_type_id WHERE a.booking_id=b.id;
  UPDATE public.bookings SET status='cancelled', rejection_reason=left(p_reason,500), updated_at=NOW()
    WHERE id=b.id AND status='confirmed' RETURNING * INTO b;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking is not in confirmed status'; END IF;
  DELETE FROM public.booking_resource_allocations WHERE booking_id=b.id;
  INSERT INTO public.audit_events(event_type,booking_id,client_id,actor,event_data)
    VALUES('booking_cancelled',b.id,b.client_id,uid::text,jsonb_build_object('reason',p_reason,'released_allocations',released));
  promoted := public._eventsync_promote_waitlist(b.event_date,uid);
  RETURN jsonb_build_object('success',true,'booking',to_jsonb(b),'promoted',promoted,'message','Booking cancelled and allocations released.');
END;
$$;

CREATE OR REPLACE FUNCTION public.reschedule_booking(p_booking_id integer, p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := auth.uid(); role_name text; mapped_client integer; b public.bookings%ROWTYPE; req jsonb := p_request;
  new_date date; old_date date; alloc jsonb; rs time; re time; changed public.bookings%ROWTYPE; promoted jsonb;
BEGIN
  SELECT role, client_id INTO role_name, mapped_client FROM public.user_profiles WHERE user_id=uid;
  IF uid IS NULL OR role_name IS NULL OR role_name NOT IN ('admin','manager','staff','client') THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  -- Read without a row lock, acquire date locks in deterministic order, then lock the booking.
  SELECT * INTO b FROM public.bookings WHERE id=p_booking_id AND status='confirmed';
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found or not in confirmed status'; END IF;
  old_date := b.event_date;
  new_date := (req->>'event_date')::date;
  PERFORM public._eventsync_lock_dates(ARRAY[old_date,new_date]);
  SELECT * INTO b FROM public.bookings WHERE id=p_booking_id AND status='confirmed' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found or not in confirmed status'; END IF;
  IF b.event_date IS DISTINCT FROM old_date THEN RAISE EXCEPTION 'Booking changed concurrently; retry the reschedule' USING ERRCODE='40001'; END IF;
  IF role_name='client' AND b.client_id IS DISTINCT FROM mapped_client THEN RAISE EXCEPTION 'Booking not found or not in confirmed status' USING ERRCODE='P0002'; END IF;
  IF COALESCE((req->>'client_id')::integer,b.client_id) <> b.client_id THEN RAISE EXCEPTION 'A booking cannot be reassigned to a different client' USING ERRCODE='22023'; END IF;
  req := jsonb_set(req,'{client_id}',to_jsonb(b.client_id),true);
  alloc := public._eventsync_find_allocation(req,p_booking_id);
  IF COALESCE((alloc->>'success')::boolean,false) IS NOT TRUE THEN
    INSERT INTO public.audit_events(event_type,booking_id,client_id,actor,event_data)
    VALUES('booking_reschedule_failed',b.id,b.client_id,uid::text,jsonb_build_object('reason',alloc->>'message'));
    RETURN jsonb_build_object('success',false,'booking',to_jsonb(b),'message','Cannot reschedule: ' || COALESCE(alloc->>'message','no feasible allocation'));
  END IF;
  rs := (alloc->>'reserved_start')::time; re := (alloc->>'reserved_end')::time;
  UPDATE public.bookings SET venue_id=(alloc->>'venue_id')::integer,hall_id=(alloc->>'hall_id')::integer,
    preferred_venue_id=(req->>'preferred_venue_id')::integer,event_name=req->>'event_name',event_date=new_date,
    event_start=(req->>'event_start')::time,event_end=(req->>'event_end')::time,reserved_start=rs,reserved_end=re,
    attendees=(req->>'attendees')::integer,projectors_requested=COALESCE((req->>'projectors_requested')::integer,0),
    audio_systems_requested=COALESCE((req->>'audio_systems_requested')::integer,0),staff_requested=COALESCE((req->>'staff_requested')::integer,0),
    rejection_reason=NULL,rejection_code=NULL,updated_at=NOW()
    WHERE id=p_booking_id RETURNING * INTO changed;
  DELETE FROM public.booking_resource_allocations WHERE booking_id=changed.id;
  INSERT INTO public.booking_resource_allocations(booking_id,resource_type_id,quantity_allocated)
    SELECT changed.id,rt.id,x.qty FROM (VALUES('projector',changed.projectors_requested),('audio_system',changed.audio_systems_requested),('support_staff',changed.staff_requested)) x(name,qty)
    JOIN public.resource_types rt ON rt.name=x.name WHERE x.qty>0;
  INSERT INTO public.audit_events(event_type,booking_id,client_id,actor,event_data)
    VALUES('booking_reschedule_succeeded',changed.id,changed.client_id,uid::text,jsonb_build_object('venue_id',changed.venue_id,'hall_id',changed.hall_id,'event_date',changed.event_date));
  promoted := public._eventsync_promote_waitlist(b.event_date,uid);
  RETURN jsonb_build_object('success',true,'booking',to_jsonb(changed),'allocation',alloc,'promoted',promoted,'message','Booking rescheduled successfully.');
END;
$$;

CREATE OR REPLACE FUNCTION public.promote_waitlist(p_event_date date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := auth.uid(); role_name text;
BEGIN
  SELECT role INTO role_name FROM public.user_profiles WHERE user_id=uid;
  IF uid IS NULL OR role_name IS NULL OR role_name NOT IN ('admin','manager','staff') THEN RAISE EXCEPTION 'Staff or manager role required' USING ERRCODE='42501'; END IF;
  PERFORM public._eventsync_lock_dates(ARRAY[p_event_date]);
  RETURN public._eventsync_promote_waitlist(p_event_date,uid);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_recurring_series(
  p_request jsonb, p_occurrences integer, p_every_days integer DEFAULT 7,
  p_all_or_nothing boolean DEFAULT true, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := auth.uid(); role_name text; mapped_client integer; req jsonb:=p_request; base_date date; dates date[]; i integer;
  item jsonb; created jsonb; results jsonb:='[]'::jsonb; failures jsonb:='[]'::jsonb; key text;
BEGIN
  SELECT role,client_id INTO role_name,mapped_client FROM public.user_profiles WHERE user_id=uid;
  IF uid IS NULL OR role_name IS NULL OR role_name NOT IN ('admin','manager','staff','client') THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  IF p_occurrences < 2 OR p_occurrences > 52 OR p_every_days < 1 OR p_every_days > 365 THEN
    RAISE EXCEPTION 'occurrences must be 2-52 and every_days must be 1-365' USING ERRCODE='22023';
  END IF;
  IF p_idempotency_key IS NOT NULL AND (length(p_idempotency_key) = 0 OR length(p_idempotency_key) > 255) THEN
    RAISE EXCEPTION 'Invalid idempotency key' USING ERRCODE='22023';
  END IF;
  IF role_name='client' THEN
    IF mapped_client IS NULL OR COALESCE((req->>'client_id')::integer,mapped_client)<>mapped_client THEN RAISE EXCEPTION 'Client profile is not linked to this client account' USING ERRCODE='42501'; END IF;
    req:=jsonb_set(req,'{client_id}',to_jsonb(mapped_client),true);
  END IF;
  base_date:=(req->>'event_date')::date;
  SELECT array_agg(base_date + (n*p_every_days) ORDER BY n) INTO dates FROM generate_series(0,p_occurrences-1) n;
  PERFORM public._eventsync_lock_dates(dates);
  -- Exception block creates a savepoint. Raising on a failed occurrence rolls back every occurrence in all-or-nothing mode.
  BEGIN
    FOR i IN 0..p_occurrences-1 LOOP
      item:=jsonb_set(req,'{event_date}',to_jsonb((base_date+(i*p_every_days))::text),true);
      created:=public.create_booking(item, CASE WHEN p_idempotency_key IS NULL THEN NULL ELSE p_idempotency_key || ':' || (i+1)::text END);
      IF COALESCE((created->>'success')::boolean,false) IS NOT TRUE THEN
        failures:=failures||jsonb_build_array(jsonb_build_object('occurrence',i+1,'event_date',base_date+(i*p_every_days),'reason',created->>'message'));
        IF p_all_or_nothing THEN RAISE EXCEPTION 'Occurrence % failed: %',i+1,created->>'message' USING ERRCODE='P0001'; END IF;
      ELSE
        results:=results||jsonb_build_array(jsonb_build_object('occurrence',i+1,'event_date',base_date+(i*p_every_days),'result',created));
      END IF;
    END LOOP;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    RETURN jsonb_build_object('success',false,'created',0,'failures',failures,'message',SQLERRM);
  END;
  RETURN jsonb_build_object('success',jsonb_array_length(failures)=0,'created',jsonb_array_length(results),'occurrences',results,'failures',failures,
    'message',format('%s of %s recurring bookings created.',jsonb_array_length(results),p_occurrences));
END;
$$;

-- Private helpers are callable by the definer functions but not directly by browser roles.
REVOKE ALL ON FUNCTION public._eventsync_lock_dates(date[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._eventsync_find_allocation(jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._eventsync_promote_waitlist(date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_booking(jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_booking(integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_booking(integer, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.promote_waitlist(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_recurring_series(jsonb, integer, integer, boolean, text) TO authenticated;
REVOKE ALL ON FUNCTION public.create_booking(jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_booking(integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reschedule_booking(integer, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.promote_waitlist(date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_recurring_series(jsonb, integer, integer, boolean, text) FROM PUBLIC, anon;
