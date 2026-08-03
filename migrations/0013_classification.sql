-- Work classification (spec: work-classification, design.md D6).
--
-- Probabilistic results live in their own table, deliberately: nothing here may alter a
-- deterministic metric, and dropping the table leaves every other number intact.

ALTER TABLE pull_requests
  -- The description. Part of the classification input, and the only pull request field this
  -- change adds to the normalized record.
  ADD COLUMN body text;

CREATE TABLE pr_classifications (
  workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  pull_request_id uuid NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,

  -- 'failed' keeps the attempt observable while leaving the pull request unclassified: work_type
  -- stays NULL and no fallback type is ever assigned (spec: "degrade to absence, never a default").
  status          text NOT NULL CHECK (status IN ('classified', 'failed')),
  work_type       text CHECK (work_type IN ('feature', 'bug_fix', 'refactor', 'chore',
                                            'documentation', 'test', 'dependency')),
  confidence      double precision,
  rationale       text,
  failure_reason  text,

  -- Hash over (title, body, commit messages, changed paths). Unchanged hash at the current
  -- revision means no provider call (spec: "versioned and content-addressed").
  content_hash           text NOT NULL,
  classification_version text NOT NULL,

  human_corrected boolean NOT NULL DEFAULT false,
  corrected_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace_id, pull_request_id),
  CHECK ((status = 'classified') = (work_type IS NOT NULL))
);

CREATE INDEX pr_classifications_type_idx ON pr_classifications (workspace_id, work_type);
CREATE INDEX pr_classifications_version_idx
  ON pr_classifications (workspace_id, classification_version);

CREATE TABLE workspace_classification_settings (
  workspace_id         uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  -- Off by default: the deterministic product is verified in production before an external
  -- dependency is added to it (design.md migration plan step 8).
  enabled              boolean NOT NULL DEFAULT false,
  -- Spend bound per period, in cents. NULL means unbounded.
  spend_bound_cents    integer,
  spend_consumed_cents integer NOT NULL DEFAULT 0,
  spend_period_start   timestamptz NOT NULL DEFAULT now(),
  -- Set when a bound stopped the work. Classification pauses rather than failing, and owners can
  -- read why (spec: "Classification work is bounded and observable").
  paused_reason        text,
  confidence_threshold double precision NOT NULL DEFAULT 0.6,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
