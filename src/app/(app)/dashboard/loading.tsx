import { PageSkeleton } from "@/components/page-skeleton";

/** Shown while the server component's queries run. See `PageSkeleton`. */
export default function Loading() {
  return <PageSkeleton cards={4} stats />;
}
