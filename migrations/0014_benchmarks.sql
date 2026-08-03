-- Benchmark tiers (spec: metric-aggregation "Comparable metrics carry a benchmark tier",
-- design.md D8).
--
-- Seeded configuration rather than constants in code, so revising a threshold re-tiers existing
-- aggregates without recomputing them, and so a surface can name where the number came from
-- rather than presenting an industry study as a target the workspace set.

CREATE TABLE benchmark_thresholds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric      text NOT NULL,
  tier        text NOT NULL CHECK (tier IN ('elite', 'good', 'fair', 'needs_focus')),
  -- Half-open in metric units: the tier applies when lower_bound <= value < upper_bound. NULL is
  -- unbounded on that side.
  lower_bound double precision,
  upper_bound double precision,
  unit        text NOT NULL CHECK (unit IN ('seconds', 'lines', 'share', 'per_contributor_day')),
  source      text NOT NULL,
  study_date  date NOT NULL
);

CREATE UNIQUE INDEX benchmark_thresholds_metric_tier_idx ON benchmark_thresholds (metric, tier);

-- LinearB community benchmarks, 2026 study (8.1M+ pull requests, 4,813 teams), stated at p75.
-- The published bands are rounded and leave gaps between tiers; they are seeded contiguous here
-- so that every value falls in exactly one tier.
INSERT INTO benchmark_thresholds (metric, tier, lower_bound, upper_bound, unit, source, study_date)
VALUES
  ('cycle_time', 'elite',       NULL,    90000,  'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('cycle_time', 'good',        90000,   259200, 'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('cycle_time', 'fair',        259200,  579600, 'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('cycle_time', 'needs_focus', 579600,  NULL,   'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),

  ('coding_time', 'elite',       NULL,   3240,   'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('coding_time', 'good',        3240,   14400,  'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('coding_time', 'fair',        14400,  82800,  'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('coding_time', 'needs_focus', 82800,  NULL,   'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),

  ('pickup_time', 'elite',       NULL,   3600,   'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('pickup_time', 'good',        3600,   14400,  'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('pickup_time', 'fair',        14400,  57600,  'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('pickup_time', 'needs_focus', 57600,  NULL,   'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),

  ('review_time', 'elite',       NULL,   10800,  'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('review_time', 'good',        10800,  50400,  'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('review_time', 'fair',        50400,  86400,  'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('review_time', 'needs_focus', 86400,  NULL,   'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),

  ('time_to_approval', 'elite',       NULL,   36000,  'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('time_to_approval', 'good',        36000,  79200,  'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('time_to_approval', 'fair',        79200,  151200, 'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('time_to_approval', 'needs_focus', 151200, NULL,   'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),

  ('time_to_merge_after_approval', 'elite',       NULL,  3600,  'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('time_to_merge_after_approval', 'good',        3600,  10800, 'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('time_to_merge_after_approval', 'fair',        10800, 57600, 'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('time_to_merge_after_approval', 'needs_focus', 57600, NULL,  'seconds', 'LinearB community benchmarks 2026', DATE '2026-01-01'),

  ('pr_size', 'elite',       NULL, 100,  'lines', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('pr_size', 'good',        100,  156,  'lines', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('pr_size', 'fair',        156,  229,  'lines', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('pr_size', 'needs_focus', 229,  NULL, 'lines', 'LinearB community benchmarks 2026', DATE '2026-01-01'),

  -- Higher is better: the elite band is the open-ended one.
  ('pr_throughput', 'needs_focus', NULL, 0.66, 'per_contributor_day', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('pr_throughput', 'fair',        0.66, 1.2,  'per_contributor_day', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('pr_throughput', 'good',        1.2,  2.0,  'per_contributor_day', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('pr_throughput', 'elite',       2.0,  NULL, 'per_contributor_day', 'LinearB community benchmarks 2026', DATE '2026-01-01'),

  ('pr_maturity', 'needs_focus', NULL, 0.77, 'share', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('pr_maturity', 'fair',        0.77, 0.83, 'share', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('pr_maturity', 'good',        0.83, 0.89, 'share', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('pr_maturity', 'elite',       0.89, NULL, 'share', 'LinearB community benchmarks 2026', DATE '2026-01-01'),

  ('refactor_rate', 'elite',       NULL, 0.11, 'share', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('refactor_rate', 'good',        0.11, 0.17, 'share', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('refactor_rate', 'fair',        0.17, 0.23, 'share', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('refactor_rate', 'needs_focus', 0.23, NULL, 'share', 'LinearB community benchmarks 2026', DATE '2026-01-01'),

  ('rework_rate', 'elite',       NULL, 0.03, 'share', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('rework_rate', 'good',        0.03, 0.06, 'share', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('rework_rate', 'fair',        0.06, 0.09, 'share', 'LinearB community benchmarks 2026', DATE '2026-01-01'),
  ('rework_rate', 'needs_focus', 0.09, NULL, 'share', 'LinearB community benchmarks 2026', DATE '2026-01-01');
