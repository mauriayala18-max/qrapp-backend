-- Allow restaurant_alerts.alert_type = 'payment_received'.
--
-- ROOT CAUSE of "digital payments never create an alert":
-- restaurant_alerts has a CHECK constraint, restaurant_alerts_alert_type_check,
-- that currently permits EXACTLY two values. Verified empirically on the live
-- database by probing every plausible value (each rejected one failed with
-- SQLSTATE 23514):
--
--   ALLOWED  : client_calling, cancellation_request
--   REJECTED : payment_received, payment_completed, payment, payment_pending,
--              payment_confirmed, order_ready, order_placed, new_order,
--              bill_request, call_waiter, waiter_call, assistance, help,
--              session_closed, table_ready, reservation
--
-- The API insert is otherwise correct: the same row with alert_type
-- 'client_calling' inserts successfully through the service_role key.
--
-- This must be run in the Supabase SQL editor. It cannot be applied from the
-- API server, because PostgREST does not execute DDL and the project exposes
-- no RPC that would.
--
-- Idempotent: safe to run more than once.

ALTER TABLE public.restaurant_alerts
  DROP CONSTRAINT IF EXISTS restaurant_alerts_alert_type_check;

ALTER TABLE public.restaurant_alerts
  ADD CONSTRAINT restaurant_alerts_alert_type_check
  CHECK (alert_type IN (
    'client_calling',        -- pre-existing: diner presses "call the waiter"
    'cancellation_request',  -- pre-existing: diner asks to cancel an order
    'payment_received'       -- NEW: diner completed a card / apple_pay / google_pay payment
  ));

-- Verify the constraint now lists all three values:
--
--   SELECT pg_get_constraintdef(c.oid) AS definition
--   FROM pg_constraint c
--   JOIN pg_class r ON r.oid = c.conrelid
--   WHERE r.relname = 'restaurant_alerts'
--     AND c.conname = 'restaurant_alerts_alert_type_check';
--
-- Then confirm the row actually inserts (delete it afterwards):
--
--   INSERT INTO public.restaurant_alerts
--     (branch_id, alert_type, reference_type, reference_id, recipient_role, status)
--   SELECT b.id, 'payment_received', 'session', NULL, 'waiter', 'pending'
--   FROM public.branches b LIMIT 1
--   RETURNING id, alert_type, status;
--
--   -- DELETE FROM public.restaurant_alerts WHERE alert_type = 'payment_received' AND reference_id IS NULL;
