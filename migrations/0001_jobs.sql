-- Job queue (design.md D11). Lives in the same database as the data being written so that
-- enqueueing can join the caller's transaction.

CREATE TABLE jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  state        text NOT NULL DEFAULT 'pending'
               CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  priority     integer NOT NULL DEFAULT 100,
  run_after    timestamptz NOT NULL DEFAULT now(),
  -- Set while a worker holds the job; a stale lock is reclaimable after a timeout so a job
  -- survives a worker that dies mid-run.
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  -- Collapses redundant work (e.g. two on-demand syncs for one repository) while pending.
  dedupe_key   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

CREATE INDEX jobs_claim_idx ON jobs (state, run_after, priority) WHERE state = 'pending';
CREATE INDEX jobs_workspace_idx ON jobs (workspace_id, state);
CREATE UNIQUE INDEX jobs_dedupe_pending_idx ON jobs (workspace_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('pending', 'running');

-- Periodic work is recorded here and turned into jobs by the scheduler; the schedule itself
-- never executes work (design.md D11).
CREATE TABLE scheduled_tasks (
  name          text PRIMARY KEY,
  interval_seconds integer NOT NULL,
  next_run_at   timestamptz NOT NULL DEFAULT now(),
  last_run_at   timestamptz,
  enabled       boolean NOT NULL DEFAULT true
);
