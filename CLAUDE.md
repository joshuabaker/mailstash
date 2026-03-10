# mailstash

Personal email archive tool. Ingests Google Takeout mbox exports into Cloudflare infrastructure (D1 + R2) and serves a read-only web viewer.

Built to decommission paid Google Workspace accounts while retaining full searchable access to historical email.

## Architecture

pnpm monorepo with two packages:

```
mailstash/
├── pnpm-workspace.yaml
├── schema/
│   └── migrations/0001_initial.sql
├── apps/
│   ├── cli/          # Node.js ingestion tool
│   └── web/          # Cloudflare Pages + Workers viewer
└── package.json
```

### CLI (`apps/cli`)

Run-once-per-mailbox ingestion pipeline. Streams an mbox file, parses each email, uploads blobs to R2, and batch-inserts metadata into D1.

**Invocation:**

```bash
pnpm ingest --account tuple --mbox ~/takeout/tuple.mbox
```

**Pipeline:**

1. Stream mbox via `From ` delimiter detection (not loaded into memory — handles multi-GB files)
2. Parse each raw email buffer with `postal-mime` (not `mailparser` — it's in maintenance mode; `postal-mime` is from the same author, built for modern runtimes)
3. Extract structured metadata: from, to, cc, subject, date, labels, threading info
4. Upload `.eml` and attachments to R2 via S3-compatible API
5. Batch INSERT metadata into D1 via the Cloudflare D1 HTTP API (not via Workers — avoids the 100K request/day free-tier limit)

**Key implementation details:**

- `postal-mime` doesn't auto-extract `X-Gmail-Labels` (a non-standard header Google injects into Takeout mbox exports to preserve Gmail's label structure, including custom labels and hierarchy). Extract this from raw email source before parsing — regex over the raw buffer for the `X-Gmail-Labels:` line.
- Threading: compute `thread_id` at ingestion time. Use the first Message-ID in the `References` header (conversation root). Fall back to `In-Reply-To`. Fall back to own Message-ID for standalone messages. Store on the row, query at read time.
- Inline images: emails reference them via `Content-ID` headers (`cid:` URLs in HTML body). Upload to R2 like any attachment. At render time, the viewer rewrites `cid:` references to R2-served URLs.
- Message-ID normalisation: strip angle brackets, lowercase. If missing, generate a deterministic SHA-256 hash from the first 2KB of the message.
- Good logging with progress: processed count, rate, ETA. Support `--dry-run` for validation without CF writes. Support `--resume` to skip already-uploaded message IDs.
- Config: reads `wrangler.toml` from `apps/web/` to resolve D1 database ID and R2 bucket name (single source of truth). Auth via `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` env vars.

**Stack:** TypeScript, `tsx` for execution, `commander` for CLI args, `postal-mime` for email parsing, `@aws-sdk/client-s3` for R2 uploads.

### Web Viewer (`apps/web`)

Cloudflare Pages (frontend) + Workers (API) + D1 (search) + R2 (blob storage). Read-only email archive viewer.

**Auth:** Cloudflare Access with Google OAuth — restricts the entire domain to a single Google account. No auth code in the app; the network-level gate is sufficient. Workers receive a `CF-Access-JWT-Assertion` header for belt-and-braces validation if desired.

**API (Hono on Workers):**

- `GET /api/accounts` — list accounts for dropdown selector
- `GET /api/search?q=&account=&from=&to=&after=&before=&has_attachment=&page=&limit=` — FTS5 query + structured filters
- `GET /api/emails/:id` — full email with body + attachment list
- `GET /api/threads/:threadId` — all emails in thread, ordered by date, with attachments
- `GET /api/files/attachment/:id` — stream attachment from R2
- `GET /api/files/cid/:emailId/:contentId` — serve inline image by Content-ID (for cid: rewrites)

**Frontend (React SPA on Pages):**

