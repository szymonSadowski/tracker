/**
 * Configuration and secret loading.
 *
 * Everything the application needs from the environment is read here, once, so that a missing
 * secret fails at startup with a named variable rather than at the first GitHub request.
 */

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function required(name: string): string {
  const value = optional(name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function integer(name: string, fallback: number): number {
  const value = optional(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error(`Environment variable ${name} must be an integer`);
  return parsed;
}

/**
 * A GitHub App private key may be supplied PEM-encoded directly or base64-encoded, because a
 * multi-line PEM is awkward to carry through most secret stores.
 */
function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('BEGIN')) return trimmed.replace(/\\n/g, '\n');
  return Buffer.from(trimmed, 'base64').toString('utf8');
}

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  /** Reserved for the deferred webhook path (design.md D3); unset in this change. */
  webhookSecret: string | undefined;
  apiBaseUrl: string;
  graphqlUrl: string;
  appSlug: string | undefined;
}

export interface SyncConfig {
  /**
   * How far back a repository's *automatic* backfill reaches when it enters scope. A starting
   * point, not a ceiling: a member-requested history sync extends coverage earlier than this, and
   * changing it does not retroactively change what has already been ingested — coverage depth is
   * recorded per repository (design.md D3).
   */
  backfillWindowDays: number;
  /** Incremental sync cadence in minutes (design.md D3). */
  syncIntervalMinutes: number;
  /** Overlap added to each incremental window so nothing falls between two syncs. */
  syncOverlapMinutes: number;
  /** Pause non-urgent sync work below this many remaining API points. */
  rateLimitSafetyThreshold: number;
  /** Minimum gap between accepted on-demand sync requests for a workspace. */
  onDemandSyncDebounceSeconds: number;
  /**
   * Pages one history sync job walks before re-enqueueing itself, so a repository with years of
   * pull requests cannot monopolise a worker (design.md D1).
   */
  historyPagesPerRun: number;
}

export interface AuthConfig {
  sessionSecret: string;
  sessionInactivityMinutes: number;
  permissionCacheSeconds: number;
  baseUrl: string;
}

export interface AppConfig {
  databaseUrl: string;
  github: GitHubAppConfig;
  sync: SyncConfig;
  auth: AuthConfig;
}

let cached: AppConfig | undefined;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  cached = {
    databaseUrl: required('DATABASE_URL'),
    github: {
      appId: required('GITHUB_APP_ID'),
      privateKey: normalizePrivateKey(required('GITHUB_APP_PRIVATE_KEY')),
      clientId: required('GITHUB_OAUTH_CLIENT_ID'),
      clientSecret: required('GITHUB_OAUTH_CLIENT_SECRET'),
      webhookSecret: optional('GITHUB_WEBHOOK_SECRET'),
      apiBaseUrl: optional('GITHUB_API_BASE_URL') ?? 'https://api.github.com',
      graphqlUrl: optional('GITHUB_GRAPHQL_URL') ?? 'https://api.github.com/graphql',
      appSlug: optional('GITHUB_APP_SLUG'),
    },
    sync: {
      backfillWindowDays: integer('BACKFILL_WINDOW_DAYS', 90),
      syncIntervalMinutes: integer('SYNC_INTERVAL_MINUTES', 15),
      syncOverlapMinutes: integer('SYNC_OVERLAP_MINUTES', 30),
      rateLimitSafetyThreshold: integer('RATE_LIMIT_SAFETY_THRESHOLD', 200),
      onDemandSyncDebounceSeconds: integer('ON_DEMAND_SYNC_DEBOUNCE_SECONDS', 120),
      historyPagesPerRun: integer('HISTORY_PAGES_PER_RUN', 5),
    },
    auth: {
      sessionSecret: required('SESSION_SECRET'),
      sessionInactivityMinutes: integer('SESSION_INACTIVITY_MINUTES', 60 * 24 * 7),
      permissionCacheSeconds: integer('PERMISSION_CACHE_SECONDS', 300),
      baseUrl: optional('APP_BASE_URL') ?? 'http://localhost:3000',
    },
  };
  return cached;
}

/** Test seam: forget the memoized configuration. */
export function resetConfigCache(): void {
  cached = undefined;
}

/** Sync settings without requiring GitHub secrets — used by pure computation paths and tests. */
export function syncDefaults(): SyncConfig {
  return {
    backfillWindowDays: integer('BACKFILL_WINDOW_DAYS', 90),
    syncIntervalMinutes: integer('SYNC_INTERVAL_MINUTES', 15),
    syncOverlapMinutes: integer('SYNC_OVERLAP_MINUTES', 30),
    rateLimitSafetyThreshold: integer('RATE_LIMIT_SAFETY_THRESHOLD', 200),
    onDemandSyncDebounceSeconds: integer('ON_DEMAND_SYNC_DEBOUNCE_SECONDS', 120),
    historyPagesPerRun: integer('HISTORY_PAGES_PER_RUN', 5),
  };
}
