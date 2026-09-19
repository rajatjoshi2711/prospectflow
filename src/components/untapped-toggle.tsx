"use client";

import { useRouter, useSearchParams } from "next/navigation";

/**
 * Turns the "never messaged" filter on and off via the URL (`?untapped=1`),
 * the same way `DefinitionFilter` writes `?def=` and `ProspectTable` writes
 * its paging and sorting. Because it is URL state, the filter composes with
 * the definition filter, the search box, the sort and the page number, and the
 * resulting view stays server-rendered and shareable.
 *
 * Clearing `page` on toggle is not incidental: the row set changes underneath,
 * so page 7 of the old list is meaningless in the new one.
 */
export function UntappedToggle({ active }: { active: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function toggle() {
    const next = new URLSearchParams(searchParams?.toString() ?? "");
    if (active) next.delete("untapped");
    else next.set("untapped", "1");
    next.delete("page");
    const qs = next.toString();
    router.push(qs ? `?${qs}` : "?", { scroll: false });
  }

  return (
    <button
      type="button"
      className={`ef-btn ${active ? "ef-btn-secondary" : "ef-btn-primary"}`}
      onClick={toggle}
      aria-pressed={active}
    >
      {active ? "Show all matches" : "Show only these"}
    </button>
  );
}
