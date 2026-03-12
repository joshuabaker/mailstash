import { Hono } from "hono";
import { AwsClient } from "aws4fetch";
import type { Bindings, BatchIngestItem, AttachmentMeta, EmailMetadata } from "./types.js";

const EMAIL_INSERT_SQL = `INSERT OR IGNORE INTO emails
  (id, account_id, thread_id, from_address, from_name, to_addresses,
   cc_addresses, subject, date_unix, date_iso, labels, has_attachments,
   body_text, body_html, r2_key, in_reply_to)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const ATTACHMENT_INSERT_SQL = `INSERT OR IGNORE INTO attachments
  (id, email_id, filename, content_type, size_bytes, content_id, is_inline, r2_key)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

function bindEmailInsert(db: D1Database, m: EmailMetadata) {
  return db.prepare(EMAIL_INSERT_SQL).bind(
    m.id, m.accountId, m.threadId, m.fromAddress, m.fromName,
    m.toAddresses, m.ccAddresses, m.subject, m.dateUnix, m.dateIso,
    m.labels, m.hasAttachments, m.bodyText, m.bodyHtml, m.r2Key, m.inReplyTo,
  );
}

function bindAttachmentInsert(db: D1Database, emailId: string, att: AttachmentMeta) {
  return db.prepare(ATTACHMENT_INSERT_SQL).bind(
    att.id, emailId, att.filename, att.contentType,
    att.sizeBytes, att.contentId, att.isInline, att.r2Key,
  );
}

const app = new Hono<{ Bindings: Bindings }>();

// ── status + access gate ────────────────────────────────────────────────

/**
 * Single status endpoint — the frontend uses this to decide what to show:
 *   1. access: false  → show Access setup guide
 *   2. access: true, accounts: 0  → show onboarding
 *   3. access: true, accounts: >0 → full app
 */
function isDevMode(c: { env: { DEV_MODE?: string } }): boolean {
  return c.env.DEV_MODE === "true";
}

app.get("/api/status", async (c) => {
  const hasAccess = isDevMode(c) || !!c.req.header("CF-Access-JWT-Assertion");

  if (!hasAccess) {
    return c.json({ access: false, accounts: 0 });
  }

  const { results } = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM accounts",
  ).all();
  const count = (results[0]?.count as number) ?? 0;

  return c.json({ access: true, accounts: count });
});

/**
 * Block all other API routes if Access is not active.
 * Skipped when DEV_MODE is explicitly set to "true".
 */
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/status") return next();
  if (isDevMode(c)) return next();

  const jwt = c.req.header("CF-Access-JWT-Assertion");
  if (!jwt) {
    return c.json(
      { error: "Cloudflare Access is not configured." },
      403,
    );
  }

  return next();
});

// ── accounts ────────────────────────────────────────────────────────────

app.get("/api/accounts", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM accounts ORDER BY name",
  ).all();
  return c.json(results);
});

app.post("/api/accounts", async (c) => {
  const { id, name, email } = await c.req.json();
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO accounts (id, name, email) VALUES (?, ?, ?)",
  )
    .bind(id, name, email)
    .run();
  return c.json({ ok: true });
});

// ── ingest ──────────────────────────────────────────────────────────────

// ── presigned URLs for R2 direct upload ──────────────────────────────

