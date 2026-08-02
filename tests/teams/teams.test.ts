import { describe, expect, it } from 'vitest';
import { databaseFixture } from '../helpers/db';
import {
  at,
  seedContributor,
  seedPullRequest,
  seedRepository,
  seedReview,
  seedWorkspace,
} from '../helpers/factories';
import { workspaceScope } from '../../src/db/scope';
import {
  assignContributor,
  createTeam,
  deleteTeam,
  listRoster,
  listTeams,
  renameTeam,
  TeamNameTakenError,
  unassignedContributors,
} from '../../src/teams/store';
import { analyzePullRequest } from '../../src/analysis/service';
import { teamMetrics, unassignedActivity } from '../../src/analysis/aggregate';
import { mapGraphQLPullRequest } from '../../src/ingest/graphql-map';
import { graphqlPullRequest } from '../helpers/github-fixtures';
import { persistPullRequest } from '../../src/ingest/normalize';

const db = databaseFixture();

const period = {
  start: new Date('2026-01-01T00:00:00Z'),
  end: new Date('2027-01-01T00:00:00Z'),
  label: '',
};

async function fixture() {
  const workspace = await seedWorkspace(db());
  const repository = await seedRepository(db(), workspace.id);
  const scope = workspaceScope(db(), workspace.id);
  return { workspaceId: workspace.id, repositoryId: repository.id, scope };
}

async function analyzeAll() {
  const { rows } = await db().query<{ id: string }>('SELECT id FROM pull_requests');
  for (const row of rows) await db().transaction((tx) => analyzePullRequest(tx, row.id));
}

describe('roster', () => {
  it('contains the accounts with activity, not every organization member', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const author = await seedContributor(db(), workspaceId, { login: 'ada' });
    const reviewer = await seedContributor(db(), workspaceId, { login: 'bob' });
    await seedContributor(db(), workspaceId, { login: 'never-touched-a-pr' });

    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(4),
    });
    await seedReview(db(), {
      workspaceId,
      pullRequestId: pr.id,
      reviewerContributorId: reviewer.id,
      submittedAt: at(1),
    });

    const roster = await listRoster(scope);

    expect(roster.map((entry) => entry.login)).toEqual(['ada', 'bob']);
    expect(roster.find((entry) => entry.login === 'ada')).toMatchObject({
      authoredCount: 1,
      teamId: null,
    });
    expect(roster.find((entry) => entry.login === 'bob')).toMatchObject({ reviewedCount: 1 });
  });

  it('keeps bots out of the roster while retaining their data', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const bot = await seedContributor(db(), workspaceId, { login: 'renovate', isBot: true });
    await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: bot.id,
      mergedAt: at(1),
    });

    expect(await listRoster(scope)).toEqual([]);
    expect(await listRoster(scope, { includeBots: true })).toHaveLength(1);
    expect((await db().query('SELECT id FROM pull_requests')).rows).toHaveLength(1);
  });

  it('adds a newly seen contributor as unassigned at ingest', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();

    await db().transaction((tx) =>
      persistPullRequest(tx, {
        workspaceId,
        repositoryId,
        pullRequest: mapGraphQLPullRequest(graphqlPullRequest()),
        source: 'graphql_backfill',
      }),
    );

    const unassigned = await unassignedContributors(scope);
    expect(unassigned.map((entry) => entry.login).sort()).toEqual(['ada', 'bob']);
    expect(unassigned.every((entry) => entry.teamId === null)).toBe(true);
  });

  it('does not order the roster by activity', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const zoe = await seedContributor(db(), workspaceId, { login: 'zoe' });
    const ada = await seedContributor(db(), workspaceId, { login: 'ada' });
    // zoe is far more prolific; the roster is still alphabetical (design.md D10).
    for (let i = 0; i < 5; i++) {
      await seedPullRequest(db(), {
        workspaceId,
        repositoryId,
        authorContributorId: zoe.id,
        mergedAt: at(2),
      });
    }
    await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: ada.id,
      mergedAt: at(2),
    });

    expect((await listRoster(scope)).map((entry) => entry.login)).toEqual(['ada', 'zoe']);
  });
});

