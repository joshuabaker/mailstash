import { describe, it, expect, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";

const MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT)`,
  `CREATE TABLE IF NOT EXISTS emails (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), thread_id TEXT, from_address TEXT, from_name TEXT, to_addresses TEXT, cc_addresses TEXT, subject TEXT, date_unix INTEGER, date_iso TEXT, labels TEXT, has_attachments INTEGER DEFAULT 0, body_text TEXT, body_html TEXT, r2_key TEXT, in_reply_to TEXT)`,
  `CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, email_id TEXT NOT NULL REFERENCES emails(id), filename TEXT, content_type TEXT, size_bytes INTEGER, content_id TEXT, is_inline INTEGER DEFAULT 0, r2_key TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_emails_account_id ON emails(account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_emails_thread_id ON emails(thread_id)`,
  `CREATE INDEX IF NOT EXISTS idx_emails_date_unix ON emails(date_unix)`,
  `CREATE INDEX IF NOT EXISTS idx_emails_from_address ON emails(from_address)`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id)`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_content_id ON attachments(content_id)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(subject, from_name, from_address, to_addresses, body_text, content='emails', content_rowid='rowid')`,
  `CREATE TRIGGER IF NOT EXISTS emails_fts_insert AFTER INSERT ON emails BEGIN INSERT INTO emails_fts(rowid, subject, from_name, from_address, to_addresses, body_text) VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.to_addresses, new.body_text); END`,
  `CREATE TRIGGER IF NOT EXISTS emails_fts_delete AFTER DELETE ON emails BEGIN INSERT INTO emails_fts(emails_fts, rowid, subject, from_name, from_address, to_addresses, body_text) VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.to_addresses, old.body_text); END`,
];

const ACCOUNT_ID = "acct-1";

async function seedData() {
  // Account
  await env.DB.prepare(
    "INSERT INTO accounts (id, name, email) VALUES (?, ?, ?)",
  )
    .bind(ACCOUNT_ID, "Test User", "test@example.com")
    .run();

  // Emails
  const emails = [
    {
      id: "msg-001@example.com",
      thread_id: "msg-001@example.com",
      from_address: "alice@example.com",
      from_name: "Alice",
      to_addresses: '[{"address":"josh@example.com","name":"Josh"}]',
      cc_addresses: "[]",
      subject: "Hello World",
      date_unix: 1705334400, // 2024-01-15 18:00 UTC
      date_iso: "2024-01-15T18:00:00.000Z",
      labels: '["Inbox"]',
      has_attachments: 0,
      body_text: "This is a test email about hiking plans.",
      body_html: "<p>This is a test email about hiking plans.</p>",
      r2_key: `${ACCOUNT_ID}/emails/msg-001%40example.com.eml`,
      in_reply_to: "",
    },
    {
      id: "msg-002@example.com",
      thread_id: "msg-001@example.com",
      from_address: "josh@example.com",
      from_name: "Josh",
      to_addresses: '[{"address":"alice@example.com","name":"Alice"}]',
      cc_addresses: "[]",
      subject: "Re: Hello World",
      date_unix: 1705420800, // 2024-01-16 18:00 UTC
      date_iso: "2024-01-16T18:00:00.000Z",
      labels: '["Sent"]',
      has_attachments: 1,
      body_text: "Reply to the test email.",
      body_html: "<p>Reply to the test email.</p>",
      r2_key: `${ACCOUNT_ID}/emails/msg-002%40example.com.eml`,
      in_reply_to: "msg-001@example.com",
    },
    {
      id: "msg-003@example.com",
      thread_id: "msg-003@example.com",
      from_address: "bob@example.com",
      from_name: "Bob",
      to_addresses: '[{"address":"josh@example.com","name":"Josh"}]',
      cc_addresses: "[]",
      subject: "Standalone message",
      date_unix: 1705507200, // 2024-01-17 18:00 UTC
      date_iso: "2024-01-17T18:00:00.000Z",
      labels: '["Inbox","Work"]',
      has_attachments: 0,
      body_text: "A standalone email from Bob.",
      body_html: "<p>A standalone email from Bob.</p>",
      r2_key: `${ACCOUNT_ID}/emails/msg-003%40example.com.eml`,
      in_reply_to: "",
    },
  ];

  for (const e of emails) {
    await env.DB.prepare(
      `INSERT INTO emails (id, account_id, thread_id, from_address, from_name,
       to_addresses, cc_addresses, subject, date_unix, date_iso, labels,
       has_attachments, body_text, body_html, r2_key, in_reply_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        e.id, ACCOUNT_ID, e.thread_id, e.from_address, e.from_name,
        e.to_addresses, e.cc_addresses, e.subject, e.date_unix, e.date_iso,
        e.labels, e.has_attachments, e.body_text, e.body_html, e.r2_key,
        e.in_reply_to,
      )
      .run();
  }

  // Attachment for msg-002
  const attR2Key = `${ACCOUNT_ID}/attachments/msg-002%40example.com/photo.png`;
  await env.DB.prepare(
    `INSERT INTO attachments (id, email_id, filename, content_type, size_bytes, content_id, is_inline, r2_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      "msg-002@example.com/photo.png",
      "msg-002@example.com",
      "photo.png",
      "image/png",
      1234,
      "",
      0,
      attR2Key,
    )
    .run();

  // Inline attachment for msg-002 (for cid test)
  const cidR2Key = `${ACCOUNT_ID}/attachments/msg-002%40example.com/inline-img.png`;
  await env.DB.prepare(
    `INSERT INTO attachments (id, email_id, filename, content_type, size_bytes, content_id, is_inline, r2_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      "msg-002@example.com/inline-img.png",
      "msg-002@example.com",
      "inline-img.png",
      "image/png",
      567,
      "inline-001",
      1,
      cidR2Key,
    )
    .run();

  // R2 blobs
  await env.BUCKET.put(attR2Key, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    httpMetadata: { contentType: "image/png" },
  });
  await env.BUCKET.put(cidR2Key, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    httpMetadata: { contentType: "image/png" },
  });
}

