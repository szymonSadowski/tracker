/**
 * What a surface says about the edge of its data (spec: analytics-dashboard "A viewer selects a
 * period reaching before synced coverage", "Coverage is complete but the period is empty").
 *
 * The distinction under test is the whole point of recording coverage: a period with no pull
 * requests is either genuinely quiet or never fetched, and the two must not read the same.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { databaseFixture } from '../helpers/db';
import { seedRepository, seedWorkspace } from '../helpers/factories';
import { syncStatus } from '../../src/repositories/store';
import { CoverageNotice, DataCompleteness } from '../../src/ui/components';
import { formatDay } from '../../src/ui/format';

const db = databaseFixture();

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const notice = (props: Parameters<typeof CoverageNotice>[0]) =>
  renderToStaticMarkup(createElement(CoverageNotice, props));

describe('coverage boundaries as days', () => {
  it('reads the same day for every viewer, whatever their timezone', () => {
    // Late in the UTC day: a viewer east of the meridian would see the next day, and one west of
    // it would see a day of coverage that was never fetched.
    expect(formatDay(new Date('2026-01-15T23:30:00.000Z'))).toBe('15 Jan 2026');
    expect(formatDay(new Date('2026-01-15T00:15:00.000Z'))).toBe('15 Jan 2026');
  });
});

describe('partial coverage notice', () => {
  it('names the date data begins when the period reaches back further', () => {
    const markup = notice({
      periodStart: day('2025-01-01'),
      coverageStart: day('2026-01-15'),
    });

    expect(markup).toContain('15 Jan 2026');
    expect(markup).toContain('begins before the data does');
  });

  it('says nothing for a period that sits entirely inside coverage', () => {
    expect(notice({ periodStart: day('2026-03-01'), coverageStart: day('2026-01-15') })).toEqual(
      '',
    );
  });

  it('says nothing when the period starts exactly at the coverage boundary', () => {
    expect(notice({ periodStart: day('2026-01-15'), coverageStart: day('2026-01-15') })).toEqual(
      '',
    );
  });

  it('points at the history sync rather than repeating it while one is running', () => {
    const running = notice({
      periodStart: day('2025-01-01'),
      coverageStart: day('2026-01-15'),
      historySyncing: [
        { id: 'r1', fullName: 'acme/api', coveredFrom: day('2026-01-15'), paused: false },
      ],
      historySyncHref: '/w/1/settings',
    });

    expect(running).toContain('already extending it');
    expect(running).not.toContain('href');
  });
});

describe('completeness while history is being added', () => {
  it('states that older data is arriving without suppressing the metrics', () => {
    const markup = renderToStaticMarkup(
      createElement(DataCompleteness, {
        backfilling: [],
        failing: [],
        lastSuccessAt: day('2026-04-01'),
        isOwner: true,
        historySyncing: [
          { id: 'r1', fullName: 'acme/api', coveredFrom: day('2026-01-15'), paused: false },
        ],
      }),
    );

    expect(markup).toContain('Older pull requests are still being added');
    expect(markup).toContain('acme/api');
    expect(markup).toContain('15 Jan 2026');
    expect(markup).toContain('periods already covered are unaffected');
  });

  it('words a rate limit pause as a pause, not as a failure', () => {
    const markup = renderToStaticMarkup(
      createElement(DataCompleteness, {
        backfilling: [],
        failing: [],
        lastSuccessAt: null,
        isOwner: true,
        historySyncing: [
          { id: 'r1', fullName: 'acme/api', coveredFrom: day('2026-01-15'), paused: true },
        ],
      }),
    );

    expect(markup).toContain('paused for rate limits');
    expect(markup).not.toContain('failed');
  });
});

describe('workspace coverage', () => {
  it('reports the latest repository boundary, since a period is covered only if all are', async () => {
    const workspace = await seedWorkspace(db());
    await seedRepository(db(), workspace.id, {
      name: 'deep',
      historyCoveredFrom: day('2024-01-01'),
    });
    await seedRepository(db(), workspace.id, {
      name: 'shallow',
      historyCoveredFrom: day('2026-01-15'),
    });

    const status = await syncStatus(db(), workspace.id);

    expect(status.coverageStart).toEqual(day('2026-01-15'));
  });

  it('is unbounded by a repository that has reached its first pull request', async () => {
    const workspace = await seedWorkspace(db());
    await seedRepository(db(), workspace.id, {
      name: 'complete',
      historyCoveredFrom: day('2020-01-01'),
      historyComplete: true,
    });
    await seedRepository(db(), workspace.id, {
      name: 'shallow',
      historyCoveredFrom: day('2026-01-15'),
    });

    const status = await syncStatus(db(), workspace.id);

    expect(status.coverageStart).toEqual(day('2026-01-15'));
    expect(status.coverage.map((entry) => entry.historyComplete)).toEqual([true, false]);
  });
});
