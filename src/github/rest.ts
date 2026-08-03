/**
 * REST client. Used for installation management and for incremental sync, where few pull requests
 * are fetched and REST's pagination and conditional-request semantics are simpler than GraphQL's
 * (design.md D2).
 */
import { githubRequest, nextPageUrl, type RateLimitSnapshot } from './http';

export interface RestClientOptions {
  apiBaseUrl: string;
  /** Resolved per request so a token refreshed mid-operation is picked up transparently. */
  token: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
  onRateLimit?: (snapshot: RateLimitSnapshot) => void;
}

export interface RestRepository {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  private: boolean;
  default_branch?: string;
  owner: { login: string; id: number; node_id: string; type: string };
}

export interface RestUser {
  id: number;
  node_id: string;
  login: string;
  type: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string;
}

export interface RestPullRequest {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  draft?: boolean;
  html_url: string;
  user: RestUser | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  base?: { ref: string };
  head?: { ref: string };
}

export interface RestReview {
  id: number;
  node_id: string;
  user: RestUser | null;
  state: string;
  body?: string | null;
  submitted_at: string | null;
}

export interface RestCommit {
  sha: string;
  node_id: string;
  commit: {
    message: string;
    author: { name?: string; email?: string; date?: string } | null;
    committer: { name?: string; email?: string; date?: string } | null;
  };
  author: RestUser | null;
  stats?: { additions: number; deletions: number };
}

export interface RestFile {
  filename: string;
  additions: number;
  deletions: number;
  /** added | modified | removed | renamed | copied | changed | unchanged */
  status: string;
  previous_filename?: string;
}

export interface RestReviewComment {
  id: number;
  node_id: string;
  user: RestUser | null;
  created_at: string;
  /** GitHub's numeric review id. The node id is not exposed here, so the link stays unresolved. */
  pull_request_review_id?: number | null;
}

/** The commit detail view. Unlike the list view it carries per-file statistics. */
export interface RestCommitDetail extends RestCommit {
  files?: RestFile[];
}

export interface RestTimelineEvent {
  event: string;
  created_at?: string;
  actor?: RestUser | null;
  [key: string]: unknown;
}

export class GitHubRestClient {
  constructor(private readonly options: RestClientOptions) {}

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; absoluteUrl?: string } = {},
  ) {
    return githubRequest<T>({
      method: init.method,
      url: init.absoluteUrl ?? `${this.options.apiBaseUrl}${path}`,
      token: await this.options.token(),
      body: init.body,
      fetchImpl: this.options.fetchImpl,
      onRateLimit: this.options.onRateLimit,
    });
  }

  private async paginate<T>(path: string, extract: (payload: unknown) => T[]): Promise<T[]> {
    const items: T[] = [];
    let url: string | undefined = `${this.options.apiBaseUrl}${path}`;
    while (url) {
      const response = await this.request<unknown>('', { absoluteUrl: url });
      items.push(...extract(response.data));
      url = nextPageUrl(response.headers);
    }
    return items;
  }

  /** Repositories the installation currently has access to — the source of truth for scope. */
  async listInstallationRepositories(): Promise<RestRepository[]> {
    return this.paginate<RestRepository>(
      '/installation/repositories?per_page=100',
      (payload) => (payload as { repositories: RestRepository[] }).repositories ?? [],
    );
  }

  async getRepository(owner: string, repo: string): Promise<RestRepository> {
    return (await this.request<RestRepository>(`/repos/${owner}/${repo}`)).data;
  }

  /**
   * Pull requests ordered by most recently updated. The caller stops paging once it passes the
   * sync window's start, which is what keeps an incremental sync cheap.
   */
  async listPullRequestsPage(
    owner: string,
    repo: string,
    page: number,
    perPage = 50,
  ): Promise<RestPullRequest[]> {
    const path =
      `/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc` +
      `&per_page=${perPage}&page=${page}`;
    return (await this.request<RestPullRequest[]>(path)).data;
  }

  /** Detail view; the list endpoint omits additions, deletions, and changed_files. */
  async getPullRequest(owner: string, repo: string, number: number): Promise<RestPullRequest> {
    return (await this.request<RestPullRequest>(`/repos/${owner}/${repo}/pulls/${number}`)).data;
  }

  async listReviews(owner: string, repo: string, number: number): Promise<RestReview[]> {
    return this.paginate<RestReview>(
      `/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`,
      (payload) => payload as RestReview[],
    );
  }

  async listCommits(owner: string, repo: string, number: number): Promise<RestCommit[]> {
    return this.paginate<RestCommit>(
      `/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`,
      (payload) => payload as RestCommit[],
    );
  }

  /**
   * Timeline events carry ready-for-review, draft conversions, and force pushes — the anchors
   * latency and review-effort metrics are defined against (design.md D6).
   */
  async listTimeline(owner: string, repo: string, number: number): Promise<RestTimelineEvent[]> {
    return this.paginate<RestTimelineEvent>(
      `/repos/${owner}/${repo}/issues/${number}/timeline?per_page=100`,
      (payload) => payload as RestTimelineEvent[],
    );
  }

  /**
   * The pull request's changed files. GitHub enumerates at most 3000; a longer list comes back
   * short, which the caller records as truncated rather than treating as complete.
   */
  async listPullRequestFiles(owner: string, repo: string, number: number): Promise<RestFile[]> {
    return this.paginate<RestFile>(
      `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
      (payload) => payload as RestFile[],
    );
  }

  /** Comments left on the diff, including those attached to a review submission. */
  async listReviewComments(
    owner: string,
    repo: string,
    number: number,
  ): Promise<RestReviewComment[]> {
    return this.paginate<RestReviewComment>(
      `/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`,
      (payload) => payload as RestReviewComment[],
    );
  }

  /** Per-commit file statistics — the exact input to the post-review rework component (D2). */
  async getCommit(owner: string, repo: string, sha: string): Promise<RestCommitDetail> {
    return (await this.request<RestCommitDetail>(`/repos/${owner}/${repo}/commits/${sha}`)).data;
  }

  async getAuthenticatedUser(): Promise<RestUser> {
    return (await this.request<RestUser>('/user')).data;
  }
}
