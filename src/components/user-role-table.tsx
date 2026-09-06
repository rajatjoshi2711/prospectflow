"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export type ManagedUser = {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "MEMBER";
  createdAt: string;
};

export function UserRoleTable({
  users,
  currentUserId,
}: {
  users: ManagedUser[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function changeRole(userId: string, role: "ADMIN" | "MEMBER") {
    setError(null);
    setPendingId(userId);
    try {
      const res = await fetch(`/api/admin/users/${userId}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "Failed to update role.");
        return;
      }
      startTransition(() => {
        router.refresh();
      });
    } catch {
      setError("Failed to update role. Check your connection and try again.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div>
      {error ? (
        <div
          className="ef-small mb-4 rounded-[10px] px-4 py-3"
          style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
        >
          {error}
        </div>
      ) : null}

      <div className="ef-card overflow-hidden p-0">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr style={{ background: "var(--bg-subtle)" }}>
              <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>
                Name
              </th>
              <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>
                Email
              </th>
              <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>
                Role
              </th>
              <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>
                Joined
              </th>
              <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isSelf = user.id === currentUserId;
              const busy = isPending && pendingId === user.id;
              const nextRole = user.role === "ADMIN" ? "MEMBER" : "ADMIN";
              return (
                <tr
                  key={user.id}
                  className="border-t"
                  style={{ borderColor: "var(--border-subtle)" }}
                >
                  <td className="ef-small px-5 py-3">
                    {user.name}
                    {isSelf ? (
                      <span
                        className="ef-caption ml-2"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        (you)
                      </span>
                    ) : null}
                  </td>
                  <td className="ef-small px-5 py-3">{user.email}</td>
                  <td className="px-5 py-3">
                    <span
                      className={
                        user.role === "ADMIN"
                          ? "ef-badge ef-badge-info"
                          : "ef-badge ef-badge-neutral"
                      }
                      style={{ textTransform: "capitalize" }}
                    >
                      {user.role.toLowerCase()}
                    </span>
                  </td>
                  <td className="ef-small px-5 py-3">
                    {new Date(user.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-3">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => changeRole(user.id, nextRole)}
                      className="ef-btn ef-btn-secondary"
                      style={{ fontSize: 13, padding: "6px 12px" }}
                    >
                      {busy
                        ? "Updating…"
                        : nextRole === "ADMIN"
                          ? "Promote to admin"
                          : "Demote to member"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
