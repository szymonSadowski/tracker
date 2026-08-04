/**
 * Chart surfaces (spec: analytics-dashboard).
 *
 * Charts render on the server, so they can be rendered to a string and read as markup. What is
 * asserted here is the honesty the spec asks of them: an uncovered bucket is visibly uncovered and
 * never drawn as zero, a churn chart states from when its data exists, and a work-mix surface with
 * classification off says so without disturbing anything else.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ChurnChart,
  ContributorThroughputChart,
  CumulativeThroughputChart,
  CycleTimePhaseChart,
  MAX_SELECTED_AUTHORS,
  ThroughputChart,
  WorkMixView,
} from '../../src/ui/metric-charts';
import { LineChart, MAX_EVENT_MARKS, StackedBarChart, seriesEncoding } from '../../src/ui/charts';
import { parseGranularity } from '../../src/ui/format';
import type {
  ContributorThroughput,
  MergeEventSeries,
  MetricBucket,
  WorkMixBucket,
} from '../../src/analysis/series';

const emptySummary = {
  p50: null,
  p75: null,
  p90: null,
  mean: null,
  contributing: 0,
  excluded: 0,
  suppressed: false,
};

function bucket(overrides: Partial<MetricBucket> & { label: string }): MetricBucket {
  return {
    start: new Date('2026-05-01T00:00:00Z'),
    end: new Date('2026-05-02T00:00:00Z'),
    outsideCoverage: false,
    mergedCount: 0,
    contributors: 0,
    throughputPerContributor: null,
    throughputPerContributorDay: null,
    denominatorMissing: false,
    latency: {
      cycle_time: emptySummary,
      coding_time: emptySummary,
      pickup_time: emptySummary,
      review_time: emptySummary,
      time_to_first_review: emptySummary,
      time_to_approval: emptySummary,
      time_to_merge_after_approval: emptySummary,
    },
    size: emptySummary,
    churn: null,
    prMaturity: emptySummary,
    reviewDepth: emptySummary,
    commits: 0,
    ...overrides,
  };
}

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element);

describe('a partially covered series', () => {
  it('renders uncovered buckets distinctly and never as zero', () => {
    const html = render(
      ThroughputChart({
        buckets: [
          bucket({ label: 'week 1', outsideCoverage: true, throughputPerContributor: 4 }),
          bucket({ label: 'week 2', throughputPerContributor: 4, mergedCount: 8 }),
        ],
      }),
    );

    // The uncovered bucket is hatched…
    expect(html).toContain('url(#hatch-');
    // …named as uncovered in the note…
    expect(html).toContain('outside recorded coverage');
    // …and reported as unavailable in the value table rather than as a number.
    expect(html).toContain('outside coverage');
    expect(html).toContain('Not available');
  });

  it('breaks the line at an absent bucket rather than dropping it to zero', () => {
    const html = render(
      LineChart({
        title: 'Throughput',
        series: [
          {
            name: 'Per contributor',
            points: [
              { label: 'a', value: 4 },
              { label: 'b', value: null },
              { label: 'c', value: 4 },
            ],
          },
        ],
        format: (value) => (value === null ? 'Not available' : String(value)),
      }),
    );

    // Two separate paths — one per run of present values — is the gap.
    expect([...html.matchAll(/<path /g)]).toHaveLength(2);
    expect(html).not.toContain('L0,');
  });

  it('exposes every value as text and labels each series without relying on colour', () => {
    const html = render(
      CycleTimePhaseChart({
        buckets: [
          bucket({
            label: 'week 1',
            mergedCount: 4,
            latency: {
              ...bucket({ label: 'x' }).latency,
              coding_time: { ...emptySummary, p50: 3600, contributing: 4 },
              pickup_time: { ...emptySummary, p50: 1800, contributing: 4 },
              review_time: { ...emptySummary, p50: 7200, contributing: 4 },
            },
          }),
        ],
      }),
    );

    expect(html).toContain('visually-hidden');
    expect(html).toContain('Coding time');
    expect(html).toContain('Pickup time');
    expect(html).toContain('Review time');
    // Each series carries its encoding as well as its label, and a chart drawn with filled areas
    // describes its series with filled swatches rather than line swatches.
    expect(html).toContain('chart-key-fill');
    expect(html).toContain(`chart-key-${seriesEncoding(1).key}`);
    // The decomposition says how much of the bucket it accounts for.
    expect(html).toContain('covers 4 of 4 merged pull requests');
  });
});

/**
 * A value present in a bucket is visible whatever its neighbours are (spec: "Only one bucket in a
 * series has a value", "A value sits between two absent buckets"). A run of one point strokes a
 * bare moveto, which draws nothing — the marker is what gives every run a form.
 */
