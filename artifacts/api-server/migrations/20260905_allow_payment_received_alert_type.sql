-- Allow restaurant_alerts.alert_type = 'payment_received'.
--
-- Context: alert_type is guarded by a CHECK constraint (verified empirically:
-- 'client_calling' and 'cancellation_request' are accepted, 'payment_received'
-- and 'order_ready' are rejected with SQLSTATE 23514 on
-- "restaurant_alerts_alert_type_check"). The exact list of allowed values could
-- not be read through PostgREST, so this migration does NOT hardcode it: it
-- reads the current constraint, keeps every value it already allows, and adds
-- the ones the API needs.
--
-- Idempotent: running it twice is a no-op.
-- Run it in the Supabase SQL editor.

DO $$
DECLARE
  v_conname  text;
  v_condef   text;
  v_values   text[];
  v_newlist  text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid)
    INTO v_conname, v_condef
  FROM pg_constraint c
  JOIN pg_class r      ON r.oid = c.conrelid
  JOIN pg_namespace n  ON n.oid = r.relnamespace
  WHERE n.nspname = 'public'
    AND r.relname = 'restaurant_alerts'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%alert_type%'
  LIMIT 1;

  IF v_conname IS NULL THEN
    RAISE NOTICE 'No CHECK constraint on restaurant_alerts.alert_type - nothing to widen.';
    RETURN;
  END IF;

  -- Every single-quoted literal in the constraint definition is an allowed value.
  SELECT array_agg(DISTINCT m[1])
    INTO v_values
  FROM regexp_matches(v_condef, '''([^'']+)''', 'g') AS m;

  v_values := (
    SELECT array_agg(DISTINCT v)
    FROM unnest(COALESCE(v_values, ARRAY[]::text[]) || ARRAY['payment_received', 'client_calling']) AS v
  );

  IF 'payment_received' = ANY(COALESCE(
       (SELECT array_agg(m[1]) FROM regexp_matches(v_condef, '''([^'']+)''', 'g') AS m),
       ARRAY[]::text[])) THEN
    RAISE NOTICE 'payment_received is already allowed - nothing to do.';
    RETURN;
  END IF;

  SELECT string_agg(quote_literal(v), ', ' ORDER BY v)
    INTO v_newlist
  FROM unnest(v_values) AS v;

  EXECUTE format('ALTER TABLE public.restaurant_alerts DROP CONSTRAINT %I', v_conname);
  EXECUTE format(
    'ALTER TABLE public.restaurant_alerts ADD CONSTRAINT %I CHECK (alert_type IN (%s))',
    v_conname, v_newlist
  );

  RAISE NOTICE 'restaurant_alerts.alert_type now allows: %', v_newlist;
END $$;

-- Verification:
--   SELECT pg_get_constraintdef(c.oid)
--   FROM pg_constraint c
--   JOIN pg_class r ON r.oid = c.conrelid
--   WHERE r.relname = 'restaurant_alerts' AND c.contype = 'c';