// ── Setup ────────────────────────────────────────────────────────────

beforeAll(async () => {
  for (const sql of MIGRATION_STATEMENTS) {
    await env.DB.prepare(sql).run();
  }
  await seedData();
});

// Helper to make authenticated requests
function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`https://mailstash.test${path}`, {
    ...init,
    headers: {
      "CF-Access-JWT-Assertion": "test-jwt-token",
      ...init?.headers,
    },
  });
}

function unauthFetch(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`https://mailstash.test${path}`, init);
}

// ── Status endpoint ──────────────────────────────────────────────────

describe("GET /api/status", () => {
  it("returns access: false without JWT header", async () => {
    const res = await unauthFetch("/api/status");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ access: false, accounts: 0 });
  });

  it("returns access: true with JWT header and account count", async () => {
    const res = await authedFetch("/api/status");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ access: true, accounts: 1 });
  });
});

// ── Access gate ──────────────────────────────────────────────────────

describe("Access gate middleware", () => {
  it("returns 403 without JWT header", async () => {
    const res = await unauthFetch("/api/accounts");
    expect(res.status).toBe(403);
  });

  it("returns 200 with JWT header", async () => {
    const res = await authedFetch("/api/accounts");
    expect(res.status).toBe(200);
  });
});

// ── Accounts ─────────────────────────────────────────────────────────

describe("GET /api/accounts", () => {
  it("returns seeded accounts", async () => {
    const res = await authedFetch("/api/accounts");
    const data: any[] = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(ACCOUNT_ID);
    expect(data[0].name).toBe("Test User");
    expect(data[0].email).toBe("test@example.com");
  });
});

// ── Search ───────────────────────────────────────────────────────────

describe("GET /api/search", () => {
  it("returns all emails when no filters", async () => {
    const res = await authedFetch("/api/search");
    const data = (await res.json()) as { emails: any[]; total: number };
    expect(data.total).toBe(3);
    expect(data.emails).toHaveLength(3);
  });

  it("filters by account", async () => {
    const res = await authedFetch(`/api/search?account=${ACCOUNT_ID}`);
    const data = (await res.json()) as { emails: any[]; total: number };
    expect(data.total).toBe(3);
  });

  it("filters by from address", async () => {
    const res = await authedFetch("/api/search?from=alice");
    const data = (await res.json()) as { emails: any[]; total: number };
    expect(data.total).toBe(1);
    expect(data.emails[0].from_address).toBe("alice@example.com");
  });

  it("filters by has_attachment", async () => {
    const res = await authedFetch("/api/search?has_attachment=1");
    const data = (await res.json()) as { emails: any[]; total: number };
    expect(data.total).toBe(1);
    expect(data.emails[0].id).toBe("msg-002@example.com");
  });

  it("filters by date range", async () => {
    const res = await authedFetch(
      "/api/search?after=2024-01-17&before=2024-01-18",
    );
    const data = (await res.json()) as { emails: any[]; total: number };
    expect(data.total).toBe(1);
    expect(data.emails[0].id).toBe("msg-003@example.com");
  });

  it("paginates results", async () => {
    const res = await authedFetch("/api/search?page=1&limit=2");
    const data = (await res.json()) as { emails: any[]; total: number };
    expect(data.total).toBe(3);
    expect(data.emails).toHaveLength(2);
  });

  it("does not include body fields in search results", async () => {
    const res = await authedFetch("/api/search");
    const data = (await res.json()) as { emails: any[]; total: number };
    const email = data.emails[0];
    expect(email).not.toHaveProperty("body_text");
    expect(email).not.toHaveProperty("body_html");
  });

  it("FTS matches on subject", async () => {
    const res = await authedFetch("/api/search?q=Standalone");
    const data = (await res.json()) as { emails: any[]; total: number };
    expect(data.total).toBe(1);
    expect(data.emails[0].id).toBe("msg-003@example.com");
  });
});

