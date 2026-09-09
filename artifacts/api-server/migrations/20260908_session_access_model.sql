-- Session access model: how diners may enter a table, and whether a table
-- is still accepting them. Idempotent: safe to run more than once.
--
-- Run this in the Supabase SQL Editor. The API tolerates both columns being
-- absent (it falls back to access_method = 'both' and entry_locked = false),
-- so nothing breaks before you run it - but PIN-only / QR-only branches and
-- the ENTRY_LOCKED rejection stay inert until then.

-- 1. Each restaurant chooses how diners join: QR only, PIN only, or both.
ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS access_method text NOT NULL DEFAULT 'both';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.branches'::regclass
      AND conname = 'branches_access_method_check'
  ) THEN
    ALTER TABLE public.branches
      ADD CONSTRAINT branches_access_method_check
      CHECK (access_method IN ('qr', 'pin', 'both'));
  END IF;
END $$;

-- 2. A sealed table takes no new participants, even with a valid PIN or token.
--    Staff-controlled; the diners already seated are unaffected.
ALTER TABLE public.table_sessions
  ADD COLUMN IF NOT EXISTS entry_locked boolean NOT NULL DEFAULT false;

-- 3. Joining by PIN resolves the table through tables.current_pin, so two
--    tables must never hold the same PIN at the same time.
CREATE UNIQUE INDEX IF NOT EXISTS tables_current_pin_unique
  ON public.tables (current_pin)
  WHERE current_pin IS NOT NULL;

-- 4. One table runs at most one session at a time. Availability is derived
--    from the absence of an active session, so a duplicate would make a busy
--    table look free (or a free one busy).
CREATE UNIQUE INDEX IF NOT EXISTS table_sessions_one_active_per_table
  ON public.table_sessions (table_id)
  WHERE status = 'active';

-- 5. One row per diner per session. The old join code inserted a new
--    participant on every reconnect, so clean up the leftovers first: keep the
--    earliest row of each duplicate set and drop the rest.
DELETE FROM public.session_participants p
USING public.session_participants keep
WHERE p.session_id = keep.session_id
  AND p.user_id IS NOT NULL
  AND p.user_id = keep.user_id
  AND (keep.joined_at, keep.id) < (p.joined_at, p.id);

DELETE FROM public.session_participants p
USING public.session_participants keep
WHERE p.session_id = keep.session_id
  AND p.user_id IS NULL
  AND keep.user_id IS NULL
  AND p.web_name IS NOT NULL
  AND p.web_name = keep.web_name
  AND (keep.joined_at, keep.id) < (p.joined_at, p.id);

CREATE UNIQUE INDEX IF NOT EXISTS session_participants_one_per_user
  ON public.session_participants (session_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS session_participants_one_per_guest
  ON public.session_participants (session_id, web_name)
  WHERE user_id IS NULL AND web_name IS NOT NULL;
