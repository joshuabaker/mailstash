# mailstash

Personal email archive. Ingests Google Takeout mbox exports into Cloudflare (D1 + R2) and serves a read-only web viewer with full-text search.

Built to decommission paid Google Workspace accounts while keeping searchable access to historical email.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/joshuabaker/mailstash)

This provisions a Worker, D1 database, and R2 bucket on your Cloudflare account. After deploy:

1. **Run the migration** to create tables:
   ```sh
   npx wrangler d1 migrations apply mailstash --remote
   ```

2. **Create R2 API credentials** for presigned uploads:
   - Go to **R2 > Manage R2 API Tokens** in the Cloudflare dashboard
   - Create a token with **Object Read & Write** on the `mailstash` bucket
   - Add the token values as secrets:
     ```sh
     npx wrangler secret put R2_ACCESS_KEY_ID
     npx wrangler secret put R2_SECRET_ACCESS_KEY
     npx wrangler secret put R2_ACCOUNT_ID
     ```

3. **Set up Cloudflare Access** to restrict who can use the app:
   - Go to [Zero Trust > Access > Applications](https://one.dash.cloudflare.com/access/apps)
   - Add a Self-hosted Application for your Worker's domain
   - Configure an identity provider and allowed email addresses
   - The app will show setup instructions until Access is active

4. **Open the app** and import your first mbox file.

## How it works

Ingestion runs entirely in the browser. The File System Access API streams multi-GB mbox files from disk with constant memory. No CLI, no local credentials, no setup wizard — open the app and pick a file.

**Three-phase pipeline (each independently resumable):**

1. **Parse** — Stream mbox from disk, split on `From ` delimiters, write each email to IndexedDB
2. **Upload** — PUT `.eml` and attachment blobs directly to R2 via presigned URLs (parallel, bypasses Worker body limits)
3. **Commit** — Batch metadata to the Worker, which inserts into D1

If the tab crashes, reopen the app — the persisted file handle restores access to the mbox, and IndexedDB has all progress.

## Local development

```sh
pnpm install
pnpm dev          # Vite dev server (frontend)
pnpm dev:worker   # Wrangler dev server (API)
pnpm test         # Run tests
pnpm typecheck    # Type-check both tsconfigs
```

Requires Chrome or Edge (File System Access API). Safari is unsupported.

## Cost

| Component | Free tier | Paid |
|---|---|---|
| Workers + Static Assets | 100K req/day | $5/mo |
| D1 | 5GB, 5M reads/day | $5/mo |
| R2 | 10GB, no egress fees | $0.015/GB/mo |
| Access | Free (<50 users) | — |

Expected: **$0–5/month** for a single-user archive.
