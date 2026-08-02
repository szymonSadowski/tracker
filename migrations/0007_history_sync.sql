-- Member-requested history sync (spec: github-data-sync, design.md D3/D6).
--
-- Coverage depth becomes a recorded fact rather than something inferred from BACKFILL_WINDOW_DAYS,
-- so it stays true after the config changes and lets a surface tell "no pull requests in that
-- period" apart from "never fetched that far back".

ALTER TABLE repositories
  -- Earliest creation time from which pull request data is known complete. A floor, not an exact
  -- description of the row set: rows older than this may exist because they were updated inside
  -- the default backfill window (design.md R4).
  ADD COLUMN history_covered_from    timestamptz,
  -- True once the walk reached the repository's earliest pull request.
  ADD COLUMN history_complete        boolean NOT NULL DEFAULT false,
  -- Resume position for the created-at ordered walk. Distinct from backfill_cursor, which is a
  -- position in a differently-ordered connection (design.md D2).
  ADD COLUMN history_cursor          text,
  -- What the outstanding request asked for; NULL means "all history", and is only meaningful
  -- while history_state is not 'idle'.
  ADD COLUMN history_requested_from  timestamptz,
  ADD COLUMN history_state           text NOT NULL DEFAULT 'idle'
                                     CHECK (history_state IN ('idle', 'running', 'paused',
                                                              'complete', 'failed')),
  ADD COLUMN history_error           text;

-- Existing installations were backfilled under the bounded window, so their coverage starts there
-- rather than at the beginning of time (migration plan step 2).
UPDATE repositories
   SET history_covered_from = backfill_window_start
 WHERE backfill_state = 'complete' AND backfill_window_start IS NOT NULL;

-- Progress reporting reuses sync_runs rather than a parallel table (design.md D6).
ALTER TABLE sync_runs DROP CONSTRAINT sync_runs_kind_check;
ALTER TABLE sync_runs ADD CONSTRAINT sync_runs_kind_check
  CHECK (kind IN ('backfill', 'incremental', 'reprocess', 'history'));

-- Raw payloads stay attributable to the path that fetched them, so reprocessing keeps working.
ALTER TABLE github_raw_events DROP CONSTRAINT github_raw_events_source_check;
ALTER TABLE github_raw_events ADD CONSTRAINT github_raw_events_source_check
  CHECK (source IN ('graphql_backfill', 'graphql_history', 'rest_incremental', 'webhook'));
