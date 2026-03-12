# MailStash

Personal email archive tool. Ingests Google Takeout mbox exports into Cloudflare infrastructure (D1 + R2) and serves a read-only web viewer.

Built to decommission paid Google Workspace accounts while retaining full searchable access to historical email.

## Architecture

pnpm monorepo, single package:

```
mailstash/
├── pnpm-workspace.yaml
├── schema/
│   └── migrations/0001_initial.sql
├── apps/
│   └── web/          # Cloudflare Workers (API + ingestion) + static frontend
└── package.json
```

### Web (`apps/web`)

Cloudflare Workers (API) + static assets (frontend) + D1 (search) + R2 (blob storage). Handles both email ingestion and the read-only viewer.

**No CLI.** Ingestion runs entirely in the browser. The File System Access API (`showOpenFilePicker`) streams multi-GB mbox files from disk with constant memory. This eliminates the need for Node.js, local credentials, or any setup wizard — the user just opens the app and picks a file.

**Auth:** Cloudflare Access — restricts the entire domain to allowed email addresses. No auth code in the app; the network-level gate handles everything. The user configures Access in the Cloudflare Zero Trust dashboard after deploy (identity provider, allowed emails, application URL).

**Access detection:** The Worker checks for the `CF-Access-JWT-Assertion` header on every request. If present, Access is configured and the user is authenticated. If missing, the app shows a first-run setup screen that links directly to the Zero Trust dashboard (`https://one.dash.cloudflare.com/access/apps`) with instructions to add an Access Application for the mailstash domain. All API endpoints return 403 until Access is active — the app is non-functional without it, by design.

**Ingestion pipeline (three-phase, each independently resumable):**

Phase 1 — **Stream mbox → IndexedDB** (local, no network):
1. File System Access API reads .mbox file as a stream
2. Browser splits on `From ` delimiters, writes each raw email into IndexedDB
3. Runs at full disk speed — no network dependency, no failure modes beyond disk space
4. The `FileSystemFileHandle` is persisted in IndexedDB for cross-session resume
5. On resume: `handle.requestPermission()` prompts the user to re-confirm access (one click, no file picker), then streaming continues from where it left off

Phase 2 — **Upload binaries → R2** (browser direct, parallel):
1. For each email in IDB with state `parsed`, the Worker generates presigned R2 upload URLs
2. Browser PUTs .eml and attachment blobs directly to R2 (bypasses Worker body limits entirely)
3. Parallel uploads (configurable concurrency) for throughput
4. On completion, email state in IDB updates to `uploaded`

Phase 3 — **Flush metadata → D1** (JSON-only batches via Worker):
1. Browser batches metadata for 50-100 emails into a single `POST /api/ingest/batch/:accountId`
2. Worker parses raw emails with `postal-mime`, extracts metadata/labels/threading, runs `DB.batch()` for all inserts
3. Payload is JSON-only (no binaries) — tiny requests, large batches
4. On confirmation, email state in IDB updates to `committed`

Each email in IDB tracks its state: `parsed` → `uploaded` → `committed`. Resume at any phase picks up from where it left off. If the tab crashes, the user reopens the app, the persisted file handle restores access to the mbox, and IDB has all progress.

**Key implementation details:**

- `postal-mime` runs natively in Workers — no Node.js dependencies needed.
- `postal-mime` doesn't auto-extract `X-Gmail-Labels` (a non-standard header Google injects into Takeout mbox exports to preserve Gmail's label structure). Extracted via regex on the raw email source before parsing.
- Threading: compute `thread_id` at ingestion time. Use the first Message-ID in the `References` header (conversation root). Fall back to `In-Reply-To`. Fall back to own Message-ID for standalone messages.
- Inline images: emails reference them via `Content-ID` headers (`cid:` URLs in HTML body). Upload to R2 like any attachment. At render time, the viewer rewrites `cid:` references to R2-served URLs.
- Message-ID normalisation: strip angle brackets, lowercase. If missing, generate a deterministic SHA-256 hash from the first 2KB of the message.
- R2 direct upload via presigned URLs avoids Worker body size limits. Worker CPU stays minimal — only D1 metadata inserts.
- Safari is unsupported — requires File System Access API (Chrome/Edge).

