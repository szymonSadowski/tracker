import {
  SkeletonCards,
  SkeletonChart,
  SkeletonChips,
  SkeletonHeading,
  SkeletonLine,
  SkeletonPage,
  SkeletonSection,
  SkeletonTable,
} from '@/ui/skeletons';

/** The personal view's shape: four tiles, your trends, then your pull requests. */
export default function Loading() {
  return (
    <SkeletonPage>
      <SkeletonHeading width="9rem" />
      <SkeletonLine width="14rem" height="0.9rem" />
      <SkeletonChips count={4} />
      <SkeletonCards count={4} />
      <SkeletonSection headingWidth="8rem">
        <SkeletonChart />
        <SkeletonChart />
      </SkeletonSection>
      <SkeletonSection headingWidth="11rem">
        <SkeletonTable rows={6} columns={5} />
      </SkeletonSection>
    </SkeletonPage>
  );
}
