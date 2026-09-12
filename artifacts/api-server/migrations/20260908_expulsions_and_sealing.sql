-- Expulsion (majority + staff) and table sealing by majority.
-- Idempotent: safe to run more than once.
--
-- Run this in the Supabase SQL Editor. Until it runs, the expulsion and
-- lock-request endpoints answer 503 EXPULSIONS_NOT_INSTALLED instead of
-- failing in an unexplained way; nothing else in the API changes behaviour.

-- ---------------------------------------------------------------------------
-- 1. Proposals: one open proposal per target per session.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.expulsion_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.table_sessions(id) ON DELETE CASCADE,
  target_participant_id uuid NOT NULL REFERENCES public.session_participants(id) ON DELETE CASCADE,
  proposed_by_participant_id uuid NOT NULL REFERENCES public.session_participants(id) ON DELETE CASCADE,
  reason_type text NOT NULL,
  reason_text text,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.expulsion_proposals'::regclass
      AND conname = 'expulsion_proposals_status_check'
  ) THEN
    ALTER TABLE public.expulsion_proposals
      ADD CONSTRAINT expulsion_proposals_status_check
      CHECK (status IN ('open', 'executed', 'cancelled'));
  END IF;
END $$;

-- A second open proposal against the same diner would let a pair of diners
-- stack votes across duplicate proposals until one of them passes.
CREATE UNIQUE INDEX IF NOT EXISTS expulsion_proposals_one_open_per_target
  ON public.expulsion_proposals (session_id, target_participant_id)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS expulsion_proposals_session_idx
  ON public.expulsion_proposals (session_id, status);

-- ---------------------------------------------------------------------------
-- 2. Votes: one per participant per proposal, enforced by the database so a
--    double-tap cannot count twice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.expulsion_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES public.expulsion_proposals(id) ON DELETE CASCADE,
  voter_participant_id uuid NOT NULL REFERENCES public.session_participants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expulsion_votes_one_per_voter UNIQUE (proposal_id, voter_participant_id)
);

-- ---------------------------------------------------------------------------
-- 3. Records: the permanent audit trail. Survives the session (and the
--    participant row) so a future manual ban can be built on top of it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.expulsion_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.table_sessions(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  target_user_id uuid REFERENCES public.users(id),
  target_web_name text,
  expelled_by text NOT NULL,
  staff_employee_id uuid REFERENCES public.employees(id),
  reason_type text NOT NULL,
  reason_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  readmitted boolean NOT NULL DEFAULT false,
  readmitted_by_employee_id uuid REFERENCES public.employees(id),
  readmission_comment text,
  readmitted_at timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.expulsion_records'::regclass
      AND conname = 'expulsion_records_expelled_by_check'
  ) THEN
    ALTER TABLE public.expulsion_records
      ADD CONSTRAINT expulsion_records_expelled_by_check
      CHECK (expelled_by IN ('majority', 'staff'));
  END IF;

  -- A record must identify who was expelled: a registered user or a guest name.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.expulsion_records'::regclass
      AND conname = 'expulsion_records_target_present_check'
  ) THEN
    ALTER TABLE public.expulsion_records
      ADD CONSTRAINT expulsion_records_target_present_check
      CHECK (target_user_id IS NOT NULL OR target_web_name IS NOT NULL);
  END IF;

  -- Readmission is staff-attributed and must say why.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.expulsion_records'::regclass
      AND conname = 'expulsion_records_readmission_check'
  ) THEN
    ALTER TABLE public.expulsion_records
      ADD CONSTRAINT expulsion_records_readmission_check
      CHECK (
        readmitted = false
        OR (readmitted_by_employee_id IS NOT NULL
            AND readmission_comment IS NOT NULL
            AND readmitted_at IS NOT NULL)
      );
  END IF;
END $$;

-- The re-join block reads these two indexes on every join attempt, and they
-- also make a double expulsion of the same diner impossible.
CREATE UNIQUE INDEX IF NOT EXISTS expulsion_records_one_active_per_user
  ON public.expulsion_records (session_id, target_user_id)
  WHERE readmitted = false AND target_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS expulsion_records_one_active_per_guest
  ON public.expulsion_records (session_id, target_web_name)
  WHERE readmitted = false AND target_user_id IS NULL AND target_web_name IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Lock requests: a diner asking to seal the table. entry_locked flips once
--    more than half of the currently active participants have asked.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.session_lock_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.table_sessions(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES public.session_participants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_lock_requests_one_per_participant UNIQUE (session_id, participant_id)
);
