import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { AiCallTable } from "@/components/ai-call-table";
import { AiUsageBarChart, type UsageInfo } from "@/components/ai-usage-bar-chart";
import { StatCard } from "@/components/stat-card";
import {
  AI_AUDIT_PAGE_SIZE,
  USE_CASE_LABELS,
  fetchAiCallPage,
  formatUsd,
  loadAiAuditFilterOptions,
  loadAiAuditSummary,
  parseAiAuditSearchParams,
} from "@/lib/ai/audit";
import { RATE_CARD_SOURCE, getRateCard } from "@/lib/ai/pricing";

/**
 * AI audit — summary dashboard plus the full transaction list.
 *
 * ACCESS: admin only. `requireAdmin` is the guard for API routes (it returns a
 * 403 response); a PAGE redirects instead, which is the pattern every other
 * admin page here uses — see `admin/users/page.tsx`. Both read the same
 * verified session and enforce the same `role === "ADMIN"` rule.
 *
 * TENANCY: `session.organizationId` is the only org id that reaches the data
 * layer. It is never read from the query string, so no combination of filters
 * a reader can type will show another organization's spend.
 *
 * HONESTY ABOUT MONEY: every dollar figure on this page is an ESTIMATE derived
 * from a configured rate card, not a billed amount, and the page says so at the
 * top rather than in a tooltip. See `src/lib/ai/pricing.ts`.
 */
