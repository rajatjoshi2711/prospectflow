"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logOutAction } from "@/lib/auth/actions";

type NavItem = {
  href: string;
  label: string;
};

const MAIN_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/org", label: "Org dashboard" },
  { href: "/connections", label: "Connections" },
  { href: "/icps", label: "ICPs" },
  { href: "/channel-partners", label: "Channel partners" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/imports", label: "Imports" },
  { href: "/prospect-ask", label: "ProspectAsk" },
];

const ADMIN_NAV: NavItem[] = [
  { href: "/admin/users", label: "Users" },
  { href: "/admin/icps", label: "ICP definitions" },
  { href: "/admin/channel-partners", label: "Channel partner definitions" },
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

  return (
    <div className="flex min-h-screen" style={{ background: "var(--bg-subtle)" }}>
      <aside
        className="flex w-64 shrink-0 flex-col border-r"
        style={{ borderColor: "var(--border-subtle)", background: "#fff" }}
      >
        <div className="flex items-center gap-2 px-5 py-5">
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

        <nav className="flex-1 overflow-y-auto px-3 py-2">
          <div className="ef-eyebrow px-2 pb-2 pt-2">Workspace</div>
          <ul className="flex flex-col gap-1">
            {MAIN_NAV.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="ef-small block rounded-[8px] px-3 py-2 transition-colors"
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
              <div className="ef-eyebrow px-2 pb-2 pt-6">Admin</div>
              <ul className="flex flex-col gap-1">
                {ADMIN_NAV.map((item) => {
                  const active = isActive(pathname, item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className="ef-small block rounded-[8px] px-3 py-2 transition-colors"
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
          className="border-t px-4 py-4"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <div className="mb-3">
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

      <main className="flex-1 overflow-y-auto">
        <div className="ef-container-product py-10">{children}</div>
      </main>
    </div>
  );
}
