import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { isLLMConfigured } from "@/lib/ai";
import { getLatestCompleteBatch } from "@/lib/insights/prospects";
import { ProspectAskChat } from "@/components/prospect-ask-chat";

/**
 * ProspectAsk (build plan feature #6).
 *
 * The chat itself is a client component; this page only resolves two facts the
 * UI needs up front — whether an AI provider is configured, and whether the user
 * has any data to ask about — so both failure modes are explained BEFORE someone
 * types a question and gets a shrug back.
 *
 * `isLLMConfigured()` only reads environment variables; nothing is instantiated,
 * so this page renders fine with no AI credentials at all.
 */
export default async function ProspectAskPage() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const [aiConfigured, batch] = await Promise.all([
    Promise.resolve(isLLMConfigured()),
    getLatestCompleteBatch(session.userId),
  ]);

  return (
    <div>
      <p className="ef-eyebrow mb-2">ProspectAsk</p>
      <h1 className="ef-page mb-2">Ask about your network</h1>
      <p className="ef-lead mb-8" style={{ maxWidth: 680 }}>
        Questions and reports across your connections, ICP and channel-partner matches,
        job changes and campaigns. Answers come from real queries against your own data,
        never from guesswork.
      </p>

      {!batch ? (
        <div className="ef-card mb-6" style={{ maxWidth: 640 }}>
          <span className="ef-badge ef-badge-info mb-2">Get started</span>
          <p className="ef-small mb-3" style={{ color: "var(--text-secondary)" }}>
            You have not completed a LinkedIn import yet, so there is nothing personal to
            query. You can still ask about your organization; upload an export to ask about
            your own connections.
          </p>
          <Link href="/imports" className="ef-btn ef-btn-primary">
            Upload your export
          </Link>
        </div>
      ) : null}

      <ProspectAskChat aiConfigured={aiConfigured} />
    </div>
  );
}