export default async function AdminAiAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") redirect("/dashboard");

  const organizationId = session.organizationId;
  const params = parseAiAuditSearchParams(await searchParams);

  const [summary, transactions, filterOptions] = await Promise.all([
    loadAiAuditSummary(organizationId),
    fetchAiCallPage({
      organizationId,
      page: params.page,
      sort: params.sort,
      direction: params.direction,
      filters: params.filters,
    }),
    loadAiAuditFilterOptions(organizationId),
  ]);

  const monthTotals = summary.windows.find((window) => window.key === "month");
  const anyUnpriced = summary.windows.some((window) => window.unpricedCalls > 0);
  const researchUsesTools = summary.useCases.some((row) => row.usesBuiltInTools);

  // The ⓘ beside "Usage by model": input and output rates for EVERY model on
  // the card, not only the ones with bars — an admin checking a figure wants
  // the whole rate card, including a model configured but not yet used.
  const rateCard = getRateCard();
  const modelsInPlay = [
    ...new Set([...summary.models.map((row) => row.model), ...Object.keys(rateCard)]),
  ].sort();
  const modelInfo: UsageInfo = {
    buttonLabel: "Show input and output cost rates for every model",
    heading: "Rate card — USD per million tokens",
    columns: ["Model", "Input / M", "Output / M"],
    rows: modelsInPlay.map((model) => {
      const rates = rateCard[model];
      return rates
        ? [model, `$${rates.inputPerMillionUsd}`, `$${rates.outputPerMillionUsd}`]
        : [model, "unknown", "unknown"];
    }),
    footnote: `${RATE_CARD_SOURCE} Override with the AI_MODEL_RATES environment variable. A model with unknown rates is recorded in tokens and left unpriced — it is never costed at zero.`,
  };

  // The ⓘ beside "Usage by use case": mean cost of one call, which is the
  // number that answers "is ProspectAsk or matching the expensive one?".
  const useCaseInfo: UsageInfo = {
    buttonLabel: "Show average cost per call for each use case",
    heading: "Average estimated cost per call",
    columns: ["Use case", "Calls", "Avg / call"],
    rows: summary.useCases.map((row) => [
      USE_CASE_LABELS[row.useCase],
      row.calls.toLocaleString(),
      formatUsd(row.averageCostUsd),
    ]),
    footnote:
      "Averaged over the calls that could be priced. A use case using provider-run web search is an under-estimate — see the note under the charts.",
  };

  return (
    <div>
      <p className="ef-eyebrow mb-2">Admin</p>
      <h1 className="ef-page mb-2">AI audit</h1>
      <p className="ef-lead mb-4" style={{ maxWidth: 720 }}>
        Every model call your organization has made, with the tokens it used and what we estimate
        it cost.
      </p>

      {/* The caveat leads, rather than sitting in a tooltip. These numbers get
          quoted in budget conversations, and an estimate presented as a bill is
          the one failure mode that matters here. */}
      <div
        className="mb-8 rounded-[10px] p-3"
        style={{ background: "var(--bg-subtle)", maxWidth: 720 }}
      >
        <p className="ef-small">
          <strong>Costs are estimates.</strong> They are computed from a configured rate card, not
          from Groq&apos;s billing. Reconcile them against the real invoice before treating them as
          spend. {RATE_CARD_SOURCE}
        </p>
      </div>

      <h2 className="ef-subhead mb-3" style={{ fontSize: 18 }}>
        Totals
      </h2>
      <div className="mb-3 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        {summary.windows.map((window, index) => (
          <StatCard
            key={window.key}
            label={`${window.label} — tokens`}
            value={window.totalTokens.toLocaleString()}
            // One emphasised tile per surface, per the design system.
            emphasis={index === 0}
          />
        ))}
      </div>
      <div className="mb-2 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        {summary.windows.map((window) => (
          <StatCard
            key={window.key}
            label={`${window.label} — est. cost`}
            value={formatUsd(window.costUsd)}
          />
        ))}
      </div>
      <p className="ef-caption mb-8" style={{ color: "var(--text-secondary)" }}>
        {summary.windows
          .map((w) => `${w.label}: ${w.calls.toLocaleString()} calls, ${w.failedCalls} failed`)
          .join(" · ")}
        {anyUnpriced
          ? " · some calls used a model that is not on the rate card and are not included in the cost totals."
          : ""}
      </p>

      <div
        className="mb-4 grid gap-4"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}
      >
        <AiUsageBarChart
          title="Usage by model"
          description="Total tokens this month, by model."
          emptyMessage="No model calls this month."
          bars={summary.models.map((row) => ({
            key: row.model,
            label: row.model,
            value: row.totalTokens,
            valueLabel: row.totalTokens.toLocaleString(),
            note:
              row.rates === null
                ? "no rate card — cost unknown"
                : `${row.calls.toLocaleString()} calls · ${formatUsd(row.costUsd)}`,
          }))}
          info={modelInfo}
        />

        <AiUsageBarChart
          title="Usage by use case"
          description="Total tokens this month, by what the call was for."
          emptyMessage="No model calls this month."
          bars={summary.useCases.map((row) => ({
            key: row.useCase,
            label: USE_CASE_LABELS[row.useCase],
            value: row.totalTokens,
            valueLabel: row.totalTokens.toLocaleString(),
            note: row.usesBuiltInTools
              ? `${formatUsd(row.costUsd)} · under-reported`
              : `${row.calls.toLocaleString()} calls · ${formatUsd(row.costUsd)}`,
          }))}
          info={useCaseInfo}
        />
      </div>

      {researchUsesTools ? (
        <p className="ef-caption mb-8" style={{ color: "var(--text-secondary)", maxWidth: 720 }}>
          Prospect research runs Groq&apos;s server-side <code>browser_search</code>. Any per-search
          fee is not reported anywhere in the API response, so we cannot record it: the token cost
          shown for research is a <strong>floor</strong>, not the full charge.
        </p>
      ) : (
        <div className="mb-8" />
      )}

      <h2 className="ef-subhead mb-3" style={{ fontSize: 18 }}>
        Top users
      </h2>
      <div className="ef-card mb-10 overflow-x-auto p-0">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr style={{ background: "var(--bg-subtle)" }}>
              <th className="ef-small px-4 py-3" style={{ fontWeight: 700 }}>
                User
              </th>
              <th className="ef-small px-4 py-3" style={{ fontWeight: 700, textAlign: "right" }}>
                Calls
              </th>
              <th className="ef-small px-4 py-3" style={{ fontWeight: 700, textAlign: "right" }}>
                Tokens
              </th>
              <th className="ef-small px-4 py-3" style={{ fontWeight: 700, textAlign: "right" }}>
                Est. cost
              </th>
            </tr>
          </thead>
          <tbody>
            {summary.topUsers.length === 0 ? (
              <tr>
                <td className="ef-small px-4 py-4" colSpan={4} style={{ color: "var(--text-secondary)" }}>
                  No AI usage recorded this month.
                </td>
              </tr>
            ) : (
              summary.topUsers.map((row) => (
                <tr key={row.userId ?? "system"} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                  <td className="ef-small px-4 py-3">{row.name}</td>
                  <td className="ef-small px-4 py-3" style={{ textAlign: "right" }}>
                    {row.calls.toLocaleString()}
                  </td>
                  <td className="ef-small px-4 py-3" style={{ textAlign: "right", fontWeight: 600 }}>
                    {row.totalTokens.toLocaleString()}
                  </td>
                  <td
                    className="ef-small px-4 py-3"
                    style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 12 }}
                  >
                    {formatUsd(row.costUsd)}
                    {row.unpricedCalls > 0 ? (
                      <span className="ef-caption block" style={{ color: "var(--text-secondary)" }}>
                        +{row.unpricedCalls} unpriced
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h2 className="ef-subhead mb-2" style={{ fontSize: 18 }}>
        Transactions
      </h2>
      <p className="ef-small mb-4" style={{ color: "var(--text-secondary)", maxWidth: 720 }}>
        Every call, newest first.{" "}
        {monthTotals ? `${monthTotals.calls.toLocaleString()} this month.` : ""} No prompt or
        response content is recorded — metadata only.
      </p>
      <AiCallTable
        rows={transactions.rows}
        total={transactions.total}
        page={transactions.page}
        pageCount={transactions.pageCount}
        pageSize={AI_AUDIT_PAGE_SIZE}
        sort={params.sort}
        direction={params.direction}
        filters={params.filters}
        models={filterOptions.models}
        users={filterOptions.users}
      />
    </div>
  );
}
