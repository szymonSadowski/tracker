/**
 * The single place GitHub HTTP happens.
 *
 * Rate limit accounting, retry-after handling, and error classification live here so that every
 * caller — token minting, REST sync, GraphQL backfill — behaves the same way when GitHub pushes
 * back (spec: github-data-sync "Rate limits are respected and never exhausted silently").
 */
import { RetryableError, PermanentError } from '../jobs/errors';

export interface RateLimitSnapshot {
  limit: number | undefined;
  remaining: number | undefined;
  resetAt: Date | undefined;
  observedAt: Date;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/** GitHub rejected our credentials: the installation needs attention, retrying will not help. */
export class GitHubAuthError extends GitHubError {
  constructor(message: string, status: number, body: string) {
    super(message, status, body);
    this.name = 'GitHubAuthError';
  }
}

export class GitHubNotFoundError extends GitHubError {
  constructor(message: string, body: string) {
    super(message, 404, body);
    this.name = 'GitHubNotFoundError';
  }
}

export interface GitHubResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  rateLimit: RateLimitSnapshot;
}

export interface RequestOptions {
  method?: string;
  url: string;
  token?: string;
  /** 'bearer' for App JWTs and installation tokens; both use the same header form. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Transient-failure retries inside one call, before the job-level retry takes over. */
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  onRateLimit?: (snapshot: RateLimitSnapshot) => void;
}

function parseRateLimit(headers: Headers): RateLimitSnapshot {
  const number = (name: string) => {
    const raw = headers.get(name);
    if (raw === null) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  };
  const reset = number('x-ratelimit-reset');
  return {
    limit: number('x-ratelimit-limit'),
    remaining: number('x-ratelimit-remaining'),
    resetAt: reset === undefined ? undefined : new Date(reset * 1000),
    observedAt: new Date(),
  };
}

/** Seconds to wait, taking retry-after first and the rate limit reset second. */
export function retryDelaySeconds(headers: Headers, fallback: number): number {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (!Number.isNaN(seconds)) return Math.max(1, seconds);
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset !== null && headers.get('x-ratelimit-remaining') === '0') {
    const resetAt = Number.parseInt(reset, 10) * 1000;
    if (!Number.isNaN(resetAt)) return Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  }
  return fallback;
}

const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);

export async function githubRequest<T>(options: RequestOptions): Promise<GitHubResponse<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = options.maxAttempts ?? 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetchImpl(options.url, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'tracker-pr-analytics',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const rateLimit = parseRateLimit(response.headers);
    options.onRateLimit?.(rateLimit);

    if (response.ok) {
      const text = await response.text();
      return {
        data: (text.length > 0 ? JSON.parse(text) : undefined) as T,
        status: response.status,
        headers: response.headers,
        rateLimit,
      };
    }

    const body = await response.text().catch(() => '');

    if (response.status === 401 || response.status === 403) {
      // 403 is GitHub's rate limit status as well as its authorization failure; the headers say
      // which, and confusing the two would either park a healthy installation or hammer a
      // rejected one.
      const isRateLimited =
        response.headers.get('x-ratelimit-remaining') === '0' ||
        /rate limit|secondary rate/i.test(body);
      if (isRateLimited) {
        throw new RetryableError(
          `GitHub rate limited ${options.url}`,
          retryDelaySeconds(response.headers, 60),
        );
      }
      throw new GitHubAuthError(
        `GitHub rejected credentials for ${options.url} (${response.status})`,
        response.status,
        body,
      );
    }

    if (response.status === 404) {
      throw new GitHubNotFoundError(`GitHub returned 404 for ${options.url}`, body);
    }

    if (response.status === 429) {
      throw new RetryableError(
        `GitHub rate limited ${options.url}`,
        retryDelaySeconds(response.headers, 60),
      );
    }

    if (RETRYABLE_STATUSES.has(response.status)) {
      lastError = new GitHubError(
        `GitHub returned ${response.status} for ${options.url}`,
        response.status,
        body,
      );
      if (attempt === maxAttempts) {
        throw new RetryableError(
          `GitHub returned ${response.status} for ${options.url}`,
          retryDelaySeconds(response.headers, 30),
          { cause: lastError },
        );
      }
      await sleep(250 * 2 ** (attempt - 1));
      continue;
    }

    throw new PermanentError(
      `GitHub returned ${response.status} for ${options.url}: ${body.slice(0, 500)}`,
    );
  }

  throw lastError instanceof Error ? lastError : new Error('GitHub request failed');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse the `next` link of a REST pagination header. */
export function nextPageUrl(headers: Headers): string | undefined {
  const link = headers.get('link');
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return undefined;
}