describe('an isolated value', () => {
  const line = (values: readonly (number | null)[]) =>
    render(
      LineChart({
        title: 'Throughput',
        series: [
          {
            name: 'Per contributor',
            points: values.map((value, index) => ({ label: `b${index}`, value })),
          },
        ],
        format: (value) => (value === null ? 'Not available' : String(value)),
      }),
    );

  it('draws a mark for the only populated bucket in a series', () => {
    const html = line([null, null, 4, null, null]);

    expect([...html.matchAll(/<circle /g)]).toHaveLength(1);
  });

  it('draws every alternating value and connects none of them across a gap', () => {
    const html = line([4, null, 6, null, 5]);

    expect([...html.matchAll(/<circle /g)]).toHaveLength(3);
    // A lineto would be a segment drawn through a bucket that has no value.
    expect(html).not.toMatch(/d="M[^"]*L/);
  });
});

describe('a stacked chart over shares', () => {
  const shares = (name: string, value: number) => ({
    name,
    points: [{ label: 'week 1', value }],
  });
  // Rounded independently, these are what `series.ts` used to report: a whole plus one part in a
  // thousand.
  const drifted = [shares('New code', 0.5), shares('Refactor', 0.3), shares('Rework', 0.201)];
  const format = (value: number | null) =>
    value === null ? 'Not available' : `${Math.round(value * 100)}%`;

  it('scales to the declared ceiling rather than to what the data rounded to', () => {
    const html = render(
      StackedBarChart({ title: 'Change composition', series: drifted, format, max: 1 }),
    );

    // 100%, not the 200% `niceMax` returns for a total of 1.001.
    expect(html).toContain('>100%<');
    const segments = [...html.matchAll(/<rect[^>]*chart-mark[^>]*>/g)].map((match) =>
      Number(/height="([\d.]+)"/.exec(match[0])![1]),
    );
    // The plot is 180 units tall; the stack fills it rather than reaching half way.
    expect(segments.reduce((sum, height) => sum + height, 0)).toBeGreaterThan(175);
  });

  it('gives each legend swatch the encoding its own marks carry', () => {
    const html = render(StackedBarChart({ title: 'Change composition', series: drifted, format }));

    drifted.forEach((_, index) => {
      const key = seriesEncoding(index).key;
      expect(html).toContain(`chart-key chart-key-fill chart-key-${key}`);
      expect(html).toContain(`chart-mark chart-mark-${key}`);
    });
  });
});

