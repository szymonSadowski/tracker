import { db } from '@/db/client';
import { workspaceScope } from '@/db/scope';
import { loadWorkspacePage } from '@/ui/page-access';
import { listRoster, listTeams } from '@/teams/store';
import { Section } from '@/ui/components';
import {
  assignContributorAction,
  createTeamAction,
  deleteTeamAction,
  renameTeamAction,
} from './actions';

/** Team management (owner only): create, rename, delete, and assign contributors. */
export default async function TeamsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  await loadWorkspacePage(workspaceId, { requireOwner: true });
  const scope = workspaceScope(db(), workspaceId);

  const teams = await listTeams(scope);
  const roster = await listRoster(scope);
  const unassigned = roster.filter((entry) => entry.teamId === null);

  return (
    <main>
      <h1>Teams</h1>
      <p className="muted">
        Teams are defined here, not read from GitHub. A contributor belongs to at most one team.
      </p>

      <Section title="Create a team">
        <form action={createTeamAction.bind(null, workspaceId)} className="inline-form">
          <input type="text" name="name" placeholder="Team name" required />
          <button className="button" type="submit">
            Create
          </button>
        </form>
      </Section>

      <Section title={`Teams (${teams.length})`}>
        {teams.length === 0 ? (
          <p className="muted">No teams yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Team</th>
                <th>Contributors</th>
                <th>Rename</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => (
                <tr key={team.id}>
                  <td>{team.name}</td>
                  <td className="numeric">{team.memberCount}</td>
                  <td>
                    <form action={renameTeamAction.bind(null, workspaceId)} className="inline-form">
                      <input type="hidden" name="teamId" value={team.id} />
                      <input type="text" name="name" defaultValue={team.name} required />
                      <button className="button button-secondary" type="submit">
                        Save
                      </button>
                    </form>
                  </td>
                  <td>
                    <form action={deleteTeamAction.bind(null, workspaceId)} className="inline-form">
                      <input type="hidden" name="teamId" value={team.id} />
                      <button className="button button-secondary" type="submit">
                        Delete
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {unassigned.length > 0 ? (
        <p className="notice">
          {unassigned.length} contributor{unassigned.length === 1 ? '' : 's'} with activity{' '}
          {unassigned.length === 1 ? 'is' : 'are'} not assigned to a team. Their work is not counted
          in any team&rsquo;s totals.
        </p>
      ) : null}

      <Section title={`Contributors (${roster.length})`}>
        {roster.length === 0 ? (
          <p className="muted">
            No contributors yet — they appear as pull requests are ingested from the selected
            repositories.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Contributor</th>
                <th>Authored</th>
                <th>Reviewed</th>
                <th>Team</th>
              </tr>
            </thead>
            <tbody>
              {roster.map((entry) => (
                <tr key={entry.contributorId}>
                  <td>{entry.login}</td>
                  <td className="numeric">{entry.authoredCount}</td>
                  <td className="numeric">{entry.reviewedCount}</td>
                  <td>
                    <form
                      action={assignContributorAction.bind(null, workspaceId)}
                      className="inline-form"
                    >
                      <input type="hidden" name="contributorId" value={entry.contributorId} />
                      <select name="teamId" defaultValue={entry.teamId ?? ''}>
                        <option value="">Unassigned</option>
                        {teams.map((team) => (
                          <option key={team.id} value={team.id}>
                            {team.name}
                          </option>
                        ))}
                      </select>
                      <button className="button button-secondary" type="submit">
                        Save
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </main>
  );
}
