import {
  SkeletonHeading,
  SkeletonLine,
  SkeletonPage,
  SkeletonSection,
  SkeletonTable,
} from '@/ui/skeletons';

/** Settings' shape: the installation summary, sync state, then repositories and members. */
export default function Loading() {
  return (
    <SkeletonPage>
      <SkeletonHeading width="8rem" />
      <SkeletonSection headingWidth="14rem">
        <SkeletonLine width="30rem" height="0.9rem" />
        <SkeletonLine width="16rem" height="2rem" />
      </SkeletonSection>
      <SkeletonSection headingWidth="9rem">
        <SkeletonTable rows={5} columns={4} />
      </SkeletonSection>
      <SkeletonSection headingWidth="7rem">
        <SkeletonTable rows={3} columns={3} />
      </SkeletonSection>
    </SkeletonPage>
  );
}
