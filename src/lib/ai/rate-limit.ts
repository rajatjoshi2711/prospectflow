import "server-only";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getActionLimits,
  getOrgDailyLimit,
  isRateLimitEnabled,
  type AiAction,
} from "@/lib/ai/limits";

/**
 * Per-user (and per-org) rate limiting for routes that can reach a model.
 *
 * STORAGE CHOICE
 * --------------
 * Postgres, via `AiUsageCounter`. The alternatives and why not:
 *
 *   - In-memory counters: not a rate limit on Vercel at all. Serverless
 *     instances are created and discarded per burst of traffic, so a Map in
 *     module scope is per-instance and resets constantly. Two concurrent
 *     instances give a user two full budgets.
 *   - `@vercel/kv` / Upstash Redis: the textbook answer and genuinely better at
 *     high volume (no table bloat, native TTLs, sub-millisecond). But it is a
 *     new service to provision, connect, pay for, and add to the list of things
 *     that can be down.
 *   - Postgres: already a hard dependency of every route this protects —
 *     ProspectAsk writes both sides of each turn to `ChatMessage`, so a request
 *     that cannot reach Postgres cannot be served anyway. One indexed upsert
 *     per AI request is noise next to a multi-second Groq call.
 *
 * Postgres wins on "adds no new required infrastructure", which is the
 * constraint that matters for this deployment. If ProspectFlow ever outgrows
 * it, the swap is this one file: `consumeAiQuota` is the only thing any caller
 * touches.
 *
 * WINDOWS
 * -------
 * Fixed windows (clock hour, UTC day), not a sliding log. A fixed window can
 * let through up to 2x the limit across a boundary; that is an acceptable
 * trade for a single atomic statement per check, given these limits exist to
 * bound spend rather than to enforce fairness to the request.
 *
 * FAILURE MODE
 * ------------
 * Fails CLOSED. If the counter cannot be written we do not know what has
 * already been spent, and the protected routes cannot function without
 * Postgres regardless, so allowing the request would trade a real cost risk for
 * no benefit. The caller gets the same friendly message as a genuine limit hit,
 * and the cause is logged.
 */

/** Rows older than this are pure garbage and are pruned opportunistically. */
const PRUNE_OLDER_THAN_HOURS = 48;
/** Roughly one in N requests pays for a prune. Keeps the table from growing. */
const PRUNE_SAMPLE_RATE = 50;

export type QuotaDecision =
  | { ok: true }
  | {
      ok: false;
      /** Friendly, complete sentence(s). Safe to show a user verbatim. */
      message: string;
      /** Seconds until the offending window rolls over. */
      retryAfterSeconds: number;
    };

type CounterSpec = {
  subjectKey: string;
  bucket: string;
  windowKind: "hour" | "day";
  limit: number;
  /** Used to build the message when this is the counter that tripped. */
  describe: (limit: number) => string;
};

function startOfHour(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
}

function startOfDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function windowStart(kind: "hour" | "day", now: Date): Date {
  return kind === "hour" ? startOfHour(now) : startOfDay(now);
}

function secondsUntilWindowEnd(kind: "hour" | "day", now: Date): number {
  const start = windowStart(kind, now);
  const lengthMs = kind === "hour" ? 3_600_000 : 86_400_000;
  return Math.max(1, Math.ceil((start.getTime() + lengthMs - now.getTime()) / 1000));
}

/**
 * Atomically increments one counter and returns its new value.
 *
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` is a single statement, so
 * concurrent requests for the same window serialize on the row rather than
 * racing a read-modify-write.
 */
