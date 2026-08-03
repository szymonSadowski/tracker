/**
 * Code churn classification (spec: pr-metrics "Code churn classifies changed lines by kind",
 * design.md D2).
 *
 * A pure function of the diff statistics we ingest. Two of the three components are exact — new
 * code, and lines changed after the first review — and the third stands in file-level recency for
 * line age, which `git blame` would give and the API budget will not. Where the approximation was
 * used, the result says so rather than implying a precision the inputs do not support.
 */
import type { FileChangeKind } from '../ingest/model';

export interface ChurnFile {
  path: string;
  additions: number;
  deletions: number;
  changeKind: FileChangeKind;
}

export interface ChurnCommitFile extends ChurnFile {
  committedAt: Date;
}

export interface ChurnInput {
  files: readonly ChurnFile[];
  /** Per-commit statistics, the input to the exact post-review component. */
  commitFiles: readonly ChurnCommitFile[];
  /** When the first human review landed; null when the pull request had none. */
  firstReviewAt: Date | null;
  /** Most recent prior change to each path in our own ingested history. */
  lastChangedByPath: ReadonlyMap<string, Date>;
  /** The pull request's merge time — the point recency is measured back from. */
  mergedAt: Date;
  reworkRecencyDays: number;
  churnExclusionPatterns: readonly string[];
}

export interface ChurnResult {
  newCodeLines: number;
  refactorLines: number;
  reworkLines: number;
  excludedLines: number;
  /** True when the file-level recency approximation contributed to the rework figure. */
  usedRecencyEstimate: boolean;
}

/**
 * Glob matching for exclusion patterns: `**` spans path separators, `*` does not, `?` is one
 * character. Deliberately small — the patterns are a workspace setting, not a query language.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const expression = pattern
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === '**/') return '(?:.*/)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${expression}$`).test(path);
}

export function isExcludedPath(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

/**
 * Lines a file's change accounts for. A replacement of 50 lines is 50 lines changed, not 100:
 * additions matched by deletions in the same file are one rewrite, counted once.
 */
export function fileTotalLines(file: ChurnFile): number {
  if (file.changeKind === 'added') return file.additions;
  if (file.changeKind === 'removed') return file.deletions;
  return Math.max(file.additions, file.deletions);
}

/** Lines added where no prior line was replaced. */
export function fileNewLines(file: ChurnFile): number {
  if (file.changeKind === 'added') return file.additions;
  if (file.changeKind === 'removed') return 0;
  return Math.max(0, file.additions - file.deletions);
}

export function classifyChurn(input: ChurnInput): ChurnResult {
  const included: ChurnFile[] = [];
  let excludedLines = 0;

  for (const file of input.files) {
    if (isExcludedPath(file.path, input.churnExclusionPatterns)) {
      excludedLines += fileTotalLines(file);
      continue;
    }
    included.push(file);
  }

  const totalLines = included.reduce((sum, file) => sum + fileTotalLines(file), 0);
  if (totalLines === 0) {
    return {
      newCodeLines: 0,
      refactorLines: 0,
      reworkLines: 0,
      excludedLines,
      usedRecencyEstimate: false,
    };
  }

  const includedPaths = new Set(included.map((file) => file.path));

  // Exact component: everything a commit touched after the first human review is rework, whatever
  // the age of the code beneath it (spec: "A pull request is changed after review").
  const postReviewLines =
    input.firstReviewAt === null
      ? 0
      : input.commitFiles
          .filter(
            (file) => file.committedAt > input.firstReviewAt! && includedPaths.has(file.path),
          )
          .reduce((sum, file) => sum + fileTotalLines(file), 0);

  const reworkPostReview = Math.min(totalLines, postReviewLines);
  const remaining = totalLines - reworkPostReview;

  // New code is claimed from what the post-review component did not already take, so the three
  // categories sum to the whole however the two overlap.
  const newCodeRaw = included.reduce((sum, file) => sum + fileNewLines(file), 0);
  const newCodeLines = Math.min(newCodeRaw, remaining);
  const changedRemaining = remaining - newCodeLines;

  // Approximate component: a file whose most recent prior change in our own history is inside the
  // window is treated as recently written. File-level, and only as deep as our coverage.
  const recencyWindowMs = input.reworkRecencyDays * 24 * 3600_000;
  const recencyLines = included.reduce((sum, file) => {
    const lastChanged = input.lastChangedByPath.get(file.path);
    if (!lastChanged) return sum;
    if (input.mergedAt.getTime() - lastChanged.getTime() > recencyWindowMs) return sum;
    return sum + (fileTotalLines(file) - fileNewLines(file));
  }, 0);

  const reworkRecency = Math.min(changedRemaining, recencyLines);
  const refactorLines = changedRemaining - reworkRecency;

  return {
    newCodeLines,
    refactorLines,
    reworkLines: reworkPostReview + reworkRecency,
    excludedLines,
    usedRecencyEstimate: reworkRecency > 0,
  };
}
