/**
 * Work classification: the closed taxonomy, the classification input, and its content hash
 * (spec: work-classification, design.md D6).
 *
 * This module is deliberately free of any provider dependency. What a pull request *is* — its
 * title, description, commit messages, and changed paths — is stored data, and deciding whether a
 * classification is still current is a hash comparison, not a model call.
 */
import { createHash } from 'node:crypto';

/**
 * The closed set. A value outside it is a classification failure, not something to coerce into
 * the nearest neighbour (spec: "The set SHALL be closed").
 */
export const WORK_TYPES = [
  'feature',
  'bug_fix',
  'refactor',
  'chore',
  'documentation',
  'test',
  'dependency',
] as const;

export type WorkType = (typeof WORK_TYPES)[number];

export function isWorkType(value: unknown): value is WorkType {
  return typeof value === 'string' && (WORK_TYPES as readonly string[]).includes(value);
}

/** The model this classification layer runs on (design.md D6). */
export const CLASSIFICATION_MODEL = 'claude-opus-5';

/**
 * Prompt and model revision. Bump it whenever either changes, so a bulk re-run can find the rows
 * a revision left behind (spec: "Classification is versioned and content-addressed").
 */
export const CLASSIFICATION_VERSION = 'v1';

/** Paths per pull request included in the payload. Bounds both cost and prompt drift. */
export const MAX_PATHS_IN_PAYLOAD = 50;
export const MAX_COMMIT_MESSAGES_IN_PAYLOAD = 20;

export interface ClassificationInput {
  pullRequestId: string;
  title: string;
  body: string | null;
  commitMessages: string[];
  changedPaths: string[];
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}

/**
 * A hash over exactly the fields the classification reads. An unchanged pull request at the
 * current revision therefore makes no provider call — a lookup, not a heuristic (design.md D6).
 */
export function contentHash(input: ClassificationInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        title: input.title,
        body: input.body ?? '',
        commitMessages: input.commitMessages,
        changedPaths: [...input.changedPaths].sort(),
      }),
    )
    .digest('hex');
}
