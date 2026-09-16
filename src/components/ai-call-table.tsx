"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { AiUseCase } from "@prisma/client";
import {
  USE_CASES,
  USE_CASE_LABELS,
  formatUsd,
  type AiCallRow,
  type AiCallSortKey,
} from "@/lib/ai/audit-shared";

/**
 * The AI transaction list: every model call this organization has made.
 *
 * Paging, sorting and filtering are SERVER-side, exactly as in
 * `prospect-table.tsx` — this component only reads and writes the query string.
 * That is not a style choice here: this table grows by a row per model call, so
 * it must never be shipped to the browser in full to be sorted there.
 *
 * FAILED CALLS are not hidden. They carry a danger badge and their error kind,
 * because a call that failed may still have cost money and is always the first
 * thing worth looking at.
 */

export function AiCallTable({
  rows,
  total,
  page,
  pageCount,
  pageSize,
  sort,
  direction,
  filters,
  models,
  users,
}: {
  rows: AiCallRow[];
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  sort: AiCallSortKey;
  direction: "asc" | "desc";
  filters: { useCase: string | null; model: string | null; userId: string | null; status: string | null };
  models: string[];
  users: { id: string; name: string }[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  function pushParams(updates: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams?.toString() ?? "");
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : (pathname ?? "?"), { scroll: false });
  }

  function toggleSort(key: AiCallSortKey) {
    // Time, cost, tokens and latency are all read biggest-first; only a second
    // press on the active column flips to ascending.
    const nextDirection = sort === key && direction === "desc" ? "asc" : "desc";
    pushParams({ sort: key, dir: nextDirection, page: "1" });
  }

  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, total);
  const hasFilters = Boolean(filters.useCase || filters.model || filters.userId || filters.status);

  return (
    <div className="flex flex-col gap-4">
      {/* Filters in one row above the table, as a single group. */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="ef-label">Use case</span>
          <select
            className="ef-input"
            style={{ minWidth: 200 }}
            value={filters.useCase ?? ""}
            onChange={(event) => pushParams({ useCase: event.target.value || null, page: "1" })}
          >
            <option value="">All use cases</option>
            {USE_CASES.map((useCase) => (
              <option key={useCase} value={useCase}>
                {USE_CASE_LABELS[useCase]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="ef-label">Model</span>
          <select
            className="ef-input"
            style={{ minWidth: 200 }}
            value={filters.model ?? ""}
            onChange={(event) => pushParams({ model: event.target.value || null, page: "1" })}
          >
            <option value="">All models</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="ef-label">Member</span>
          <select
            className="ef-input"
            style={{ minWidth: 180 }}
            value={filters.userId ?? ""}
            onChange={(event) => pushParams({ userId: event.target.value || null, page: "1" })}
          >
            <option value="">Everyone</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="ef-label">Outcome</span>
          <select
            className="ef-input"
            style={{ minWidth: 140 }}
            value={filters.status ?? ""}
            onChange={(event) => pushParams({ status: event.target.value || null, page: "1" })}
          >
            <option value="">All</option>
            <option value="OK">Succeeded</option>
            <option value="ERROR">Failed</option>
          </select>
        </label>

        {hasFilters ? (
          <button
            type="button"
            className="ef-btn ef-btn-text"
            onClick={() =>
              pushParams({ useCase: null, model: null, userId: null, status: null, page: "1" })
            }
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {total === 0 ? (
        <div className="ef-card">
          <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
            {hasFilters
              ? "No calls match these filters."
              : "No AI calls have been recorded for your organization yet."}
          </p>
        </div>
      ) : (
        <>
          <div className="ef-card overflow-x-auto p-0">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr style={{ background: "var(--bg-subtle)" }}>
                  <th className="ef-small px-4 py-3" style={{ fontWeight: 700 }}>
                    <SortButton
                      label="When"
                      active={sort === "createdAt"}
                      direction={direction}
                      onClick={() => toggleSort("createdAt")}
                    />
                  </th>
                  <th className="ef-small px-4 py-3" style={{ fontWeight: 700 }}>
                    Model
                  </th>
                  <th className="ef-small px-4 py-3" style={{ fontWeight: 700 }}>
                    Use case
                  </th>
                  <th className="ef-small px-4 py-3" style={{ fontWeight: 700 }}>
                    User
                  </th>
                  <th className="ef-small px-4 py-3" style={{ fontWeight: 700, textAlign: "right" }}>
                    In
                  </th>
                  <th className="ef-small px-4 py-3" style={{ fontWeight: 700, textAlign: "right" }}>
                    Out
                  </th>
                  <th className="ef-small px-4 py-3" style={{ fontWeight: 700, textAlign: "right" }}>
                    <SortButton
                      label="Total"
                      active={sort === "totalTokens"}
                      direction={direction}
                      onClick={() => toggleSort("totalTokens")}
                    />
                  </th>
                  <th className="ef-small px-4 py-3" style={{ fontWeight: 700, textAlign: "right" }}>
                    <SortButton
                      label="Est. cost"
                      active={sort === "costUsd"}
                      direction={direction}
                      onClick={() => toggleSort("costUsd")}
                    />
                  </th>
                  <th className="ef-small px-4 py-3" style={{ fontWeight: 700, textAlign: "right" }}>
                    <SortButton
                      label="Latency"
                      active={sort === "latencyMs"}
                      direction={direction}
                      onClick={() => toggleSort("latencyMs")}
                    />
                  </th>
                  <th className="ef-small px-4 py-3" style={{ fontWeight: 700 }}>
                    Outcome
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                    <td
                      className="ef-small px-4 py-3"
                      style={{ whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 12 }}
                    >
                      {row.createdAt.replace("T", " ").slice(0, 19)}Z
                    </td>
                    <td className="ef-small px-4 py-3" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                      {row.model}
                    </td>
                    <td className="ef-small px-4 py-3">
                      {USE_CASE_LABELS[row.useCase as AiUseCase] ?? row.useCase}
                      {row.usedBuiltInTools ? (
                        <span
                          className="ef-caption block"
                          style={{ color: "var(--text-secondary)" }}
                          title="This call used provider-run web search, which may carry a per-search fee we cannot read from the response."
                        >
                          + web search (unpriced)
                        </span>
                      ) : null}
                    </td>
                    <td className="ef-small px-4 py-3">{row.userName}</td>
                    <td className="ef-small px-4 py-3" style={{ textAlign: "right" }}>
                      {row.usageReported ? row.promptTokens.toLocaleString() : "—"}
                    </td>
                    <td className="ef-small px-4 py-3" style={{ textAlign: "right" }}>
                      {row.usageReported ? row.completionTokens.toLocaleString() : "—"}
                    </td>
                    <td
                      className="ef-small px-4 py-3"
                      style={{ textAlign: "right", fontWeight: 600 }}
                    >
                      {row.usageReported ? row.totalTokens.toLocaleString() : "not reported"}
                    </td>
                    <td
                      className="ef-small px-4 py-3"
                      style={{
                        textAlign: "right",
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        // An unknown cost is greyed rather than shown as $0.00 —
                        // see the "cost unknown" note on the summary page.
                        color: row.costUsd === null ? "var(--text-secondary)" : undefined,
                      }}
                      title={
                        row.costUsd === null
                          ? "This model is not on the configured rate card, so the call could not be priced."
                          : undefined
                      }
                    >
                      {formatUsd(row.costUsd)}
                    </td>
                    <td className="ef-small px-4 py-3" style={{ textAlign: "right" }}>
                      {row.latencyMs.toLocaleString()} ms
                    </td>
                    <td className="ef-small px-4 py-3">
                      {row.status === "ERROR" ? (
                        <span className="ef-badge ef-badge-danger" title={row.errorKind ?? undefined}>
                          Failed{row.errorKind ? ` · ${row.errorKind}` : ""}
                        </span>
                      ) : (
                        <span className="ef-badge ef-badge-success">OK</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-4">
            <p className="ef-caption">
              Showing {firstRow.toLocaleString()}–{lastRow.toLocaleString()} of{" "}
              {total.toLocaleString()}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="ef-btn ef-btn-secondary"
                disabled={page <= 1}
                onClick={() => pushParams({ page: String(page - 1) })}
              >
                Previous
              </button>
              <span className="ef-caption">
                Page {page} of {pageCount}
              </span>
              <button
                type="button"
                className="ef-btn ef-btn-secondary"
                disabled={page >= pageCount}
                onClick={() => pushParams({ page: String(page + 1) })}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SortButton({
  label,
  active,
  direction,
  onClick,
}: {
  label: string;
  active: boolean;
  direction: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="ef-small"
      style={{
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
        fontWeight: 700,
        color: active ? "var(--blue-500)" : "var(--text-primary)",
      }}
      aria-label={`Sort by ${label}`}
    >
      {label}
      <span aria-hidden style={{ marginLeft: 4 }}>
        {active ? (direction === "asc" ? "▲" : "▼") : "↕"}
      </span>
    </button>
  );
}
