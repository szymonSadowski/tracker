/**
 * Loading skeletons for the workspace route segments (design.md D3).
 *
 * These render while the server builds a page. They exist so a navigation acknowledges itself
 * immediately rather than leaving the previous page on screen with no sign that anything is
 * happening — the App Router shows nothing at all without them.
 *
 * Each piece mirrors the shape of what replaces it, so the swap is not a flash of unrelated
 * layout. They carry no data and make no decisions; if a skeleton and its page ever disagree about
 * layout, the page is right.
 */
import type { ReactNode } from 'react';

/** A grey block standing in for a line of text. `width` is any CSS length. */
export function SkeletonLine({ width = '100%', height }: { width?: string; height?: string }) {
  return <span className="skeleton skeleton-line" style={{ width, height }} />;
}

export function SkeletonHeading({ width = '14rem' }: { width?: string }) {
  return <div className="skeleton skeleton-heading" style={{ width }} />;
}

/** The row of filter chips that sits under most page headings. */
export function SkeletonChips({ count = 4 }: { count?: number }) {
  return (
    <div className="period">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className="skeleton skeleton-chip" />
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 4 }: { count?: number }) {
  return (
    <div className="cards">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="card">
          <SkeletonLine width="60%" height="0.82rem" />
          <SkeletonLine width="45%" height="1.55rem" />
          <SkeletonLine width="35%" height="0.78rem" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonSection({
  children,
  headingWidth = '9rem',
}: {
  children?: ReactNode;
  headingWidth?: string;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <SkeletonLine width={headingWidth} height="1rem" />
      </div>
      {children}
    </section>
  );
}

export function SkeletonChart() {
  return <div className="skeleton skeleton-chart" />;
}

export function SkeletonTable({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="skeleton-table">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="skeleton-table-row">
          {Array.from({ length: columns }, (_, column) => (
            <SkeletonLine key={column} width={column === 0 ? '100%' : '60%'} height="0.9rem" />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The frame every workspace skeleton shares. Announced politely so a screen reader is told the
 * page is loading rather than left with a silent tree of empty boxes.
 */
export function SkeletonPage({ children }: { children: ReactNode }) {
  return (
    <main aria-busy="true" aria-live="polite">
      <span className="visually-hidden">Loading…</span>
      {children}
    </main>
  );
}
