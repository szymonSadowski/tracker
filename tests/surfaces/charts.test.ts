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
  CycleTimePhaseChart,
  MAX_SELECTED_AUTHORS,
  ThroughputChart,
  WorkMixView,
} from '../../src/ui/metric-charts';
import { LineChart, StackedBarChart, seriesEncoding } from '../../src/ui/charts';
import { parseGranularity } from '../../src/ui/format';
import type { ContributorThroughput, MetricBucket, WorkMixBucket } from '../../src/analysis/series';

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