// ── Email detail ─────────────────────────────────────────────────────

describe("GET /api/emails/:id", () => {
  it("returns full email with body and attachments", async () => {
    const res = await authedFetch("/api/emails/msg-002@example.com");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { email: any; attachments: any[] };
    expect(data.email.id).toBe("msg-002@example.com");
    expect(data.email.body_html).toContain("Reply");
    expect(data.attachments).toHaveLength(2);
  });

  it("returns 404 for nonexistent id", async () => {
    const res = await authedFetch("/api/emails/nonexistent@example.com");
    expect(res.status).toBe(404);
  });
});

// ── Thread view ──────────────────────────────────────────────────────

describe("GET /api/threads/:threadId", () => {
  it("returns all emails in thread ordered by date ASC", async () => {
    const res = await authedFetch("/api/threads/msg-001@example.com");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { emails: any[] };
    expect(data.emails).toHaveLength(2);
    expect(data.emails[0].id).toBe("msg-001@example.com");
    expect(data.emails[1].id).toBe("msg-002@example.com");
    // Second email should have attachments
    expect(data.emails[1].attachments).toHaveLength(2);
  });

  it("returns 404 for nonexistent threadId", async () => {
    const res = await authedFetch("/api/threads/nonexistent@example.com");
    expect(res.status).toBe(404);
  });
});

// ── File serving ─────────────────────────────────────────────────────