describe('the churn chart', () => {
  it('states from when churn data exists when the period predates file coverage', () => {
    const html = render(
      ChurnChart({
        buckets: [
          bucket({ label: 'week 1', outsideCoverage: true }),
          bucket({
            label: 'week 2',
            churn: {
              newCodeLines: 80,
              refactorLines: 15,
              reworkLines: 5,
              excludedLines: 0,
              newCodeShare: 0.8,
              refactorShare: 0.15,
              reworkShare: 0.05,
              contributing: 4,
              excluded: 0,
              usedRecencyEstimate: true,
            },
          }),
        ],
        coveredFrom: new Date('2026-05-08T00:00:00Z'),
        reworkThreshold: 0.09,
      }),
    );

    expect(html).toContain('Per-file diff data exists from 2026-05-08 onwards');
    // The approximation is named where the number appears, not only in the docs (design.md D2).
    expect(html).toContain('file-level recency approximation');
  });

  it('marks a bucket at or above the needs-focus rework threshold', () => {
    const html = render(
      ChurnChart({
        buckets: [
          bucket({
            label: 'week 2',
            churn: {
              newCodeLines: 50,
              refactorLines: 20,
              reworkLines: 30,
              excludedLines: 0,
              newCodeShare: 0.5,
              refactorShare: 0.2,
              reworkShare: 0.3,
              contributing: 4,
              excluded: 0,
              usedRecencyEstimate: false,
            },
          }),
        ],
        reworkThreshold: 0.09,
      }),
    );

    // The rule answers "how far above", the bucket marker answers "which one", and the note
    // answers both for a viewer who can read neither mark (design.md D5).
    expect(html).toContain('chart-threshold');
    expect(html).toContain('chart-bucket-mark');
    expect(html).toContain('needs-focus rework threshold');
    expect(html).toContain('week 2');
  });

  it('says the threshold is not drawn in line-count mode rather than dropping it silently', () => {
    const html = render(
      ChurnChart({
        buckets: [bucket({ label: 'week 2' })],
        reworkThreshold: 0.09,
        absolute: true,
      }),
    );

    expect(html).not.toContain('chart-threshold');
    expect(html).toContain('not drawn on the line-count view');
  });
});

describe('the work mix surface', () => {
  const classified: WorkMixBucket = {
    start: new Date('2026-05-01T00:00:00Z'),
    end: new Date('2026-05-08T00:00:00Z'),
    label: 'week 1',
    classified: 4,
    unclassified: 2,
    byType: { feature: 2, bug_fix: 1, chore: 1 },
    defectRatio: 0.25,
    innovationRatio: 0.5,
  };

  it('shows the off state when classification is disabled, and says other surfaces are unaffected', () => {
    const html = render(WorkMixView({ buckets: [], enabled: false }));

    expect(html).toContain('Classification is off for this workspace');
    expect(html).toContain('Every other metric on this page is unaffected');
  });

  it('reports the ratios over the classified subset with the remainder stated', () => {
    const html = render(
      WorkMixView({ buckets: [classified], enabled: true, drillThrough: '/pulls?period=30' }),
    );

    expect(html).toContain('Defect ratio 25%');
    expect(html).toContain('innovation ratio 50%');
    expect(html).toContain('2 pull request(s) in this period are not yet classified');
    // Segment drill-through is a plain link.
    expect(html).toContain('workType=bug_fix');
  });
});

describe('granularity', () => {
  it('re-buckets without changing the period, and defaults to the period’s own scale', () => {
    expect(parseGranularity('month', 30)).toBe('month');
    expect(parseGranularity(undefined, 7)).toBe('day');
    expect(parseGranularity(undefined, 30)).toBe('week');
    expect(parseGranularity(undefined, 365)).toBe('month');
    // An unrecognised value falls back rather than erroring.
    expect(parseGranularity('fortnight', 30)).toBe('week');
  });
});

