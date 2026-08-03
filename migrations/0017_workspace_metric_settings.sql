-- Workspace-level metric configuration (spec: pr-metrics "A path is excluded from churn",
-- metric-aggregation "Bucket boundaries are evaluated in the workspace's time zone").
--
-- The churn settings participate in the definition revision recorded on every analysis row, so
-- changing one is detectable and triggers a targeted recompute rather than silently reinterpreting
-- stored numbers.

CREATE TABLE workspace_metric_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  -- IANA name. Bucket boundaries are evaluated here so a merge near midnight lands in the bucket
  -- the workspace would say it did.
  time_zone    text NOT NULL DEFAULT 'UTC',
  -- Code changed within this many days of when it was written counts as rework rather than
  -- refactor (design.md D2).
  rework_recency_days integer NOT NULL DEFAULT 21 CHECK (rework_recency_days > 0),
  -- Paths whose lines are excluded from every churn category and from the total. Glob patterns.
  churn_exclusion_patterns text[] NOT NULL DEFAULT ARRAY[
    '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/Cargo.lock',
    '**/go.sum', '**/*.lock', '**/vendor/**', '**/generated/**', '**/*.generated.*',
    '**/dist/**', '**/build/**', '**/node_modules/**', '**/*.min.js', '**/*.snap'
  ]::text[],
  -- Below this many contributing pull requests a percentile is suppressed rather than computed
  -- from a handful (spec: metric-aggregation "Too few pull requests to aggregate").
  min_sample_size integer NOT NULL DEFAULT 5 CHECK (min_sample_size > 0),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
