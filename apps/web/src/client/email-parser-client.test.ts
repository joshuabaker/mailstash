import { describe, it, expect } from "vitest";
import { parseEmailForIDB } from "./email-parser-client";

const ACCOUNT = "test-account";

function makeEmail(headers: Record<string, string>, body = "Test body"): string {
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  lines.push("MIME-Version: 1.0");
  if (!headers["Content-Type"]) {
    lines.push("Content-Type: text/plain; charset=utf-8");
  }
  lines.push("", body);
  return lines.join("\r\n");
}

// ── parseEmailForIDB ───────────────────────────────────────────────

describe("parseEmailForIDB", () => {
  it("parses a simple plain-text email", async () => {
    const raw = makeEmail({
      From: "Alice <alice@example.com>",
      To: "bob@example.com",
      Subject: "Hello",
      "Message-ID": "<hello-001@example.com>",
      Date: "Mon, 15 Jan 2024 10:00:00 -0800",
      "X-Gmail-Labels": "Inbox,Starred",
    });

    const result = await parseEmailForIDB(raw, ACCOUNT);

    expect(result.id).toBe("hello-001@example.com");
    expect(result.state).toBe("parsed");
    expect(result.accountId).toBe(ACCOUNT);
    expect(result.metadata.fromAddress).toBe("alice@example.com");
    expect(result.metadata.fromName).toBe("Alice");
    expect(result.metadata.subject).toBe("Hello");
    expect(result.metadata.bodyText).toContain("Test body");
    expect(JSON.parse(result.metadata.labels)).toEqual(["Inbox", "Starred"]);
    expect(result.metadata.hasAttachments).toBe(0);
    expect(result.metadata.dateUnix).toBeGreaterThan(0);
    expect(result.metadata.dateIso).toMatch(/^\d{4}-/);
    expect(result.attachments).toHaveLength(0);
    expect(result.attachmentBlobs).toHaveLength(0);
  });

  it("computes threadId from References header", async () => {
    const raw = makeEmail({
      From: "alice@example.com",
      To: "bob@example.com",
      Subject: "Re: Thread",
      "Message-ID": "<msg-3@example.com>",
      References: "<root@example.com> <msg-2@example.com>",
      "In-Reply-To": "<msg-2@example.com>",
      Date: "Tue, 16 Jan 2024 08:00:00 -0800",
    });

    const result = await parseEmailForIDB(raw, ACCOUNT);

    expect(result.metadata.threadId).toBe("root@example.com");
    expect(result.metadata.inReplyTo).toBe("msg-2@example.com");
  });

  it("extracts attachments with correct r2Keys and blobs", async () => {
    const raw = [
      "From: bob@example.com",
      "To: alice@example.com",
      "Subject: File",
      "Message-ID: <att-001@example.com>",
      "Date: Wed, 17 Jan 2024 09:00:00 -0800",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "See attached.",
      "",
      "--b1",
      'Content-Type: application/pdf; name="doc.pdf"',
      'Content-Disposition: attachment; filename="doc.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjQKMSAwIG9iago=",
      "",
      "--b1--",
    ].join("\r\n");

    const result = await parseEmailForIDB(raw, ACCOUNT);

    expect(result.metadata.hasAttachments).toBe(1);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe("doc.pdf");
    expect(result.attachments[0].contentType).toBe("application/pdf");
    expect(result.attachments[0].r2Key).toBe(
      `${ACCOUNT}/attachments/att-001%40example.com/doc.pdf`,
    );
    expect(result.attachmentBlobs).toHaveLength(1);
    expect(result.attachmentBlobs[0].data.byteLength).toBeGreaterThan(0);
  });

  it("generates deterministic messageId when Message-ID header missing", async () => {
    const raw = makeEmail({
      From: "test@test.com",
      To: "other@test.com",
      Subject: "No ID",
      Date: "Mon, 15 Jan 2024 10:00:00 -0800",
    });

    const r1 = await parseEmailForIDB(raw, ACCOUNT);
    const r2 = await parseEmailForIDB(raw, ACCOUNT);

    expect(r1.id).toMatch(/^[0-9a-f]{64}$/);
    expect(r1.id).toBe(r2.id);
  });

  it("sets emlBytes from raw email string", async () => {
    const raw = makeEmail({
      From: "a@b.com",
      To: "c@d.com",
      Subject: "Bytes",
      "Message-ID": "<bytes@test.com>",
      Date: "Mon, 15 Jan 2024 10:00:00 -0800",
    });

    const result = await parseEmailForIDB(raw, ACCOUNT);

    expect(result.emlBytes.byteLength).toBe(new TextEncoder().encode(raw).byteLength);
  });
});
