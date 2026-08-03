-- Re-anchor first_commit_at on the commit author date (spec: pr-metrics "Latency metrics use
-- explicit anchors").
--
-- first_commit_at was the earliest committer date. Rebase, squash, amend, and cherry-pick all
-- rewrite that to the moment of the rewrite, so a branch tidied onto the default branch just
-- before its pull request was opened reported every commit as seconds old. Coding time
-- (first commit -> ready for review) then measured the rebase, collapsing to near zero, and cycle
-- time was understated with it because its anchor is the earlier of first commit and ready.
--
-- The author date survives all four and was already being persisted on pr_commits, so this is a
-- backfill rather than a re-fetch: no GitHub API traffic, and repositories whose coverage would be
-- expensive to walk again are corrected in place.
--
-- Only rows that actually have commit history are touched. A pull request whose commits were never
-- ingested keeps its NULL, which is what makes coding time absent rather than wrong for it.

UPDATE pull_requests p
   SET first_commit_at = c.first_authored_at
  FROM (
         SELECT pull_request_id,
                min(COALESCE(authored_at, committed_at)) AS first_authored_at
           FROM pr_commits
          GROUP BY pull_request_id
       ) c
 WHERE c.pull_request_id = p.id
   AND c.first_authored_at IS DISTINCT FROM p.first_commit_at;

-- The stored analysis rows still hold the old coding and cycle times; they are derived from the
-- columns above and are not recomputed by a migration. Run `npm run recompute` after this to
-- refresh them.
