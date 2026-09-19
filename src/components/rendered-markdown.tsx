"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Model-written markdown, rendered.
 *
 * One component for every surface that shows model output — the ProspectAsk
 * chat and the prospect research box — so the safety decisions below are made
 * once rather than re-argued at each call site.
 *
 * SAFETY. This text is untrusted. ProspectAsk summarises the user's own data,
 * and research summarises web pages nobody here wrote; a page can contain
 * anything, including text aimed at whatever renders it. `react-markdown` is
 * built for exactly this: it constructs React elements rather than setting
 * innerHTML, and it ignores raw HTML unless `rehype-raw` is added — which it
 * deliberately is not. It also runs its own URL transform, so a `javascript:`
 * link in the output is dropped rather than rendered.
 *
 * DO NOT add `rehype-raw`, and do not reach for `dangerouslySetInnerHTML`
 * here. Either would turn a prompt-injected page into script execution in the
 * reader's session.
 *
 * `remark-gfm` adds tables, strikethrough, task lists and autolinks. Tables
 * matter most: a model asked for "the top 10 companies" answers with one, and
 * without GFM it arrives as a wall of pipe characters.
 */
export function RenderedMarkdown({ children }: { children: string }) {
  return (
    <div className="ef-markdown ef-small" style={{ wordBreak: "break-word" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Outbound and untrusted: never let a link from model output reach
          // this app's origin with a referrer, and never open it in place.
          a: ({ href, children: linkChildren }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              style={{ color: "var(--blue-500)" }}
            >
              {linkChildren}
            </a>
          ),
          // Tables can be wider than a chat bubble. Scroll the table itself
          // rather than letting it stretch the page — the same rule the data
          // tables follow (see the responsive note in README.md).
          table: ({ children: tableChildren }) => (
            <div style={{ overflowX: "auto", maxWidth: "100%" }}>
              <table>{tableChildren}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