**API (Hono on Workers):**

- `GET /api/accounts` — list accounts
- `POST /api/accounts` — create/update account
- `POST /api/ingest/presign/:accountId` — generate presigned R2 upload URLs for a batch of files
- `POST /api/ingest/batch/:accountId` — ingest a batch of raw emails (Worker parses metadata, inserts into D1)
- `GET /api/search?q=&account=&from=&to=&after=&before=&has_attachment=&page=&limit=` — FTS5 query + structured filters
- `GET /api/emails/:id` — full email with body + attachment list
- `GET /api/threads/:threadId` — all emails in thread, ordered by date
- `GET /api/files/attachment/:id` — stream attachment from R2
- `GET /api/files/cid/:emailId/:contentId` — serve inline image by Content-ID

**Frontend (static assets served by Workers):**

- Import flow: account picker → file picker → three-phase progress (parsing → uploading → committing)
- Account selector dropdown (switch between archived mailboxes)
- Search bar supporting Gmail-style operators: `from:`, `to:`, `after:`, `before:`, `has:attachment`, plus free-text
- Results list with sender, subject, date, attachment indicator, labels
- Thread view: expand/collapse individual messages
- HTML email body rendered in a sandboxed iframe with `cid:` URL rewriting

**Stack:** TypeScript (Workers), vanilla JS (frontend), Hono, postal-mime.

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

- **No CLI.** Ingestion runs in the browser via File System Access API. Three-phase pipeline (IndexedDB → R2 direct → D1 batch) makes each step independently resumable and avoids Worker body size limits.
- **IndexedDB as write-ahead log.** Decouples mbox parsing (disk-speed) from network uploads. Crash-safe — every email's state is tracked and resumable. File handle persistence means the user never re-navigates the file picker.
- **R2 direct upload via presigned URLs.** Binaries never touch the Worker. Keeps Worker CPU minimal and avoids the 100MB request body limit.
- **No vector search.** Email search is fundamentally keyword + structured filters. FTS5 on SQLite gives Gmail-parity search.
- **`postal-mime` over `mailparser`.** Same author, modern runtime support, runs natively in Workers.
- **Cloudflare Access.** Free for <50 users, operates at the network level, no auth code in the app. Supports OTP (zero setup), Google OAuth, GitHub, etc — whatever the user configures. Worker detects whether Access is active via `CF-Access-JWT-Assertion` header and blocks all API access until it is.
- **Hono over plain Workers.** Lightweight routing, typed bindings, minimal overhead.
- **Sandboxed iframe for HTML email.** Raw HTML emails can contain anything — iframe with `sandbox="allow-same-origin"` isolates it.
- **Threading is an MVP feature**, not a nice-to-have. Precomputed at ingestion time so it's zero-cost at read time.
- **Safari unsupported.** File System Access API is Chrome/Edge only. Not worth the fallback complexity for a personal tool.

## Cost Estimate

| Component | Free tier | Paid |
|---|---|---|
| Workers + Static Assets | 100K req/day | $5/mo → 10M req |
| D1 | 5GB, 5M reads/day | $5/mo → 10GB |
| R2 | 10GB storage, no egress | $0.015/GB/mo |
| Access | Free (<50 users) | — |

Expected: $0.15–5.15/month for a 20GB single-user archive.

## Tech Stack

- **Language:** TypeScript (Workers), vanilla JS (frontend)
- **Runtime:** Cloudflare Workers (API + ingestion), browser (frontend + mbox streaming)
- **Monorepo:** pnpm workspaces
- **API:** Hono, postal-mime
- **Frontend:** Vanilla JS, File System Access API, IndexedDB
- **Infra:** Cloudflare Workers, D1, R2, Access
- **Schema:** SQLite with FTS5
