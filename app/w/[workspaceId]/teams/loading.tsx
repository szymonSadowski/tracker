import {
  SkeletonHeading,
  SkeletonLine,
  SkeletonPage,
  SkeletonSection,
  SkeletonTable,
} from '@/ui/skeletons';

/** Team management's shape: a create form, the teams table, then the contributor roster. */
export default function Loading() {
  return (
    <SkeletonPage>
      <SkeletonHeading width="7rem" />
      <SkeletonLine width="26rem" height="0.9rem" />
      <SkeletonSection headingWidth="9rem">
        <SkeletonLine width="18rem" height="2rem" />
      </SkeletonSection>
      <SkeletonSection headingWidth="7rem">
        <SkeletonTable rows={4} columns={4} />
      </SkeletonSection>
      <SkeletonSection headingWidth="10rem">
        <SkeletonTable rows={8} columns={4} />
      </SkeletonSection>
    </SkeletonPage>
  );
}
