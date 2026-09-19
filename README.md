# ProspectFlow

An internal tool that turns every employee's LinkedIn network into a shared,
queryable asset: ICP/channel-partner matching, job-change alerts, campaign
tracking, and an AI chat assistant over the whole dataset.

All seven build phases are implemented:

1. **Foundation** — email/password auth, org-by-email-domain bootstrap (first
   signup from a domain becomes its admin), the full database schema, the app
   shell styled with the EmergeFlow Design System, and admin user management.
2. **Ingestion** — direct-to-blob zip upload, background CSV processing via
   Inngest, and an imports page with version history. Every upload is a new
   dated `ImportBatch`; nothing is ever overwritten.
3. **Core dashboards** — the user dashboard (upload reminder, job-change
   alerts, country analytics) and the all-connections dashboard, built on a
   shared prospect table.
4. **ICP / channel-partner matching** — admin-defined ICPs and channel
   partners, Groq-backed scoring behind a deterministic pre-filter, and the
   matched-prospect dashboards.
5. **Campaigns** — personal lead lists from a spreadsheet, with LinkedIn URL
   column auto-detection and editable outreach statuses.
6. **AI depth** — hybrid relationship-strength scoring, org-wide quick
   suggestions, the org dashboard, and the ProspectAsk chatbot.
7. **Polish** — rate limiting and cost guardrails on AI routes, empty/loading/
   error states, manual re-scoring, score provenance, and a responsive pass.

## Stack

