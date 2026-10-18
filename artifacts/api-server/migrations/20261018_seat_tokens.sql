-- Seat tokens: a private per-participant credential for table sessions.
-- Idempotent: safe to run more than once. Run it in the Supabase SQL Editor.
--
-- Until this runs, the API keeps working exactly as before (no tokens are
-- issued and none are required); /api/healthz reports
-- seat_tokens.columns = "missing_columns". Within a minute of running it,
-- tokens start being issued and enforced without a restart.

-- 1. sha256 (hex) of the participant's seat token. The plaintext is never stored.
--    NULL = participant created before seat tokens (gets one lazily on its
--    next protected request).
ALTER TABLE public.session_participants
  ADD COLUMN IF NOT EXISTS seat_token_hash text NULL;

-- 2. When the current token was issued (rotated on every join / rejoin).
ALTER TABLE public.session_participants
  ADD COLUMN IF NOT EXISTS seat_token_issued_at timestamptz NULL;

-- 3. Every protected request looks the participant up BY this hash, so it
--    needs an index. Unique because one token must map to exactly one seat;
--    partial so the many legacy NULL rows cost nothing.
CREATE UNIQUE INDEX IF NOT EXISTS session_participants_seat_token_hash_key
  ON public.session_participants (seat_token_hash)
  WHERE seat_token_hash IS NOT NULL;

-- 4. Make PostgREST see the new columns immediately.
NOTIFY pgrst, 'reload schema';