app.post("/api/ingest/presign/:accountId", async (c) => {
  const { files } = await c.req.json<{
    files: Array<{ key: string; contentType: string }>;
  }>();

  if (!files || files.length === 0 || files.length > 100) {
    return c.json({ error: "files must contain 1-100 items" }, 400);
  }

  const aws = new AwsClient({
    accessKeyId: c.env.R2_ACCESS_KEY_ID,
    secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
  });

  const EXPIRY_SECONDS = 4 * 60 * 60; // 4 hours
  const expiresAt = Date.now() + EXPIRY_SECONDS * 1000;
  const bucket = "mailstash";
  const endpoint = `https://${c.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

  const urls = await Promise.all(
    files.map(async (f) => {
      const url = new URL(`${endpoint}/${bucket}/${f.key}`);
      url.searchParams.set("X-Amz-Expires", String(EXPIRY_SECONDS));
      const signed = await aws.sign(
        new Request(url.toString(), {
          method: "PUT",
          headers: { "Content-Type": f.contentType },
        }),
        { aws: { signQuery: true } },
      );
      return { key: f.key, url: signed.url };
    }),
  );

  return c.json({ urls, expiresAt });
});

// ── batch metadata ingest ────────────────────────────────────────────

app.post("/api/ingest/batch/:accountId", async (c) => {
  const accountId = c.req.param("accountId");
  const { emails } = await c.req.json<{ emails: BatchIngestItem[] }>();

  if (!emails || emails.length === 0 || emails.length > 100) {
    return c.json({ error: "emails must contain 1-100 items" }, 400);
  }

  const stmts: D1PreparedStatement[] = [];

  for (const m of emails) {
    const meta = { ...m, accountId } as unknown as EmailMetadata;
    stmts.push(bindEmailInsert(c.env.DB, meta));

    for (const att of m.attachments) {
      const attMeta = { ...att, emailId: m.id } as unknown as AttachmentMeta;
      stmts.push(bindAttachmentInsert(c.env.DB, m.id, attMeta));
    }
  }

  // D1 batch() supports up to 100 statements per call
  const BATCH_SIZE = 100;
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    await c.env.DB.batch(stmts.slice(i, i + BATCH_SIZE));
  }

  return c.json({ ids: emails.map((e) => e.id) });
});

// ── search ──────────────────────────────────────────────────────────────

app.get("/api/search", async (c) => {
  const q = c.req.query("q") || "";
  const account = c.req.query("account") || "";
  const from = c.req.query("from") || "";
  const to = c.req.query("to") || "";
  const after = c.req.query("after") || "";
  const before = c.req.query("before") || "";
  const hasAttachment = c.req.query("has_attachment") || "";
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "50", 10);
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const binds: (string | number)[] = [];

  let fromClause = "emails";
  if (q) {
    fromClause =
      "emails_fts INNER JOIN emails ON emails_fts.rowid = emails.rowid";
    conditions.push("emails_fts MATCH ?");
    binds.push(q);
  }

  if (account) {
    conditions.push("emails.account_id = ?");
    binds.push(account);
  }
  if (from) {
    conditions.push("emails.from_address LIKE ?");
    binds.push(`%${from}%`);
  }
  if (to) {
    conditions.push("emails.to_addresses LIKE ?");
    binds.push(`%${to}%`);
  }
  if (after) {
    conditions.push("emails.date_unix >= ?");
    binds.push(Math.floor(new Date(after).getTime() / 1000));
  }
  if (before) {
    conditions.push("emails.date_unix <= ?");
    binds.push(Math.floor(new Date(before).getTime() / 1000));
  }
  if (hasAttachment === "1") {
    conditions.push("emails.has_attachments = 1");
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countSql = `SELECT COUNT(*) as total FROM ${fromClause} ${where}`;
  const countResult = await c.env.DB.prepare(countSql)
    .bind(...binds)
    .first<{ total: number }>();
  const total = countResult?.total ?? 0;

  const dataSql = `SELECT emails.id, emails.account_id, emails.thread_id, emails.from_address,
    emails.from_name, emails.subject, emails.date_unix, emails.labels, emails.has_attachments
    FROM ${fromClause} ${where}
    ORDER BY emails.date_unix DESC LIMIT ? OFFSET ?`;

  const { results } = await c.env.DB.prepare(dataSql)
    .bind(...binds, limit, offset)
    .all();

  return c.json({ emails: results, total });
});

// ── email detail ────────────────────────────────────────────────────────

app.get("/api/emails/:id", async (c) => {
  const id = c.req.param("id");

  const email = await c.env.DB.prepare("SELECT * FROM emails WHERE id = ?")
    .bind(id)
    .first();

  if (!email) return c.json({ error: "Not found" }, 404);

  const { results: attachments } = await c.env.DB.prepare(
    "SELECT * FROM attachments WHERE email_id = ?",
  )
    .bind(id)
    .all();

  return c.json({ email, attachments });
});

// ── thread view ─────────────────────────────────────────────────────────

app.get("/api/threads/:threadId", async (c) => {
  const threadId = c.req.param("threadId");

  const { results: emails } = await c.env.DB.prepare(
    "SELECT * FROM emails WHERE thread_id = ? ORDER BY date_unix ASC",
  )
    .bind(threadId)
    .all();

  if (emails.length === 0) return c.json({ error: "Not found" }, 404);

  const emailIds = emails.map((e) => e.id as string);
  const placeholders = emailIds.map(() => "?").join(",");
  const { results: attachments } = await c.env.DB.prepare(
    `SELECT * FROM attachments WHERE email_id IN (${placeholders})`,
  )
    .bind(...emailIds)
    .all();

  const attachmentsByEmail = new Map<string, typeof attachments>();
  for (const att of attachments) {
    const eid = att.email_id as string;
    if (!attachmentsByEmail.has(eid)) attachmentsByEmail.set(eid, []);
    attachmentsByEmail.get(eid)!.push(att);
  }

  const emailsWithAttachments = emails.map((e) => ({
    ...e,
    attachments: attachmentsByEmail.get(e.id as string) || [],
  }));

  return c.json({ emails: emailsWithAttachments });
});

// ── file serving ────────────────────────────────────────────────────────

app.get("/api/files/attachment/:id", async (c) => {
  const id = c.req.param("id");

  const att = await c.env.DB.prepare(
    "SELECT r2_key, content_type, filename FROM attachments WHERE id = ?",
  )
    .bind(id)
    .first<{ r2_key: string; content_type: string; filename: string }>();

  if (!att) return c.json({ error: "Not found" }, 404);

  const obj = await c.env.BUCKET.get(att.r2_key);
  if (!obj) return c.json({ error: "File not found in storage" }, 404);

  return new Response(obj.body, {
    headers: {
      "Content-Type": att.content_type || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${att.filename}"`,
    },
  });
});

app.get("/api/files/cid/:emailId/:contentId", async (c) => {
  const emailId = c.req.param("emailId");
  const contentId = c.req.param("contentId");

  const att = await c.env.DB.prepare(
    "SELECT r2_key, content_type FROM attachments WHERE email_id = ? AND content_id = ?",
  )
    .bind(emailId, contentId)
    .first<{ r2_key: string; content_type: string }>();

  if (!att) return c.json({ error: "Not found" }, 404);

  const obj = await c.env.BUCKET.get(att.r2_key);
  if (!obj) return c.json({ error: "File not found in storage" }, 404);

  return new Response(obj.body, {
    headers: {
      "Content-Type": att.content_type || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

// ── health ──────────────────────────────────────────────────────────────

app.get("/api/health", (c) => c.json({ status: "ok" }));

export default app;