- Next.js (App Router) + TypeScript
- Prisma + Postgres
- Tailwind CSS v4, styled with the EmergeFlow Design System tokens
- Auth: email/password, custom session (signed JWT in an httpOnly cookie via
  [`jose`](https://github.com/panva/jose)), passwords hashed with `bcryptjs`
- Ingestion: direct-to-blob upload via [`@vercel/blob`](https://vercel.com/docs/storage/vercel-blob),
  background processing via [Inngest](https://www.inngest.com/), zip
  streaming via `unzipper`, CSV parsing via `papaparse`

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Required in | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Phase 1 | Postgres connection string. Any Postgres works (local, Neon, Supabase, Vercel Postgres, etc.). |
| `DIRECT_DATABASE_URL` | Yes, wherever migrations run | Direct (non-pooled) connection string, used **only** by Prisma Migrate. On Neon it is `DATABASE_URL` with `-pooler` removed from the hostname. Prisma Migrate takes a session-scoped advisory lock that a transaction-mode pooler cannot hold, so `migrate deploy` through the pooler fails with `P1002` after 10s. Runtime queries keep using the pooled `DATABASE_URL`. `prisma generate` does not need it, so `npm install` and `next build` work without it — but `prisma migrate deploy`/`status`/`validate` do. |
| `AUTH_SECRET` | Phase 1 | Random string used to sign session JWTs. Generate with `openssl rand -base64 32`. |
| `BLOB_STORE_ID` / `VERCEL_OIDC_TOKEN` / `BLOB_WEBHOOK_PUBLIC_KEY` | Phase 2 | Vercel Blob, OIDC auth. Auto-injected by Vercel once the Blob store is connected to the project; run `vercel env pull` for local dev. See "Setting up Vercel Blob (OIDC)" below. `BLOB_READ_WRITE_TOKEN` is **not** required. |
| `VERCEL_BLOB_CALLBACK_URL` | No — local testing only | Public tunnel URL so Vercel's `onUploadCompleted` webhook can reach your dev server. |
| `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` | Phase 2 (prod only) | Not needed for local dev against `inngest-cli dev`; required once deployed so Inngest's cloud can reach your app. |
| `GROQ_API_KEY` | Phase 4 — optional | Groq API key for GPT-OSS-120B (`https://api.groq.com/openai/v1`), used to score and explain ICP / channel-partner matches. Get one at [console.groq.com/keys](https://console.groq.com/keys). **Without it the app still works**: matching falls back to the deterministic keyword pre-filter and labels each rationale "(AI scoring unavailable)". Nothing is instantiated at module load, so a missing key never breaks an unrelated route. |
| `LLM_PROVIDER` | No | Selects the provider implementation in `src/lib/ai/index.ts`. Defaults to `groq`; that is the only value today. |
| `GROQ_MODEL` | No | Overrides the model slug. Defaults to `openai/gpt-oss-120b` (the `openai/` prefix is part of Groq's model id, not a vendor switch). |
| `GROQ_FALLBACK_MODEL` | No | Model used when the primary is out of credits, over quota, or rate limited. Defaults to `openai/gpt-oss-20b` — half the price, same `browser_search` support, its own capacity. Set to an empty value to disable the fallback and let those failures surface. Each attempt is logged separately in the AI audit log. |
| `CRON_SECRET` | Phase 6 | Shared secret for the nightly AI sweep at `/api/cron/ai-sweep`. Without it the route refuses with 503 rather than running unauthenticated. |
| `AI_CHAT_LIMIT_PER_HOUR` / `AI_CHAT_LIMIT_PER_DAY` | No | Per-user ProspectAsk limits. Default `20` / `100`. |
| `AI_RECOMPUTE_LIMIT_PER_HOUR` / `AI_RECOMPUTE_LIMIT_PER_DAY` | No | Per-user "re-score now" limits. Default `3` / `10`. |
| `AI_RESEARCH_LIMIT_PER_HOUR` / `AI_RESEARCH_LIMIT_PER_DAY` | No | Per-user prospect research limits (live web search + generation). Default `10` / `30`. |
| `AI_ORG_LIMIT_PER_DAY` | No | Org-wide daily ceiling across all AI-invoking requests. Default `600`. |
| `AI_RATE_LIMIT_ENABLED` | No | Set to `false` to disable rate limiting (local development only). Anything else, including unset, leaves it on. |

### 3. Set up the database

Once `DATABASE_URL` points at a live Postgres instance:

```bash
npm run prisma:migrate   # applies prisma/migrations, or creates a new one if the schema changed
npm run prisma:generate  # regenerates the Prisma client (also runs automatically via postinstall)
```

The initial migration (`prisma/migrations/*_init`) was generated offline
(`prisma migrate diff --from-empty`) against the schema in this repo, since no
live database was available at build time. Running `npm run prisma:migrate`
against a real database will apply it (or, if Prisma decides the migration
history doesn't match, will prompt you to reset the dev database — safe to do
since there's no data yet).

#### Migrations on Vercel

Production deploys apply migrations automatically. Vercel prefers the
`vercel-build` script over `build`, and ours runs `prisma migrate deploy`
before `next build`. A failed migration fails the build, so code is never
deployed against a schema that was not applied.

The migration step is gated on `VERCEL_ENV = production` on purpose. Preview
deployments share the same `DATABASE_URL` as production in this setup, so
running migrations from a branch build would mutate the production schema
before that branch is merged. Previews therefore build against whatever schema
production has already applied.

This means a **local** schema change still needs `npm run prisma:migrate` to
generate the migration file; the deploy only *applies* migrations that are
already committed.

### 4. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). You'll be redirected to
`/login`.

### 5. Try it out

1. Go to `/signup` and create an account with a work email, e.g.
   `alice@acme.com`. Since no organization exists yet for `acme.com`, one is
   created and Alice becomes its `ADMIN`.
2. Sign up a second user with the same domain, e.g. `bob@acme.com`. Bob joins
   the existing `acme.com` organization as a `MEMBER`.
3. Log in as Alice and visit `/admin/users` to promote/demote org members.
   `/admin/*` redirects non-admins back to `/dashboard`.

## How auth works

- `src/lib/auth/password.ts` — bcrypt hashing/verification.
- `src/lib/auth/org.ts` — derives the email domain and finds-or-creates the
  `Organization` for it.
- `src/lib/auth/actions.ts` — server actions (`signUpAction`, `logInAction`,
  `logOutAction`) used directly by the `/signup` and `/login` forms. Signup
  runs the "find-or-create org, decide role" logic inside a single Prisma
  transaction so two simultaneous first-signups from the same domain can't
  both become admin of two different orgs.
- `src/lib/auth/session.ts` — signs/verifies a JWT (via `jose`) containing
  `{ userId, organizationId, role, email, name }` and stores it in an
  httpOnly, `SameSite=Lax` cookie.
- `src/middleware.ts` — runs on every request except `/api/*` and static
  assets. Redirects unauthenticated requests to `/login`, redirects
  authenticated users away from `/login` and `/signup`, and redirects
  non-admins away from `/admin/*`.
- `src/app/(app)/layout.tsx` re-checks the session server-side (defense in
  depth) before rendering the nav shell.

## How ingestion works

1. **Upload.** On `/imports`, the user picks (or drops) a `.zip` file. The
   client calls `uploadPresigned()` from `@vercel/blob/client`, which uploads
   the file directly to Vercel Blob (bypassing the serverless request
   body-size limit) after getting a presigned URL from
   `src/app/api/uploads/blob-token/route.ts`.
2. **Authorization (`getSignedToken`).** That route uses
   `handleUploadPresigned` from `@vercel/blob/client` (server side) together
   with `issueSignedToken` from `@vercel/blob`, both of which authenticate
   over OIDC. Before minting an upload token it reads the real session from
   cookies
   (`getSession()`), rejects anything not ending in `.zip`, caps the size at
   50MB, and embeds `{ userId, organizationId }` from the *verified session*
   as `tokenPayload` — the client never gets to assert its own identity.
3. **`ImportBatch` creation (`onUploadCompleted`).** Once the blob actually
   exists, Vercel calls this callback server-side (it fires even if the
   uploading browser tab has since closed). It decodes the `tokenPayload`,
   re-checks the user/org still match, creates an `ImportBatch` row
   (`status: PENDING`, `blobUrl` set), and sends an `import/batch.created`
   event to Inngest.
4. **Background processing (`src/inngest/functions/process-import.ts`).**
   An Inngest step function: marks the batch `PROCESSING`, downloads the
   zip from Blob, streams it open with `unzipper`, and for each `.csv` entry
   (matched case-insensitively — `Connections.csv`, `Positions.csv`,
   `Invitations.csv`, `messages.csv`, or anything under a `Messages/`
   folder) parses it in streaming mode with `papaparse` and batch-inserts
   rows via `prisma.createMany` in chunks of 500. Every person gets an
   `identityKey` — normalized `linkedinUrl` if present, else
   `sha256(lower(firstName+lastName+company))` (see
   `src/lib/ingestion/identity-key.ts`) — so the same person can be matched
   across CSVs and across batches. Any CSV that isn't one of the known
   files lands in `RawCsvRow` (`sourceFilename` + `rowData: Json`) so
   nothing is silently dropped. On success the batch is marked `COMPLETE`
   with a `fileCount` and `completedAt`, and `User.lastImportAt` is
   updated; on failure it's marked `FAILED` with `errorMessage` and the
   error is rethrown so Inngest applies its retry policy.
5. **Job-change diffing.** Still inside the same function, once a batch
   completes, it compares the two most recent `COMPLETE` batches for that
   user by `identityKey` + current `(title, company)` from `Position` rows,
   and writes a `JobChangeEvent` for every real change. A person who only
   appears in the newer batch (no prior position on record) is not treated
   as a change. Relationship-strength recompute and quick-suggestion
   regeneration are left as `TODO` comments in `process-import.ts` — they
   land in Phase 6.
6. **Imports page.** `src/app/(app)/imports/page.tsx` (server component)
   loads the user's batches; `src/components/imports-manager.tsx` (client)
   handles the drag/drop upload and polls `GET /api/imports` every 4s while
   any batch is `PENDING`/`PROCESSING`, so status transitions show up
   without a full page reload. A completed batch with `JobChangeEvent` rows
   shows an "N job changes detected" badge.

### Running Inngest locally

Inngest needs a dev server that talks to your Next.js app's
`/api/inngest` endpoint:

```bash
npx inngest-cli@latest dev
```

By default it looks for your app at `http://localhost:3000/api/inngest`
(matching `npm run dev`). Open the Inngest dev UI it prints (typically
`http://localhost:8288`) to watch runs, inspect each step, and see
failures/retries for `process-import`. No `INNGEST_EVENT_KEY` /
`INNGEST_SIGNING_KEY` are needed for this local flow — those only matter
once you deploy and Inngest's cloud needs to authenticate with your app.

### Setting up Vercel Blob (OIDC)

Vercel Blob authenticates with OIDC — there is no long-lived secret to
store or rotate.

1. In the [Vercel dashboard](https://vercel.com/dashboard), open (or create)
   the project this repo deploys as.
2. Go to **Storage → Create Database → Blob**, create a store, and connect
   it to the project.
3. Vercel automatically injects `BLOB_STORE_ID`, `VERCEL_OIDC_TOKEN` and
   `BLOB_WEBHOOK_PUBLIC_KEY` into the project's environment on every
   deployment. It does **not** create a `BLOB_READ_WRITE_TOKEN`, and none is
   needed: the app uses `handleUploadPresigned` / `uploadPresigned`, which
   are the OIDC-compatible upload APIs.
4. For local dev, run `vercel env pull` in a linked project to fetch those
   three values into `.env.local`. `VERCEL_OIDC_TOKEN` is short-lived — if
   uploads start failing locally with an auth error, re-run `vercel env pull`.

`BLOB_WEBHOOK_PUBLIC_KEY` is what verifies the `onUploadCompleted` callback
(Ed25519 over `x-vercel-signature`), replacing the read/write token's old
role there. `src/lib/blob.ts` holds the store's access mode (`BLOB_ACCESS`)
in one place — the browser upload and the server-side download in the
Inngest worker both read it, so it must match the store's actual mode.

#### Local-dev caveat: `onUploadCompleted` cannot reach localhost

The upload-completed callback is sent by Vercel's infrastructure to your
app, so it cannot reach `http://localhost:3000`. Uploading locally will put
the file in Blob but no `ImportBatch` row will appear. To exercise the full
flow locally, expose your dev server through a tunnel and point the callback
at it:

```bash
ngrok http 3000
# then in .env.local:
VERCEL_BLOB_CALLBACK_URL="https://your-tunnel.ngrok-free.app"
```

### Testing the full upload flow locally

No live LinkedIn export is needed to exercise the pipeline — a zip with the
right filenames is enough:

1. Create a small test export, e.g.:
   ```
   Connections.csv   (headers: First Name,Last Name,URL,Email Address,Company,Position,Connected On)
   Positions.csv     (headers: First Name,Last Name,Company Name,Title,Location,Started On,Finished On)
   Invitations.csv   (headers: From,To,Direction,Sent At,Message)
   messages.csv      (headers: Conversation ID,From,To,Date,Content)
   something-else.csv  (any other headers — this should land in RawCsvRow)
   ```
   Zip these into e.g. `test-export.zip`. There's no fixture checked into
   this repo yet (`test-fixtures/` is a reasonable place to add one if you
   build it, e.g. a small script that writes the CSVs above and zips them).
2. With `DATABASE_URL` and the Blob OIDC vars set (plus
   `VERCEL_BLOB_CALLBACK_URL` pointing at a tunnel, see above), `npm run dev` running,
   and `npx inngest-cli@latest dev` running in another terminal, log in and
   go to `/imports`.
3. Upload `test-export.zip`. Watch the version history row go
   `Pending` → `Processing` → `Complete` (the page polls automatically).
4. Check the Inngest dev UI for the `process-import` run and its steps, and
   query the database (e.g. `npx prisma studio`) to confirm rows landed in
   `Connection`, `Position`, `Invitation`, `MessageRecord`, and
   `RawCsvRow`.
5. Upload the same zip a second time (optionally with a changed title/
   company in `Positions.csv`) and confirm a second `ImportBatch` is
   created (never overwriting the first) and, if a tracked person's title
   or company changed, a `JobChangeEvent` row appears and the "N job
   changes detected" badge shows on the newer batch.

## How ICP / channel partner matching works

Admins define ICPs (`/admin/icps`) and channel partners
(`/admin/channel-partners`). Every member's connections are then scored
against those definitions and the results land in `ProspectMatch`, which
drives `/icps`, `/channel-partners`, and the two top-five boxes on the
dashboard.

Scoring is two-stage, because sending every connection to a model would be
O(connections x definitions) calls:

1. **Deterministic pre-filter** (`src/lib/matching/prefilter.ts`, CPU only, no
   network). Every connection in the user's latest completed batch is scored
   against each definition with string rules: exact position phrases, position
   and industry keyword overlap, description vocabulary, and a hard country
   exclusion (a connection with *no* country in the export is never excluded —
   LinkedIn's `Connections.csv` frequently has none). Anything below the
   shortlist threshold never reaches a model. The shortlist is capped at 120
   candidates per definition.
2. **LLM scoring** (`src/lib/matching/score.ts`). The shortlist goes to
   GPT-OSS-120B in batches of ten in JSON mode, returning a 0-100 score and a
   one-sentence rationale per candidate. Only matches scoring 40+ are stored.

**Cost ceiling**: at most `definitions x 12` model calls per user per run,
independent of network size. A batch that fails or comes back unparseable
falls back to its pre-filter score rather than failing the run; with no
`GROQ_API_KEY` at all, every score is the pre-filter's and is labelled as such.

**Triggers**: `matches/recompute.requested`, sent (a) by `process-import`
after an import completes, for that user, and (b) by the admin ICP /
channel-partner API routes after a create or edit, for the whole org and
narrowed to the changed definition. Deleting a definition needs no recompute —
`ProspectMatch` cascades off its FK.

**Idempotency**: `ProspectMatch` has unique constraints on
`(connectionId, icpId)` and `(connectionId, channelPartnerId)`, and the job
upserts on those pairs and then deletes every other row for that definition
belonging to the user. Re-running produces the same table, never duplicates.
The Inngest function is limited to one concurrent run per organization so two
runs cannot prune each other's writes.

## AI cost guardrails

Everything that can reach a model is bounded, in three independent places.

**Per request.** One ProspectAsk question costs at most `MAX_MODEL_CALLS_PER_TURN`
(5) model calls: four tool-calling rounds plus one final answer with tools
withdrawn. That is enforced by both the loop bound and an explicit call counter
in `src/lib/prospect-ask/agent.ts`, so restructuring the loop cannot silently
raise the ceiling. Tool calls within a round are capped at 4, and a tool result
larger than 12KB is truncated before it is sent back.

**Per user and per org.** `src/lib/ai/rate-limit.ts` charges every AI-invoking
route against fixed hourly and daily windows, plus an org-wide daily budget. A
caller who runs out gets a 429 with a written explanation in the usual `error`
field — the chat UI renders it as a sentence, not as a status code. Limits come
from the env vars above.

*Why Postgres and not Redis/KV.* In-memory counters are not a rate limit on
Vercel: serverless instances are created and discarded per burst, so a module
scoped `Map` resets constantly and is per-instance even when it survives.
`@vercel/kv`/Upstash is the textbook answer and is better at high volume, but it
is another service to provision, pay for, and keep alive. Postgres is already a
hard dependency of every route being protected — ProspectAsk cannot answer
without it, since it persists both sides of each turn to `ChatMessage` — so one
indexed `INSERT ... ON CONFLICT DO UPDATE` per request adds no new
infrastructure and no new failure mode, and is noise next to a multi-second Groq
call. Windows are fixed rather than sliding, which can let through up to 2x the
limit across a boundary; acceptable, since these limits exist to bound spend
rather than to be exactly fair per request. The limiter fails **closed**. If it
ever needs to move to Redis, `consumeAiQuota` is the only function callers
touch.

**Per batch job.** The background jobs were already capped and those caps are
real:

| Job | Cap | Worst case |
| --- | --- | --- |
| `compute-relationship-scores` | 400 people per user per run, 15 per model call; people with no message and no invitation note are never scored at all | 27 model calls per user per run, independent of network size |
| `compute-quick-suggestions` | digest capped at 60 candidates, output at 8 | exactly 1 model call per org per run |
| `compute-matches` | see `src/lib/matching/run.ts` | bounded by the keyword pre-filter, not by connection count |

All three run at `concurrency: 1` per organization and `retries: 1`, and the
Groq client itself uses `maxRetries: 1`, so the worst case for any single call
is 4 attempts rather than the 9+ you get from stacking default retry policies.

## Relationship scoring: running, ready, or nothing to score

Scoring runs in Inngest, out of band from every page, so a page cannot tell from
the score table alone whether a run is mid-flight. `User.relationshipScoreRequestedAt`
and `relationshipScoreComputedAt` are stamped at every enqueue and every run
completion; `src/lib/relationship/state.ts` turns that pair into a status the
dashboard and connections page render, with a "Re-score now" control beside it
(admins also get an org-wide variant). The control is rate limited like any other
AI route.

The distinction the status preserves: a finished run with zero scores means the
export carried no messages or invitation notes, which is a gap in the data and
not a weak network. That is stated in those words rather than left as a blank
column.

## Project structure

```
prisma/schema.prisma          full data model (see below)
prisma/migrations/            offline-generated migrations
src/middleware.ts             route guarding (auth + admin role)
src/lib/prisma.ts             Prisma client singleton
src/lib/auth/                 session, password hashing, org bootstrap, server actions
src/lib/ingestion/identity-key.ts  identityKey computation (LinkedIn URL or name+company hash)
src/inngest/client.ts         Inngest client instance + event types
src/inngest/functions/process-import.ts  unzip, parse, ingest, diff job changes
src/inngest/functions/compute-matches.ts ICP / channel-partner scoring job
src/lib/ai/provider.ts        LLMProvider interface + JSON parsing helpers
src/lib/ai/groq.ts            Groq implementation (openai SDK, lazy client)
src/lib/ai/index.ts           getLLMProvider() / tryGetLLMProvider()
src/lib/matching/prefilter.ts deterministic shortlisting (no network)
src/lib/matching/score.ts     batched LLM scoring of a shortlist
src/lib/matching/run.ts       orchestration + idempotent upsert/prune
src/lib/insights/matches.ts   reads ProspectMatch for the dashboards
src/app/(auth)/login          /login
src/app/(auth)/signup         /signup
src/app/(app)/layout.tsx      authenticated nav shell
src/app/(app)/dashboard       user dashboard (placeholder)
src/app/(app)/org             org dashboard (placeholder)
src/app/(app)/icps            all-ICPs dashboard (paginated, filterable)
src/app/(app)/channel-partners all-channel-partners dashboard
src/app/(app)/connections
src/app/(app)/campaigns(+/new, +/[id])
src/app/(app)/imports         fully functional: upload zip, version history
src/app/(app)/prospect-ask
src/app/(app)/admin/users     fully functional: list org users, promote/demote
src/app/(app)/admin/icps(+[id])         ICP CRUD, admin-gated
src/app/(app)/admin/channel-partners(+[id]) channel partner CRUD, admin-gated
src/app/api/admin/users/[id]/role/route.ts  PATCH — change a user's role
src/app/api/admin/icps/route.ts             POST — create an ICP
src/app/api/admin/icps/[id]/route.ts        PATCH / DELETE an ICP
src/app/api/admin/channel-partners/route.ts POST — create a channel partner
src/app/api/admin/channel-partners/[id]/route.ts PATCH / DELETE
src/app/api/uploads/blob-token/route.ts     Vercel Blob client-upload authorization
src/app/api/imports/route.ts                GET — current user's import batches (polling)
src/app/api/inngest/route.ts                Inngest serve handler
src/components/imports-manager.tsx          upload form + version history table (client)
```

## Data model

`prisma/schema.prisma` includes the full model set from the build plan
(`Organization`, `User`, `ImportBatch`, `Connection`, `Position`,
`Invitation`, `MessageRecord`, `RawCsvRow`, `JobChangeEvent`, `ICP`,
`ChannelPartner`, `ProspectMatch`, `Campaign`, `CampaignLead`,
`RelationshipStrengthScore`, `QuickSuggestion`, `ChatMessage`) even though
only the `Organization`/`User` pieces are wired up to application code in
this phase. This lets later phases build against a stable, already-migrated
schema instead of bolting models on incrementally.

## Design system

All UI uses the EmergeFlow Design System (Sora for display type, Manrope for
body/UI, the EmergeFlow blue/green/neutral palette, standard radii/shadows).
Tokens live as CSS custom properties in `src/app/globals.css`, plus small
utility classes (`ef-btn`, `ef-card`, `ef-badge`, `ef-input`, etc.) mirroring
the design system's own reference CSS.

**Light theme only, deliberately.** The EmergeFlow Design System defines one
light palette and no dark equivalents for its semantic colors, brand gradient or
soft badge tints. Inventing a dark set would mean inventing brand colors, and
half-implementing it is worse than not doing it — `prefers-color-scheme` would
darken the chrome while every hard-coded `#fff` card stayed light. `globals.css`
therefore declares `color-scheme: light` explicitly and documents what adding
dark mode would actually require.

**Responsive.** The layout works down to phone width: the sidebar is off-canvas
below 768px behind a header toggle, and is unchanged at `md` and above. Known
limitation: the data tables (connections, matches, campaign leads) stay
horizontally scrollable inside their own container at small widths rather than
restacking as cards. They are comparison views with five or six columns, and a
card stack loses the column alignment that makes them useful. Readable and
usable on a phone, but the product is built for a desktop screen.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the Next.js dev server |
| `npm run build` | Production build |
| `npm run start` | Start the production server (after `build`) |
| `npm run lint` | ESLint |
| `npm run prisma:generate` | Regenerate the Prisma client |
| `npm run prisma:migrate` | Run `prisma migrate dev` against `DATABASE_URL` |

## Known limitations

- **Country analytics.** LinkedIn's `Connections.csv` has no country column, so
  the dashboard's country chart stays empty until country data is enriched onto
  connections from another source. The chart says so rather than showing zero.
- **Data tables on phones** scroll horizontally rather than restacking (see
  "Design system" above).
- **Light theme only** (see above).
- **Rate-limit windows are fixed**, not sliding, so a burst spanning a window
  boundary can briefly exceed the nominal limit.
- **Relationship scoring is capped at 400 people per user per run**, ranked by
  evidence weight. In a very large network the thinnest-evidence relationships
  fall outside the cap and render with the transparent heuristic instead, now
  labelled "estimated" in the table so the difference is visible.
