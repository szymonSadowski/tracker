import {
  SkeletonChips,
  SkeletonHeading,
  SkeletonLine,
  SkeletonPage,
  SkeletonTable,
} from '@/ui/skeletons';

/** The pull request list's shape: four filter rows above a seven-column table. */
export default function Loading() {
  return (
    <SkeletonPage>
      <SkeletonHeading width="11rem" />
      <SkeletonLine width="20rem" height="0.9rem" />
      <SkeletonChips count={4} />
      <SkeletonChips count={3} />
      <SkeletonChips count={5} />
      <SkeletonChips count={4} />
      <SkeletonTable rows={8} columns={5} />
    </SkeletonPage>
  );
}
