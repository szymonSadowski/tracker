-- The fill-in pass and the commit sync report through the existing sync run table rather than a
-- parallel one (spec: github-data-sync "File-level data is backfilled progressively").

ALTER TABLE sync_runs DROP CONSTRAINT sync_runs_kind_check;
ALTER TABLE sync_runs ADD CONSTRAINT sync_runs_kind_check
  CHECK (kind IN ('backfill', 'incremental', 'reprocess', 'history', 'file_fill_in',
                  'commit_sync'));

ALTER TABLE sync_runs
  -- Why a run stopped short of finishing: a rate limit pause reads differently from a failure,
  -- and the fill-in pass pauses often by design.
  ADD COLUMN pause_reason text;
