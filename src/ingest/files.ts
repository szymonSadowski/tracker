/**
 * Completing a pull request's file list.
 *
 * The bulk query returns the first page inline, which is the whole list for almost every pull
 * request (design.md D5). This pages the remainder for the ones it is not, and is the single place
 * that decides a list is truncated — so "complete" means the same thing on every ingestion path.
 */
import { GITHUB_FILE_ENUMERATION_LIMIT, type GitHubGraphQLClient } from '../github/graphql';
import { mapGraphQLFile, type MappedFiles } from './graphql-map';
import type { NormalizedFile } from './model';

export interface CompleteFileList {
  files: NormalizedFile[];
  /** True when GitHub stopped enumerating before the change was fully described. */
  truncated: boolean;
}

export async function completeFileList(
  graphql: GitHubGraphQLClient,
  target: { owner: string; name: string; number: number },
  seed: MappedFiles = { files: [], hasNextPage: true, endCursor: null, truncated: false },
): Promise<CompleteFileList> {
  const files = [...seed.files];
  let truncated = seed.truncated;
  let after = seed.endCursor;
  let hasNextPage = seed.hasNextPage;

  while (hasNextPage) {
    if (files.length >= GITHUB_FILE_ENUMERATION_LIMIT) {
      // GitHub will not enumerate past this. What we have is recorded as partial rather than
      // presented as the whole change (spec: "A pull request exceeds the file limit").
      truncated = true;
      break;
    }
    const page = await graphql.fetchPullRequestFiles({ ...target, after });
    files.push(...page.nodes.map(mapGraphQLFile));
    if (page.totalCount !== null && page.totalCount > GITHUB_FILE_ENUMERATION_LIMIT) {
      truncated = true;
    }
    hasNextPage = page.hasNextPage;
    after = page.endCursor;
    // A connection that claims another page but returns no cursor cannot be paged further; stop
    // rather than looping on the same page.
    if (hasNextPage && after === null) {
      truncated = true;
      break;
    }
  }

  return { files, truncated };
}
