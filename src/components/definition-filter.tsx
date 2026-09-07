"use client";

import { useRouter, useSearchParams } from "next/navigation";

/**
 * "Filter by ICP / channel partner" dropdown for the match dashboards.
 *
 * Writes to the URL (`?def=`) the same way `ProspectTable` writes its paging
 * and sorting, so filtering, sorting, and paging compose and the page stays
 * server-rendered and shareable.
 */
export function DefinitionFilter({
  label,
  allLabel,
  definitions,
  selectedId,
}: {
  label: string;
  allLabel: string;
  definitions: { id: string; name: string }[];
  selectedId: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function select(value: string) {
    const next = new URLSearchParams(searchParams?.toString() ?? "");
    if (value) next.set("def", value);
    else next.delete("def");
    // A new filter invalidates the current page number.
    next.delete("page");
    const qs = next.toString();
    router.push(qs ? `?${qs}` : "?", { scroll: false });
  }

  return (
    <div className="flex items-center gap-2">
      <label className="ef-small" htmlFor="definition-filter" style={{ fontWeight: 600 }}>
        {label}
      </label>
      <select
        id="definition-filter"
        className="ef-input"
        style={{ width: "auto", minWidth: 220 }}
        value={selectedId}
        onChange={(event) => select(event.target.value)}
      >
        <option value="">{allLabel}</option>
        {definitions.map((definition) => (
          <option key={definition.id} value={definition.id}>
            {definition.name}
          </option>
        ))}
      </select>
    </div>
  );
}