describe('teams', () => {
  it('creates, renames, and refuses duplicate names', async () => {
    const { scope } = await fixture();
    const team = await createTeam(scope, 'Platform');

    expect((await listTeams(scope)).map((t) => t.name)).toEqual(['Platform']);
    await expect(createTeam(scope, 'platform')).rejects.toBeInstanceOf(TeamNameTakenError);

    await renameTeam(scope, team.id, 'Platform & Infra');
    expect((await listTeams(scope))[0]!.name).toBe('Platform & Infra');
  });

  it('moves a contributor’s pull requests to their new team', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const contributor = await seedContributor(db(), workspaceId, { login: 'ada' });
    await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: contributor.id,
      mergedAt: at(4),
    });
    await analyzeAll();

    const teamA = await createTeam(scope, 'A');
    const teamB = await createTeam(scope, 'B');
    await assignContributor(scope, contributor.id, teamA.id);

    const beforeA = await teamMetrics(scope, {
      period,
      repositoryIds: [repositoryId],
      teamId: teamA.id,
    });
    expect(beforeA.mergedCount).toBe(1);

    await assignContributor(scope, contributor.id, teamB.id);

    expect(
      (await teamMetrics(scope, { period, repositoryIds: [repositoryId], teamId: teamA.id }))
        .mergedCount,
    ).toBe(0);
    expect(
      (await teamMetrics(scope, { period, repositoryIds: [repositoryId], teamId: teamB.id }))
        .mergedCount,
    ).toBe(1);
    // At most one team per contributor.
    const { rows } = await db().query(
      'SELECT team_id FROM team_members WHERE contributor_id = $1',
      [contributor.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('deleting a team unassigns its members and deletes no pull request data', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const contributor = await seedContributor(db(), workspaceId, { login: 'ada' });
    await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: contributor.id,
      mergedAt: at(4),
    });
    await analyzeAll();
    const team = await createTeam(scope, 'Platform');
    await assignContributor(scope, contributor.id, team.id);

    await deleteTeam(scope, team.id);

    expect(await listTeams(scope)).toEqual([]);
    expect((await unassignedContributors(scope)).map((entry) => entry.login)).toEqual(['ada']);
    expect((await db().query('SELECT id FROM pull_requests')).rows).toHaveLength(1);
    expect((await db().query('SELECT pull_request_id FROM pr_analysis')).rows).toHaveLength(1);
  });

  it('reports unassigned activity so team totals are never silently incomplete', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const assigned = await seedContributor(db(), workspaceId, { login: 'ada' });
    const unassigned = await seedContributor(db(), workspaceId, { login: 'zoe' });
    for (const contributor of [assigned, unassigned]) {
      await seedPullRequest(db(), {
        workspaceId,
        repositoryId,
        authorContributorId: contributor.id,
        mergedAt: at(4),
      });
    }
    await analyzeAll();
    const team = await createTeam(scope, 'Platform');
    await assignContributor(scope, assigned.id, team.id);

    const teamTotals = await teamMetrics(scope, {
      period,
      repositoryIds: [repositoryId],
      teamId: team.id,
    });
    const outside = await unassignedActivity(scope, { period, repositoryIds: [repositoryId] });

    expect(teamTotals.mergedCount).toBe(1);
    expect(outside).toEqual({ mergedCount: 1, contributors: 1 });
  });

  it('cannot be read or written across workspaces', async () => {
    const first = await fixture();
    const second = await fixture();
    await createTeam(first.scope, 'Platform');

    expect(await listTeams(second.scope)).toEqual([]);
    // The same name is free in another workspace.
    await expect(createTeam(second.scope, 'Platform')).resolves.toBeDefined();
  });
});
