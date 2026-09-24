"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { logOutAction } from "@/lib/auth/actions";

/**
 * The app shell.
 *
 * RESPONSIVE (Phase 7)
 * --------------------
 * The sidebar was a fixed 256px column with no small-screen handling, which ate
 * most of a phone viewport and left the tables with nowhere to go. It is now
 * off-canvas below the `md` breakpoint (768px) and slides in over a scrim from
 * a header toggle; at `md` and up nothing changed — it is the same static
 * column it always was, so no desktop layout is disturbed.
 *
 * The drawer closes on navigation and on Escape. Its transform transition is
 * covered by the global `prefers-reduced-motion` rule in globals.css.
 *
 * The data-dense tables inside are a separate matter: they stay horizontally
 * scrollable in their own container rather than being restacked as cards. See
 * the responsive note in README.md.
 */

type NavItem = {
  href: string;
  label: string;
};

const MAIN_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/org", label: "Org dashboard" },
  { href: "/connections", label: "Connections" },
  { href: "/companies", label: "Companies" },
  { href: "/icps", label: "ICPs" },
  { href: "/channel-partners", label: "Channel partners" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/imports", label: "Imports" },
  { href: "/prospect-ask", label: "ProspectAsk" },
];

const ADMIN_NAV: NavItem[] = [
  { href: "/admin/organization", label: "Organization" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/icps", label: "ICP definitions" },
  { href: "/admin/channel-partners", label: "Channel partner definitions" },
  { href: "/admin/ai-audit", label: "AI audit" },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavShell({
  children,
  name,
  email,
  role,
  orgName,
}: {
  children: React.ReactNode;
  name: string;
  email: string;
  role: string;
  orgName: string;
}) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (!navOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navOpen]);

  return (
    // min-h-screen, NOT h-screen + overflow-hidden. The shell used to be a
    // fixed-height box with `main` as its own scroll container, which meant
    // `main` was always exactly one viewport tall — leaving dead space under
    // short pages — and any overflow on `body` produced a second scrollbar
    // next to `main`'s. Letting the page scroll normally and sticking the
    // sidebar to it keeps the sidebar pinned with exactly one scrollbar.
    <div className="flex min-h-screen" style={{ background: "var(--bg-subtle)" }}>
      {/* Scrim. Present only while the drawer is open, and only below `md`. */}
      {navOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-30 md:hidden"
          onClick={() => setNavOpen(false)}
          style={{ background: "rgba(17, 25, 40, 0.4)", border: "none", cursor: "pointer" }}
        />
      ) : null}

      <aside
        id="app-nav"
        // Below md it is an off-canvas drawer (fixed). At md and up it is
        // sticky rather than static, so it stays put as the page scrolls
        // without the shell having to own the scrolling itself.
        className={`fixed inset-y-0 left-0 z-40 flex h-screen w-64 shrink-0 flex-col border-r transition-transform md:sticky md:top-0 md:translate-x-0 md:self-start ${
          navOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{
          borderColor: "var(--border-subtle)",
          background: "#fff",
          transitionDuration: "var(--dur-2)",
          transitionTimingFunction: "var(--ease-out)",
        }}
      >
        <div className="flex shrink-0 items-center gap-2 px-5 py-4">
          <div
            aria-hidden
            className="flex h-8 w-8 items-center justify-center rounded-[8px]"
            style={{ background: "var(--grad-brand)" }}
          >
            <span className="text-white" style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 15 }}>
              E
            </span>
          </div>
          <div className="leading-tight">
            <div className="ef-subhead" style={{ fontSize: 15 }}>
              ProspectFlow
            </div>
            <div className="ef-caption truncate" style={{ maxWidth: 160 }}>
              {orgName}
            </div>
          </div>
        </div>

        {/* Compact enough to fit a full nav (workspace + admin) without scrolling
            on a standard viewport; overflow-y-auto stays only as a safety valve
            for very short windows so items can never become unreachable. */}
        <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-1">
          <div className="ef-eyebrow px-2 pb-1 pt-1">Workspace</div>
          <ul className="flex flex-col gap-0.5">
            {MAIN_NAV.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    // Dismiss the drawer on navigation, or the destination
                    // renders behind a sheet the reader has to close by hand.
                    // Done here rather than in a pathname effect, which would
                    // be a cascading render.
                    onClick={() => setNavOpen(false)}
                    className="ef-small block rounded-[8px] px-3 py-1.5 transition-colors"
                    style={{
                      color: active ? "var(--blue-500)" : "var(--text-primary)",
                      background: active ? "var(--blue-50)" : "transparent",
                      fontWeight: active ? 700 : 500,
                    }}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>

          {role === "ADMIN" ? (
            <>
              <div className="ef-eyebrow px-2 pb-1 pt-4">Admin</div>
              <ul className="flex flex-col gap-0.5">
                {ADMIN_NAV.map((item) => {
                  const active = isActive(pathname, item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setNavOpen(false)}
                        className="ef-small block rounded-[8px] px-3 py-1.5 transition-colors"
                        style={{
                          color: active ? "var(--blue-500)" : "var(--text-primary)",
                          background: active ? "var(--blue-50)" : "transparent",
                          fontWeight: active ? 700 : 500,
                        }}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
        </nav>

        <div
          className="shrink-0 border-t px-4 py-3"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <div className="mb-2">
            <div className="ef-small" style={{ fontWeight: 600 }}>
              {name}
            </div>
            <div className="ef-caption truncate">{email}</div>
            <span
              className="ef-badge ef-badge-info mt-1"
              style={{ textTransform: "capitalize" }}
            >
              {role.toLowerCase()}
            </span>
          </div>
          <form action={logOutAction}>
            <button type="submit" className="ef-btn ef-btn-secondary w-full">
              Log out
            </button>
          </form>
        </div>
      </aside>

      {/* min-w-0 keeps wide tables from stretching the flex row. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex shrink-0 items-center gap-3 border-b px-4 py-3 md:hidden"
          style={{ borderColor: "var(--border-subtle)", background: "#fff" }}
        >
          <button
            type="button"
            className="ef-btn ef-btn-secondary"
            aria-expanded={navOpen}
            aria-controls="app-nav"
            onClick={() => setNavOpen((open) => !open)}
            style={{ padding: "8px 12px" }}
          >
            <span aria-hidden>☰</span>
            Menu
          </button>
          <span className="ef-subhead" style={{ fontSize: "var(--fs-small)" }}>
            ProspectFlow
          </span>
        </header>

        {/* No overflow-y-auto: the page scrolls, not this element, so main is
            only as tall as its content. */}
        <main className="min-w-0 flex-1">
          <div className="ef-container-product py-6 md:py-10">{children}</div>
        </main>
      </div>
    </div>
  );
}