describe("GET /api/files/attachment/:id", () => {
  it("streams blob from R2 with correct headers", async () => {
    const attId = encodeURIComponent("msg-002@example.com/photo.png");
    const res = await authedFetch(`/api/files/attachment/${attId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Disposition")).toContain("photo.png");
  });

  it("returns 404 for nonexistent attachment", async () => {
    const res = await authedFetch("/api/files/attachment/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/files/cid/:emailId/:contentId", () => {
  it("serves inline image from R2 with cache headers", async () => {
    const res = await authedFetch(
      "/api/files/cid/msg-002@example.com/inline-001",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });

  it("returns 404 for nonexistent cid", async () => {
    const res = await authedFetch(
      "/api/files/cid/msg-002@example.com/nonexistent",
    );
    expect(res.status).toBe(404);
  });
});

// ── Presign endpoint ──────────────────────────────────────────────

describe("POST /api/ingest/presign/:accountId", () => {
  it("returns presigned URLs for valid request", async () => {
    const res = await authedFetch(`/api/ingest/presign/${ACCOUNT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [
          { key: `${ACCOUNT_ID}/emails/test1.eml`, contentType: "message/rfc822" },
          { key: `${ACCOUNT_ID}/emails/test2.eml`, contentType: "message/rfc822" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      urls: Array<{ key: string; url: string }>;
      expiresAt: number;
    };
    expect(data.urls).toHaveLength(2);
    expect(data.urls[0].key).toBe(`${ACCOUNT_ID}/emails/test1.eml`);
    expect(data.urls[1].key).toBe(`${ACCOUNT_ID}/emails/test2.eml`);
    for (const entry of data.urls) {
      expect(entry.url).toContain("X-Amz-Signature");
    }
    expect(data.expiresAt).toBeGreaterThan(Date.now());
  });

  it("rejects empty files array", async () => {
    const res = await authedFetch(`/api/ingest/presign/${ACCOUNT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects >100 files", async () => {
    const files = Array.from({ length: 101 }, (_, i) => ({
      key: `${ACCOUNT_ID}/emails/file-${i}.eml`,
      contentType: "message/rfc822",
    }));
    const res = await authedFetch(`/api/ingest/presign/${ACCOUNT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    });
    expect(res.status).toBe(400);
  });

  it("requires auth", async () => {
    const res = await unauthFetch(`/api/ingest/presign/${ACCOUNT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ key: "test.eml", contentType: "message/rfc822" }],
      }),
    });
    expect(res.status).toBe(403);
  });
});

// ── Batch ingest endpoint ─────────────────────────────────────────

describe("POST /api/ingest/batch/:accountId", () => {
  const BATCH_ACCOUNT_ID = "acct-batch";

  beforeAll(async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO accounts (id, name, email) VALUES (?, ?, ?)",
    )
      .bind(BATCH_ACCOUNT_ID, "Batch User", "batch@example.com")
      .run();
  });

  function makeBatchItem(id: string, hasAttachments = false): any {
    const item: any = {
      id,
      threadId: id,
      fromAddress: "sender@example.com",
      fromName: "Sender",
      toAddresses: '[{"address":"recv@example.com","name":"Recv"}]',
      ccAddresses: "[]",
      subject: `Subject for ${id}`,
      dateUnix: 1705334400,
      dateIso: "2024-01-15T18:00:00.000Z",
      labels: '["Inbox"]',
      hasAttachments: hasAttachments ? 1 : 0,
      bodyText: `Body text for ${id}`,
      bodyHtml: `<p>Body for ${id}</p>`,
      r2Key: `${BATCH_ACCOUNT_ID}/emails/${encodeURIComponent(id)}.eml`,
      inReplyTo: "",
      attachments: [],
    };
    if (hasAttachments) {
      item.attachments = [
        {
          id: `${id}/doc.pdf`,
          filename: "doc.pdf",
          contentType: "application/pdf",
          sizeBytes: 5000,
          contentId: "",
          isInline: 0,
          r2Key: `${BATCH_ACCOUNT_ID}/attachments/${encodeURIComponent(id)}/doc.pdf`,
        },
      ];
    }
    return item;
  }

  it("inserts emails and attachments into D1", async () => {
    const emails = [
      makeBatchItem("batch-001@example.com"),
      makeBatchItem("batch-002@example.com", true),
    ];
    const res = await authedFetch(`/api/ingest/batch/${BATCH_ACCOUNT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ids: string[] };
    expect(data.ids).toEqual(["batch-001@example.com", "batch-002@example.com"]);

    // Verify D1
    const email1 = await env.DB.prepare("SELECT * FROM emails WHERE id = ?")
      .bind("batch-001@example.com")
      .first();
    expect(email1).not.toBeNull();
    expect(email1!.account_id).toBe(BATCH_ACCOUNT_ID);
    expect(email1!.subject).toBe("Subject for batch-001@example.com");

    const email2 = await env.DB.prepare("SELECT * FROM emails WHERE id = ?")
      .bind("batch-002@example.com")
      .first();
    expect(email2).not.toBeNull();
    expect(email2!.has_attachments).toBe(1);

    const att = await env.DB.prepare("SELECT * FROM attachments WHERE email_id = ?")
      .bind("batch-002@example.com")
      .first();
    expect(att).not.toBeNull();
    expect(att!.filename).toBe("doc.pdf");
  });

  it("handles duplicates gracefully", async () => {
    const emails = [makeBatchItem("batch-001@example.com")];
    const res = await authedFetch(`/api/ingest/batch/${BATCH_ACCOUNT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails }),
    });
    expect(res.status).toBe(200);

    // Still only one row
    const { results } = await env.DB.prepare(
      "SELECT * FROM emails WHERE id = ?",
    )
      .bind("batch-001@example.com")
      .all();
    expect(results).toHaveLength(1);
  });

  it("rejects empty emails array", async () => {
    const res = await authedFetch(`/api/ingest/batch/${BATCH_ACCOUNT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects >100 emails", async () => {
    const emails = Array.from({ length: 101 }, (_, i) =>
      makeBatchItem(`bulk-${i}@example.com`),
    );
    const res = await authedFetch(`/api/ingest/batch/${BATCH_ACCOUNT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails }),
    });
    expect(res.status).toBe(400);
  });

  it("requires auth", async () => {
    const res = await unauthFetch(`/api/ingest/batch/${BATCH_ACCOUNT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails: [makeBatchItem("unauth@example.com")] }),
    });
    expect(res.status).toBe(403);
  });
});
