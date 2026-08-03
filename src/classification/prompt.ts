/**
 * The classification prompt (design.md D6).
 *
 * Two properties are load-bearing:
 *
 * 1. **The instruction block and taxonomy are byte-stable.** They go first and carry the cache
 *    breakpoint, so every request in a batch reads the same cached prefix. Anything that varies
 *    per pull request goes after it — a timestamp or an id in this string would silently cost the
 *    whole prefix on every request.
 * 2. **No file contents.** Paths, titles, bodies, commit messages, and counts only (spec:
 *    "SHALL NOT transmit source code file contents").
 */
import {
  MAX_COMMIT_MESSAGES_IN_PAYLOAD,
  MAX_PATHS_IN_PAYLOAD,
  WORK_TYPES,
  type ClassificationInput,
} from './model';

/** Byte-stable. Do not interpolate anything into this string. */
export const INSTRUCTION_PREFIX = `You classify pull requests into exactly one kind of work.

Taxonomy:
- feature: adds new user-facing capability or extends an existing one
- bug_fix: corrects incorrect behaviour that already shipped
- refactor: restructures existing code without changing its behaviour
- chore: build, tooling, configuration, release, or repository housekeeping
- documentation: prose, comments, or reference material, with no behaviour change
- test: adds or changes tests, with no change to the code under test
- dependency: updates, adds, or removes third-party dependencies

Rules:
- Choose the single type that best describes the change's purpose, not its size.
- A change that both fixes a defect and tidies nearby code is bug_fix.
- A dependency bump that exists to fix a defect is dependency.
- Judge from the evidence given. You are shown titles, descriptions, commit messages, changed
  file paths, and line counts — never file contents.
- confidence is your own probability that the type is right, from 0 to 1.
- rationale is one short sentence naming the evidence you used.`;

export const WORK_TYPE_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: [...WORK_TYPES] },
    confidence: { type: 'number' },
    rationale: { type: 'string' },
  },
  required: ['type', 'confidence', 'rationale'],
  additionalProperties: false,
} as const;

/** The per-pull-request half of the prompt — everything that varies goes here, after the cache. */
export function pullRequestContent(input: ClassificationInput): string {
  const lines = [
    `Title: ${input.title}`,
    `Description: ${input.body?.trim() ? input.body.trim() : '(none)'}`,
    `Changed files: ${input.changedFiles ?? 'unknown'}`,
    `Lines added: ${input.additions ?? 'unknown'}`,
    `Lines deleted: ${input.deletions ?? 'unknown'}`,
    '',
    'Commit messages:',
    ...(input.commitMessages.length === 0
      ? ['(none)']
      : input.commitMessages
          .slice(0, MAX_COMMIT_MESSAGES_IN_PAYLOAD)
          .map((message) => `- ${message}`)),
    '',
    'Changed paths:',
    ...(input.changedPaths.length === 0
      ? ['(none)']
      : input.changedPaths.slice(0, MAX_PATHS_IN_PAYLOAD).map((path) => `- ${path}`)),
  ];
  return lines.join('\n');
}
