# mailstash

Archive your Gmail and keep it searchable — without paying for Google Workspace.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/joshuabaker/mailstash)

## How it works

Export your email from Google using [Google Takeout](https://takeout.google.com/) (select Gmail, choose `.mbox` format). Then open mailstash in your browser and pick the file.

mailstash reads the file directly from your computer — even multi-gigabyte archives — and uploads everything to your own Cloudflare account. Your emails are stored privately in your account, not shared with any third party.

The import is resumable. If you close the tab or lose your connection, just reopen the app and it picks up where it left off.

Once imported, you get a searchable web interface: browse by thread, search by sender, date, keywords, or attachments.

Requires Chrome or Edge.

## Estimated cost

mailstash runs on Cloudflare's infrastructure. Each component has a free tier, and you only pay if you exceed it.

| Component | Free allowance | Paid rate above free tier |
|---|---|---|
| Workers (runs the app) | 100,000 requests/day | $5/month for 10M requests |
| D1 (email metadata + search) | 5 GB storage | $0.75/GB/month beyond 5 GB |
| R2 (email files + attachments) | 10 GB storage, no download fees | $0.015/GB/month beyond 10 GB |
| Access (login protection) | Free for up to 50 users | — |

**A small archive (under 5,000 emails, ~2 GB of files)** fits entirely within the free tier. You'd pay nothing beyond a Cloudflare account.

**A larger archive (50,000 emails, ~20 GB of files)** would exceed the free R2 storage by about 10 GB, adding roughly $0.15/month. D1 would likely stay within its free 5 GB. Total: **under $1/month**. The free tier still applies — you only pay for the portion above the free allowance, not the full amount.

## Deploy

Click the deploy button above to provision the app on your Cloudflare account. After it finishes, there are three setup steps:

1. **Create the database tables:**
   ```sh
   npx wrangler d1 migrations apply mailstash --remote
   ```

2. **Create storage credentials** so the app can upload email files:
   - In the Cloudflare dashboard, go to **R2 > Manage R2 API Tokens**
   - Create a token with **Object Read & Write** on the `mailstash` bucket
   - Add the credentials as secrets:
     ```sh
     npx wrangler secret put R2_ACCESS_KEY_ID
     npx wrangler secret put R2_SECRET_ACCESS_KEY
     npx wrangler secret put R2_ACCOUNT_ID
     ```

3. **Restrict access** so only you can use the app:
   - Go to [Zero Trust > Access > Applications](https://one.dash.cloudflare.com/access/apps)
   - Add a Self-hosted Application for your mailstash domain
   - Choose how you want to log in (email code, Google, GitHub, etc.) and which email addresses are allowed
   - The app will guide you through this on first visit

Then open the app and import your first mbox file.

## Local development

```sh
pnpm install
pnpm dev          # Frontend dev server
pnpm dev:worker   # API dev server
pnpm test         # Run tests
pnpm typecheck    # Type-check
```