describe('per-author throughput chart', () => {
  const throughput: ContributorThroughput = {
    buckets: [
      {
        start: new Date('2026-05-01T00:00:00Z'),
        end: new Date('2026-05-02T00:00:00Z'),
        label: '1 May',
        outsideCoverage: false,
      },
      {
        start: new Date('2026-05-02T00:00:00Z'),
        end: new Date('2026-05-03T00:00:00Z'),
        label: '2 May',
        outsideCoverage: false,
      },
    ],
    contributors: [
      { contributorId: 'a', name: 'Ada', login: 'ada', points: [3, 0] },
      { contributorId: 'b', name: 'Bob', login: 'bob', points: [1, 2] },
      { contributorId: 'c', name: 'Cyd', login: 'cyd', points: [null, 4] },
      { contributorId: 'd', name: 'Dee', login: 'dee', points: [2, 2] },
      { contributorId: 'e', name: 'Eve', login: 'eve', points: [1, 1] },
    ],
  };

  it('draws only the selected authors and offers the rest', () => {
    const html = render(
      ContributorThroughputChart({
        data: throughput,
        selected: ['a', 'b'],
        hrefFor: (id) => `/w/1?authors=${id}`,
      }),
    );

    // Every author is offered in the picker, whether or not their line is drawn.
    for (const name of ['Ada', 'Bob', 'Cyd', 'Dee', 'Eve']) expect(html).toContain(name);
    // The value table carries the drawn series and not the undrawn ones.
    expect(html).toContain('2 of 5 shown');
  });

  it('stops offering more authors at the cap and says why', () => {
    const html = render(
      ContributorThroughputChart({
        data: throughput,
        selected: ['a', 'b', 'c', 'd'],
        hrefFor: (id) => `/w/1?authors=${id}`,
      }),
    );

    expect(html).toContain('chip-disabled');
    expect(html).toContain(`${MAX_SELECTED_AUTHORS} is the limit`);
  });

  it('reports an empty selection as a choice, not as an empty period', () => {
    const html = render(
      ContributorThroughputChart({
        data: throughput,
        selected: [],
        hrefFor: (id) => `/w/1?authors=${id}`,
      }),
    );

    expect(html).toContain('No authors selected.');
    expect(html).not.toContain('No buckets in this period.');
  });
});

/**
 * The two throughput variants (design.md D8). They plot different quantities, so each says which
 * one it is: a rate on the team, where the denominator is other people, and a count on the
 * personal view, where the denominator would be the viewer themselves.
 */
describe('the throughput chart variants', () => {
  const tier = {
    metric: 'pr_throughput',
    tier: 'elite' as const,
    lowerBound: 1,
    upperBound: null,
    unit: 'count' as const,
    source: 'A published study',
    studyDate: new Date('2026-01-01T00:00:00Z'),
    thresholds: [],
  };

  it('states counts on the personal variant, with no tier and no per-contributor claim', () => {
    const html = render(
      ThroughputChart({
        variant: 'count',
        buckets: [bucket({ label: 'week 1', mergedCount: 8, throughputPerContributor: 4 })],
        // Offered and ignored: a published band stated per contributor per day says nothing about
        // a raw count, and the personal view presents no tier for the viewer's own values.
        benchmark: tier,
      }),
    );

    expect(html).toContain('Merged pull requests');
    expect(html).not.toContain('per contributor');
    expect(html).not.toContain('benchmark-tier');
    expect(html).not.toContain('Published industry data');
    // The count, not the rate that shares its bucket.
    expect(html).toContain('>8<');
  });

  it('keeps the rate and its tier on the team variant', () => {
    const html = render(
      ThroughputChart({
        buckets: [bucket({ label: 'week 1', mergedCount: 8, throughputPerContributor: 4 })],
        benchmark: tier,
      }),
    );

    expect(html).toContain('PR throughput per contributor');
    expect(html).toContain('benchmark-tier');
    expect(html).toContain('Published industry data');
  });

  it('says a bucket with merges and no denominator is a count standing in for a rate', () => {
    const html = render(
      ThroughputChart({
        buckets: [
          bucket({
            label: 'week 1',
            mergedCount: 3,
            throughputPerContributor: 3,
            denominatorMissing: true,
          }),
        ],
      }),
    );

    // Legible rather than silent: the number moved, and the chart says why (design.md D9).
    expect(html).toContain('standing in for a rate');
  });
});

/**
 * The cumulative event chart (spec: "Merged throughput is presentable per pull request").
 *
 * Its correctness condition is structural: the line starts at zero where the period starts and is
 * carried flat to where it ends, so its final value is the period's total rather than wherever the
 * last merge happened to fall (design.md D3).
 */