async function increment(spec: CounterSpec, now: Date): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "AiUsageCounter" (
      "id", "subjectKey", "bucket", "windowKind", "windowStart", "count", "createdAt", "updatedAt"
    )
    VALUES (
      ${crypto.randomUUID()}, ${spec.subjectKey}, ${spec.bucket}, ${spec.windowKind},
      ${windowStart(spec.windowKind, now)}, 1, NOW(), NOW()
    )
    ON CONFLICT ("subjectKey", "bucket", "windowKind", "windowStart")
    DO UPDATE SET "count" = "AiUsageCounter"."count" + 1, "updatedAt" = NOW()
    RETURNING "count"
  `;
  return rows[0]?.count ?? 0;
}

/** Best-effort cleanup of elapsed windows. Never blocks or fails a request. */
async function maybePrune(now: Date): Promise<void> {
  if (Math.random() * PRUNE_SAMPLE_RATE >= 1) return;
  const cutoff = new Date(now.getTime() - PRUNE_OLDER_THAN_HOURS * 3_600_000);
  try {
    await prisma.aiUsageCounter.deleteMany({ where: { windowStart: { lt: cutoff } } });
  } catch (error) {
    console.error("AiUsageCounter prune failed", error);
  }
}

/**
 * Charges one request against the caller's quota.
 *
 * Every counter is incremented even when an earlier one has already tripped.
 * That is deliberate: a client hammering a route it is locked out of keeps
 * paying into the window it is locked out by, rather than getting a free retry
 * loop. The only cost is that a denied request also counts, which self-heals
 * when the window rolls over.
 *
 * `userId` and `organizationId` MUST come from the verified session.
 */
export async function consumeAiQuota({
  userId,
  organizationId,
  action,
  now = new Date(),
}: {
  userId: string;
  organizationId: string;
  action: AiAction;
  now?: Date;
}): Promise<QuotaDecision> {
  if (!isRateLimitEnabled()) return { ok: true };

  const limits = getActionLimits(action);
  const orgDailyLimit = getOrgDailyLimit();

  const specs: CounterSpec[] = [
    {
      subjectKey: `user:${userId}`,
      bucket: limits.bucket,
      windowKind: "hour",
      limit: limits.perHour,
      describe: (limit) =>
        `You have used all ${limit} ${limits.label} for this hour. This cap is here to keep AI costs predictable — it resets at the top of the hour.`,
    },
    {
      subjectKey: `user:${userId}`,
      bucket: limits.bucket,
      windowKind: "day",
      limit: limits.perDay,
      describe: (limit) =>
        `You have used all ${limit} ${limits.label} for today. This cap is here to keep AI costs predictable — it resets at midnight UTC. Ask an admin if you need a higher limit.`,
    },
    {
      subjectKey: `org:${organizationId}`,
      bucket: "org-total",
      windowKind: "day",
      limit: orgDailyLimit,
      describe: (limit) =>
        `Your organization has used all ${limit} AI requests available today, across everyone. The budget resets at midnight UTC; an admin can raise it with the AI_ORG_LIMIT_PER_DAY setting.`,
    },
  ];

  try {
    const counts = await Promise.all(specs.map((spec) => increment(spec, now)));
    void maybePrune(now);

    for (const [index, spec] of specs.entries()) {
      if (counts[index] > spec.limit) {
        return {
          ok: false,
          message: spec.describe(spec.limit),
          retryAfterSeconds: secondsUntilWindowEnd(spec.windowKind, now),
        };
      }
    }
    return { ok: true };
  } catch (error) {
    // Fail closed — see the header. The protected routes need this same
    // database to do anything useful, so this is almost always a symptom of a
    // wider outage rather than a limiter-specific problem.
    console.error("AI rate limit check failed; denying request", error);
    return {
      ok: false,
      message:
        "We could not check your AI usage allowance just now, so this request was not run. Try again in a moment.",
      retryAfterSeconds: 30,
    };
  }
}

/**
 * The 429 a route returns when `consumeAiQuota` denies it.
 *
 * `error` is the same field every other route uses for a human-readable
 * failure, so existing clients (the chat UI included) already render it as a
 * sentence rather than showing a raw status code.
 */
export function rateLimitResponse(decision: Extract<QuotaDecision, { ok: false }>): NextResponse {
  return NextResponse.json(
    { error: decision.message, rateLimited: true, retryAfterSeconds: decision.retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } },
  );
}
