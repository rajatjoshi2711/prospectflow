"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import type { ProspectResearchView } from "@/lib/prospects/detail";

/**
 * The research box on the prospect page.
 *
 * Latest run is shown in full; earlier runs collapse into a `<details>`
 * history. Re-running APPENDS — nothing is overwritten, because an angle a
 * colleague already acted on has to stay readable.
 *
 * Runs are org-visible and attributed for the same reason notes are, with one
 * extra: a run costs real money, so the author line also tells the reader who
 * paid for it and how stale "recent news" now is.
 *
 * The write is not optimistic. A run takes many seconds, so the button holds a
 * "Searching the web…" state for the whole round trip and then
 * `router.refresh()` re-reads the saved history from the server — one source
 * for the text, the timestamp and the author.
 */
export function ProspectResearch({
  identityKey,
  personName,
  research,
}: {
  identityKey: string;
  personName: string;
  research: ProspectResearchView[];
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [latest, ...history] = research;

  async function run() {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/prospects/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identityKey }),
      });
      if (!res.ok) {
        const message = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(message?.error ?? "That research run did not complete.");
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That research run did not complete.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="ef-btn ef-btn-primary" disabled={running} onClick={() => void run()}>
          {running ? "Searching the web…" : research.length > 0 ? "Run research again" : "Research"}
        </button>
        <span className="ef-caption">
          {running
            ? "This takes up to a minute. Leave the page open."
            : "Searches the web, then saves the result for everyone in your organization."}
        </span>
      </div>

      {error ? (
        <p className="ef-caption" style={{ color: "var(--danger)" }} role="alert">
          {error}
        </p>
      ) : null}

      {running ? (
        <p className="ef-small" style={{ color: "var(--text-secondary)" }} role="status">
          Looking for recent news about {personName} and their company…
        </p>
      ) : null}

      {latest ? (
        <ResearchEntry entry={latest} highlighted />
      ) : (
        <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
          No research on {personName} yet. A run searches the web for recent news about them and
          their company, and suggests one angle to open with.
        </p>
      )}

      {history.length > 0 ? (
        <details>
          <summary className="ef-small" style={{ cursor: "pointer", color: "var(--blue-500)" }}>
            {history.length} earlier {history.length === 1 ? "run" : "runs"}
          </summary>
          <ul className="mt-3 flex flex-col gap-3" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {history.map((entry) => (
              <li key={entry.id}>
                <ResearchEntry entry={entry} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ResearchEntry({
  entry,
  highlighted = false,
}: {
  entry: ProspectResearchView;
  highlighted?: boolean;
}) {
  return (
    <div
      className="rounded-[10px] px-4 py-3"
      style={{
        background: highlighted ? "var(--blue-50)" : "var(--bg-subtle)",
        border: `1px solid ${highlighted ? "var(--blue-100)" : "var(--border-subtle)"}`,
      }}
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="ef-small" style={{ fontWeight: 600 }}>
          {entry.createdAt.toLocaleString()}
        </span>
        <span className="ef-caption">Run by {entry.requestedByName}</span>
      </div>

      {/* The model writes markdown, so it is rendered as markdown — otherwise
          the reader sees literal ** and - characters.

          SAFETY: this text is untrusted. It summarises web pages we did not
          write, and a page can contain anything. `react-markdown` is safe for
          exactly this: it builds React elements rather than setting innerHTML,
          and it ignores raw HTML unless `rehype-raw` is added — which it
          deliberately is not. It also runs its own URL transform, so a
          `javascript:` link in the model's output is dropped rather than
          rendered. Do not add `rehype-raw` or `dangerouslySetInnerHTML` here. */}
      <div className="ef-small ef-markdown" style={{ wordBreak: "break-word" }}>
        <ReactMarkdown
          components={{
            // Links in the body are outbound and untrusted, same rule as the
            // citation links below.
            a: ({ href, children }) => (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                style={{ color: "var(--blue-500)" }}
              >
                {children}
              </a>
            ),
          }}
        >
          {entry.summary}
        </ReactMarkdown>
      </div>

      <div className="mt-3">
        {entry.citations.length === 0 ? (
          // Said plainly rather than hidden: a summary with no sources is still
          // worth reading, but the reader has to know they cannot check it.
          <p className="ef-caption" style={{ color: "var(--neutral-400)" }}>
            This run returned no usable sources, so nothing here is linked. Treat it as a lead to
            verify, not as a citation.
          </p>
        ) : (
          <>
            <div className="ef-eyebrow mb-1">Sources</div>
            <ul className="flex flex-col gap-1" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {entry.citations.map((url) => (
                <li key={url}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ef-caption"
                    style={{ color: "var(--blue-500)", wordBreak: "break-all" }}
                  >
                    {url}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