describe('the cumulative merge chart', () => {
  const periodStart = new Date('2026-05-01T00:00:00Z');
  const periodEnd = new Date('2026-05-11T00:00:00Z');
  const hours = (n: number) => new Date(periodStart.getTime() + n * 3600_000);

  const events = (count: number, spacingHours = 12): MergeEventSeries => ({
    contributors: [
      {
        contributorId: 'a',
        name: 'Ada',
        login: 'ada',
        truncated: false,
        events: Array.from({ length: count }, (_, index) => ({
          pullRequestId: `pr-${index}`,
          number: 100 + index,
          title: `Change ${index}`,
          url: `https://github.com/acme/repo/pull/${100 + index}`,
          repositoryFullName: 'acme/repo',
          mergedAt: hours((index + 1) * spacingHours),
        })),
      },
    ],
    coverageStart: null,
    truncated: false,
  });

  const cumulative = (data: MergeEventSeries) =>
    render(CumulativeThroughputChart({ data, periodStart, periodEnd }));

  const pathOf = (html: string): string => /<path[^>]*\sd="([^"]+)"/.exec(html)![1]!;

  it('steps horizontally then vertically, with no diagonal between events', () => {
    const path = pathOf(cumulative(events(3)));

    // Every segment is an axis-aligned move. A lineto would draw a fractional pull request at an
    // instant the total was not that (design.md D2).
    expect(path).not.toContain('L');
    expect(path).toMatch(/^M[\d.]+,[\d.]+(?: H[\d.]+ V[\d.]+)+ H[\d.]+$/);
  });

  it('starts at zero at the period start and holds its final value to the period end', () => {
    const path = pathOf(cumulative(events(2)));

    // The plot's left edge at the baseline: 44 across, 192 down.
    expect(path.startsWith('M44,192')).toBe(true);
    // …and carried to the right edge at the height of the last event, which is the period total.
    expect(path.endsWith('H708')).toBe(true);
    const verticals = [...path.matchAll(/V([\d.]+)/g)].map((match) => Number(match[1]));
    // Two events over a ceiling of two: the last one reaches the top of the plot.
    expect(verticals.at(-1)).toBe(12);
  });

  it('thins the marks past the cap while the line and the table keep every event', () => {
    const count = MAX_EVENT_MARKS + 20;
    const html = cumulative(events(count, 1));

    const marks = [...html.matchAll(/<circle /g)];
    expect(marks.length).toBeLessThanOrEqual(MAX_EVENT_MARKS);
    expect(marks.length).toBeLessThan(count);
    // The guarantee is on the path and the text, never on the circle count (design.md D5).
    expect([...pathOf(html).matchAll(/V/g)]).toHaveLength(count);
    expect([...html.matchAll(/<tr>/g)]).toHaveLength(count + 1);
    // Including the ones no longer drawn.
    expect(html).toContain(`#${100 + count - 1} Change ${count - 1}`);
  });

  it('links each drawn mark to its pull request and names it by number and title', () => {
    const html = cumulative(events(2));

    expect(html).toContain('href="https://github.com/acme/repo/pull/100"');
    expect(html).toContain('#100 Change 0');
    // The identity is in the mark's own title, so a pointer reveals it without a tooltip layer.
    expect(html).toMatch(/<title>[^<]*#100 Change 0[^<]*<\/title>/);
  });

  it('hatches and names the span of the period before coverage', () => {
    const html = render(
      CumulativeThroughputChart({
        data: { ...events(2), coverageStart: new Date('2026-05-04T00:00:00Z') },
        periodStart,
        periodEnd,
      }),
    );

    expect(html).toContain('url(#hatch-');
    expect(html).toContain('fall outside recorded coverage');
    // Missing data, not a quiet stretch: the two must not read the same.
    expect(html).toContain('missing data rather than a quiet stretch');
  });

  it('states that nothing merged rather than drawing a line at zero', () => {
    const html = render(
      CumulativeThroughputChart({
        data: { contributors: [], coverageStart: null, truncated: false },
        periodStart,
        periodEnd,
      }),
    );

    expect(html).toContain('No pull requests merged in this period.');
    // A flat line at zero would assert a measurement over a span that may not even be covered.
    expect(html).not.toContain('<path');
    expect(html).not.toContain('No buckets in this period.');
  });

  it('says when the cap trimmed events rather than ending short in silence', () => {
    const html = cumulative({ ...events(2), truncated: true });

    expect(html).toContain('stops short of the count stated above');
  });
});