- Account selector dropdown (switch between archived mailboxes)
- Search bar supporting Gmail-style operators: `from:`, `to:`, `after:`, `before:`, `has:attachment`, plus free-text
- Results list with sender, subject, date, attachment indicator, labels
- Thread view: click an email to load the full thread, expand/collapse individual messages
- HTML email body rendered in a sandboxed iframe with `cid:` URLs rewritten to the `/api/files/cid/` endpoint
- Non-inline attachments shown as download links (no preview needed — browsers handle that)

**Stack:** TypeScript, Hono (Workers API), React (Pages frontend), esbuild for bundling.

## Database Schema (D1 / SQLite)

```sql
accounts (id TEXT PK, name TEXT, email TEXT)

emails (
  id TEXT PK,                -- normalised Message-ID
  account_id TEXT FK,
  thread_id TEXT,            -- computed at ingestion: first ref in References chain
  from_address TEXT,
  from_name TEXT,
  to_addresses TEXT,         -- JSON array
  cc_addresses TEXT,         -- JSON array
  subject TEXT,
  date_unix INTEGER,
  date_iso TEXT,
  labels TEXT,               -- JSON array from X-Gmail-Labels
  has_attachments INTEGER,
  body_text TEXT,            -- plain text for FTS
  body_html TEXT,            -- original HTML for rendering
  r2_key TEXT,               -- path to .eml in R2
  in_reply_to TEXT
)

attachments (
  id TEXT PK,                -- {email_id}/{sanitised_filename}
  email_id TEXT FK,
  filename TEXT,
  content_type TEXT,
  size_bytes INTEGER,
  content_id TEXT,           -- for inline images
  is_inline INTEGER,
  r2_key TEXT
)

emails_fts USING fts5(subject, from_name, from_address, to_addresses, body_text)
```

Indexes on: `account_id`, `thread_id`, `date_unix`, `from_address`, `content_id`.

FTS kept in sync via `AFTER INSERT` / `AFTER DELETE` triggers.

## R2 Key Structure

```
{account_id}/emails/{encoded_message_id}.eml
{account_id}/attachments/{encoded_message_id}/{sanitised_filename}
```

## Design Decisions

- **No vector search.** Email search is fundamentally keyword + structured filters. FTS5 on SQLite gives Gmail-parity search. Vector/semantic search is unnecessary complexity.
- **No intermediate SQL files.** The CLI pipes directly to CF via the D1 HTTP API and R2 S3 API. Simpler, one command, no manual batch import step.
- **`postal-mime` over `mailparser`.** Same author, modern runtime support, no Node-specific stream dependencies. Also runs in Workers if ingestion-via-upload is ever added.
- **Cloudflare Access over Clerk/WorkOS.** Free for <50 users, operates at the network level, no auth code needed in the app.
- **Hono over plain Workers.** Lightweight routing, typed bindings, minimal overhead.
- **Sandboxed iframe for HTML email.** Raw HTML emails can contain anything — iframe with `sandbox="allow-same-origin"` isolates it.
- **Threading is an MVP feature**, not a nice-to-have. Precomputed at ingestion time so it's zero-cost at read time.

## Cost Estimate

| Component | Free tier | Paid |
|---|---|---|
| Pages | Unlimited static | — |
| Workers | 100K req/day | $5/mo → 10M req |
| D1 | 5GB, 5M reads/day | $5/mo → 10GB |
| R2 | 10GB storage, no egress | $0.015/GB/mo |
| Access | Free (<50 users) | — |

Expected: $0.15–5.15/month for a 20GB single-user archive.

## Tech Stack

- **Language:** TypeScript throughout
- **Runtime:** Node.js (CLI), Cloudflare Workers (API), browser (frontend)
- **Monorepo:** pnpm workspaces
- **CLI:** commander, postal-mime, @aws-sdk/client-s3, tsx
- **API:** Hono
- **Frontend:** React, esbuild
- **Infra:** Cloudflare Pages, Workers, D1, R2, Access
- **Schema:** SQLite with FTS5
