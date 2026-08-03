-- Review comments (spec: github-data-sync, pr-metrics "Review depth measures review conversation").
--
-- Both comments attached to a review submission and comments left on the diff land here, keyed by
-- GitHub node id so the two ingestion paths write one row per comment.

CREATE TABLE pr_review_comments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  pull_request_id       uuid NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,
  -- NULL for a standalone diff thread comment not attached to a review submission.
  review_id             uuid REFERENCES pr_reviews (id) ON DELETE SET NULL,
  author_contributor_id uuid REFERENCES contributors (id) ON DELETE SET NULL,
  node_id               text NOT NULL,
  submitted_at          timestamptz NOT NULL,
  ingested_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX pr_review_comments_node_idx ON pr_review_comments (workspace_id, node_id);
CREATE INDEX pr_review_comments_pr_idx
  ON pr_review_comments (workspace_id, pull_request_id, submitted_at);

ALTER TABLE pull_requests
  -- When comment data was last collected for this pull request. Distinguishes "no comments were
  -- left" (review depth zero) from "we never asked" (review depth absent) — spec: pr-metrics.
  ADD COLUMN review_comments_ingested_at timestamptz;
