import {
  SkeletonCards,
  SkeletonChart,
  SkeletonChips,
  SkeletonHeading,
  SkeletonLine,
  SkeletonPage,
  SkeletonSection,
} from '@/ui/skeletons';

/** The team view's shape: team and period chips, five metric tiles, then charts (design.md D3). */
export default function Loading() {
  return (
    <SkeletonPage>
      <SkeletonHeading />
      <SkeletonLine width="18rem" height="0.9rem" />
      <SkeletonChips count={3} />
      <SkeletonChips count={4} />
      <SkeletonCards count={5} />
      <SkeletonSection headingWidth="7rem">
        <SkeletonLine width="100%" height="1.2rem" />
      </SkeletonSection>
      <SkeletonSection headingWidth="5rem">
        <SkeletonChart />
        <SkeletonChart />
      </SkeletonSection>
    </SkeletonPage>
  );
}
