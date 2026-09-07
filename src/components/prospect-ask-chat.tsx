"use client";

import { useEffect, useRef, useState } from "react";

/**
 * ProspectAsk chat.
 *
 * Request/response with an explicit loading state rather than token streaming:
 * a turn here is a tool-calling loop, so most of the wait is the model querying
 * the database, not writing prose. Streaming would show a blank cursor for that
 * whole stretch. Naming the work ("Looking through your data…") is more honest
 * and more useful than an empty stream.
 *
 * The conversation id is generated once per mounted session and sent with every
 * turn so the server can replay history. It is not an authorization token — the
 * server scopes every read and write by the session user as well.
 */

type Turn = {
  role: "user" | "assistant";
  content: string;
  /** Which tools the answer was built from. Shown so the answer is checkable. */
  tools?: string[];
};

const EXAMPLES = [
  "Who are my top ICP matches in Germany?",
  "Which of my connections changed jobs recently?",
  "Give me a report on my campaign pipeline.",
  "Who do I have the strongest relationships with?",
];

export function ProspectAskChat({ aiConfigured }: { aiConfigured: boolean }) {
  const [conversationId] = useState(() => crypto.randomUUID().replace(/-/g, "").slice(0, 32));
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, busy]);

  async function send(question: string) {
    const trimmed = question.trim();
    if (!trimmed || busy) return;

    setError(null);
    setInput("");
    setTurns((current) => [...current, { role: "user", content: trimmed }]);
    setBusy(true);

    try {
      const response = await fetch("/api/prospect-ask/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, conversationId }),
      });
      const data = (await response.json()) as {
        answer?: string;
        toolCalls?: { name: string; ok: boolean }[];
        error?: string;
      };
      if (!response.ok || !data.answer) {
        throw new Error(data.error ?? "That did not work.");
      }
      setTurns((current) => [
        ...current,
        {
          role: "assistant",
          content: data.answer!,
          tools: [
            ...new Set((data.toolCalls ?? []).filter((call) => call.ok).map((call) => call.name)),
          ],
        },
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {!aiConfigured ? (
        <div
          className="ef-card mb-6"
          style={{ borderColor: "var(--warning)", background: "var(--warning-soft)" }}
        >
          <span className="ef-badge ef-badge-warning mb-2">AI not configured</span>
          <p className="ef-small" style={{ color: "var(--text-secondary)", margin: 0 }}>
            No AI provider is set up on this deployment, so ProspectAsk cannot answer
            questions. It will tell you that rather than guess. Everything else in
            ProspectFlow reads your imported data directly and is unaffected.
          </p>
        </div>
      ) : null}

      <div
        className="ef-card mb-4"
        style={{ minHeight: 320, display: "flex", flexDirection: "column", gap: 16 }}
      >
        {turns.length === 0 ? (
          <div>
            <p className="ef-small mb-3" style={{ color: "var(--text-secondary)" }}>
              Ask about your connections, ICP and channel-partner matches, job changes,
              relationship strength, or your campaigns. Every answer is built from real
              queries against your own data.
            </p>
            <ul
              className="flex flex-wrap gap-2"
              style={{ margin: 0, padding: 0, listStyle: "none" }}
            >
              {EXAMPLES.map((example) => (
                <li key={example}>
                  <button
                    type="button"
                    className="ef-btn ef-btn-secondary"
                    onClick={() => send(example)}
                    disabled={busy}
                  >
                    {example}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {turns.map((turn, index) => (
          <div
            key={index}
            style={{
              alignSelf: turn.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "min(680px, 90%)",
              background: turn.role === "user" ? "var(--info-soft)" : "var(--bg-subtle)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-card)",
              padding: "12px 16px",
            }}
          >
            <p
              className="ef-small"
              style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
            >
              {turn.content}
            </p>
            {turn.tools && turn.tools.length > 0 ? (
              <p
                className="ef-caption"
                style={{ margin: "8px 0 0", color: "var(--text-secondary)" }}
              >
                Built from: {turn.tools.join(", ")}
              </p>
            ) : null}
          </div>
        ))}

        {busy ? (
          <p className="ef-small" style={{ color: "var(--text-secondary)", margin: 0 }}>
            Looking through your data…
          </p>
        ) : null}

        <div ref={endRef} />
      </div>

      {error ? (
        <p className="ef-small mb-3" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div style={{ flex: "1 1 320px" }}>
          <label className="ef-label" htmlFor="prospect-ask-input">
            Your question
          </label>
          <input
            id="prospect-ask-input"
            className="ef-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Who are my top ICP matches in Germany?"
            maxLength={2000}
            disabled={busy}
            autoComplete="off"
          />
        </div>
        <button type="submit" className="ef-btn ef-btn-primary" disabled={busy || !input.trim()}>
          {busy ? "Asking…" : "Ask"}
        </button>
      </form>
    </div>
  );
}
