## 1. Aggregate layer

- [x] 1.1 Add `contributorThroughputSeries` to `src/analysis/series.ts`, grouping merged pull
      requests by author over the shared bucket list
- [x] 1.2 Order by `lower(COALESCE(name, login))`, never by the metric
- [x] 1.3 Return only authors with at least one merged pull request in the period
- [x] 1.4 Mask buckets that ended before the author's earliest membership start as null; leave a
      contributor with no membership row unmasked
- [x] 1.5 Update the module header's D10 note to match the amended rule

## 2. Chart

- [x] 2.1 Add `ContributorThroughputChart` to `src/ui/metric-charts.tsx`
- [x] 2.2 Cap drawn series at `MAX_SELECTED_AUTHORS` (4) and render an over-cap chip as disabled
      text rather than a link
- [x] 2.3 Give `LineChart` an `emptyMessage` so an empty selection does not report an empty period
- [x] 2.4 Style `.series-picker` and `.chip-disabled` in `app/globals.css`

## 3. Team view

- [x] 3.1 Read `?authors=` on `/w/[workspaceId]`, dropping ids absent from the period
- [x] 3.2 Default to the first authors in name order when the parameter is absent
- [x] 3.3 Keep an explicitly empty selection expressible, so deselecting the last author holds
- [x] 3.4 Preserve period, team, granularity, and churn unit in the toggle links
- [x] 3.5 Drill through from a bucket to that author's pull requests

## 4. Tests

- [x] 4.1 Series ordered by name while the busiest author sorts last
- [x] 4.2 A quiet bucket is zero, not a gap
- [x] 4.3 An author with no merged pull request in the period is omitted
- [x] 4.4 A bucket before an author's membership start is a gap
- [x] 4.5 The chart renders the selected series and states the cap

## 5. Follow-up

- [ ] 5.1 Confirm the chart on the deployed team view once the prod data refresh lands
