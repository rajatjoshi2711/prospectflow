import { NextResponse } from "next/server";

/**
 * Public build-identity endpoint.
 *
 * Answers one question that is otherwise surprisingly hard to answer from
 * outside: *which commit is actually serving this URL right now?* Without it,
 * "the deploy hasn't gone out" and "the deploy went out but the change didn't
 * do what we expected" look identical from a browser, and debugging drifts
 * into guesswork.
 *
 * Everything here comes from Vercel's own system environment variables, which
 * are injected at build time. Locally they are absent and the fields read
 * "unknown", which is itself accurate.
 *
 * Deliberately public (the auth middleware already excludes `/api/*`) and
 * deliberately free of anything sensitive: a commit SHA, branch, region and
 * environment name. No database call, so it answers even when Postgres is
 * unreachable — which also makes it a usable uptime check.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      status: "ok",
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown",
      commitMessage: process.env.VERCEL_GIT_COMMIT_MESSAGE ?? "unknown",
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? "unknown",
      environment: process.env.VERCEL_ENV ?? "local",
      region: process.env.VERCEL_REGION ?? "unknown",
      time: new Date().toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
