import {
  SkeletonCards,
  SkeletonChips,
  SkeletonHeading,
  SkeletonPage,
  SkeletonSection,
  SkeletonTable,
} from '@/ui/skeletons';

/** A contributor's detail: period chips, their tiles, then their pull requests. */
export default function Loading() {
  return (
    <SkeletonPage>
      <SkeletonHeading width="10rem" />
      <SkeletonChips count={4} />
      <SkeletonCards count={4} />
      <SkeletonSection headingWidth="11rem">
        <SkeletonTable rows={6} columns={5} />
      </SkeletonSection>
    </SkeletonPage>
  );
}
