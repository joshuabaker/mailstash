import { describe, it, expect } from "vitest";
import { processEmail } from "./email-parser";
import {
  normalizeMessageId,
  extractGmailLabels,
  computeThreadId,
  sanitizeFilename,
  generateMessageId,
  emailR2Key,
  attachmentR2Key,
} from "../shared/email-utils";

// ── normalizeMessageId ───────────────────────────────────────────────

describe("normalizeMessageId", () => {
  it("strips angle brackets", () => {
    expect(normalizeMessageId("<foo@bar.com>")).toBe("foo@bar.com");
  });

  it("lowercases", () => {
    expect(normalizeMessageId("FOO@BAR.COM")).toBe("foo@bar.com");
  });

  it("strips brackets and lowercases together", () => {
    expect(normalizeMessageId("<ABC@DEF.COM>")).toBe("abc@def.com");
  });

  it("returns null for empty string", () => {
    expect(normalizeMessageId("")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(normalizeMessageId(undefined)).toBeNull();
  });

  it("returns null for null", () => {
    expect(normalizeMessageId(null)).toBeNull();
  });
});

// ── extractGmailLabels ──────────────────────────────────────────────

describe("extractGmailLabels", () => {
  it("parses comma-separated labels", () => {
    const raw = "X-Gmail-Labels: Inbox,Important,Friends\n\nBody";
    expect(extractGmailLabels(raw)).toEqual(["Inbox", "Important", "Friends"]);
  });

  it("handles folded headers (continuation lines)", () => {
    const raw =
      "X-Gmail-Labels: Inbox,Important,\n  Friends,Work\n\nBody text";
    expect(extractGmailLabels(raw)).toEqual([
      "Inbox",
      "Important",
      "Friends",
      "Work",
    ]);
  });

  it("returns empty array when header missing", () => {
    expect(extractGmailLabels("From: test@test.com\n\nBody")).toEqual([]);
  });

  it("handles single label", () => {
    expect(extractGmailLabels("X-Gmail-Labels: Sent\n\nBody")).toEqual([
      "Sent",
    ]);
  });
});

// ── computeThreadId ─────────────────────────────────────────────────

describe("computeThreadId", () => {
  it("uses first Message-ID from References", () => {
    const result = computeThreadId(
      "msg3@example.com",
      "<root@example.com> <msg2@example.com>",
      "<msg2@example.com>",
    );
    expect(result).toBe("root@example.com");
  });

  it("falls back to In-Reply-To when no References", () => {
    const result = computeThreadId(
      "msg2@example.com",
      undefined,
      "<parent@example.com>",
    );
    expect(result).toBe("parent@example.com");
  });

  it("returns own messageId for standalone messages", () => {
    const result = computeThreadId("standalone@example.com", undefined, undefined);
    expect(result).toBe("standalone@example.com");
  });

  it("returns own messageId when References has no angle-bracketed IDs", () => {
    const result = computeThreadId("own@example.com", "malformed-ref", null);
    expect(result).toBe("own@example.com");
  });
});

// ── sanitizeFilename ────────────────────────────────────────────────

describe("sanitizeFilename", () => {
  it("replaces special chars with underscores", () => {
    expect(sanitizeFilename("hello world!@#.pdf")).toBe("hello_world___.pdf");
  });

  it("preserves valid chars", () => {
    expect(sanitizeFilename("report-2024_final.pdf")).toBe(
      "report-2024_final.pdf",
    );
  });

  it("truncates to 200 chars", () => {
    const long = "a".repeat(300) + ".txt";
    expect(sanitizeFilename(long).length).toBe(200);
  });
});

// ── generateMessageId ───────────────────────────────────────────────

describe("generateMessageId", () => {
  it("produces a hex SHA-256 string", async () => {
    const id = await generateMessageId("test email content");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic (same input → same output)", async () => {
    const a = await generateMessageId("identical content");
    const b = await generateMessageId("identical content");
    expect(a).toBe(b);
  });

  it("produces different output for different input", async () => {
    const a = await generateMessageId("content A");
    const b = await generateMessageId("content B");
    expect(a).not.toBe(b);
  });

  it("only uses first 2KB of input", async () => {
    const base = "x".repeat(2048);
    const a = await generateMessageId(base + "AAAA");
    const b = await generateMessageId(base + "BBBB");
    expect(a).toBe(b);
  });
});

// ── emailR2Key ─────────────────────────────────────────────────────

describe("emailR2Key", () => {
  it("generates correct key with encoded message-id", () => {
    expect(emailR2Key("acct1", "msg@example.com")).toBe(
      "acct1/emails/msg%40example.com.eml",
    );
  });

  it("handles special characters", () => {
    expect(emailR2Key("acct1", "a+b/c@d.com")).toBe(
      "acct1/emails/a%2Bb%2Fc%40d.com.eml",
    );
  });
});

// ── attachmentR2Key ────────────────────────────────────────────────

describe("attachmentR2Key", () => {
  it("generates correct key with encoded message-id and filename", () => {
    expect(attachmentR2Key("acct1", "msg@example.com", "photo.png")).toBe(
      "acct1/attachments/msg%40example.com/photo.png",
    );
  });
});

// ── processEmail ────────────────────────────────────────────────────

describe("processEmail", () => {
  const ACCOUNT = "test-account";

  it("parses a plain text email", async () => {
    const raw = [
      "From: Alice Johnson <alice@example.com>",
      "To: josh@example.com",
      "Subject: Weekend hiking plans",
      "Message-ID: <hike-001@example.com>",
      "Date: Mon, 15 Jan 2024 10:00:00 -0800",
      "X-Gmail-Labels: Inbox,Important,Friends",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hey Josh, want to hike?",
    ].join("\r\n");

    const result = await processEmail(raw, ACCOUNT);
    const m = result.metadata;

    expect(m.id).toBe("hike-001@example.com");
    expect(m.fromAddress).toBe("alice@example.com");
    expect(m.fromName).toBe("Alice Johnson");
    expect(m.subject).toBe("Weekend hiking plans");
    expect(m.bodyText).toContain("hike");
    expect(m.hasAttachments).toBe(0);
    expect(m.accountId).toBe(ACCOUNT);
    expect(m.r2Key).toBe(`${ACCOUNT}/emails/hike-001%40example.com.eml`);
    expect(result.attachments).toHaveLength(0);
  });

  it("extracts Gmail labels", async () => {
    const raw = [
      "From: test@test.com",
      "To: josh@test.com",
      "Subject: Labels test",
      "Message-ID: <labels-test@test.com>",
      "Date: Mon, 15 Jan 2024 10:00:00 -0800",
      "X-Gmail-Labels: Inbox,Newsletters,Starred",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Body",
    ].join("\r\n");

    const result = await processEmail(raw, ACCOUNT);
    expect(JSON.parse(result.metadata.labels)).toEqual([
      "Inbox",
      "Newsletters",
      "Starred",
    ]);
  });

  it("computes threadId from References", async () => {
    const raw = [
      "From: josh@example.com",
      "To: alice@example.com",
      "Subject: Re: Weekend hiking plans",
      "Message-ID: <hike-003@example.com>",
      "In-Reply-To: <hike-002@example.com>",
      "References: <hike-001@example.com> <hike-002@example.com>",
      "Date: Tue, 16 Jan 2024 08:15:00 -0800",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Reply body",
    ].join("\r\n");

    const result = await processEmail(raw, ACCOUNT);
    expect(result.metadata.threadId).toBe("hike-001@example.com");
    expect(result.metadata.inReplyTo).toBe("hike-002@example.com");
  });

  it("falls back threadId to In-Reply-To", async () => {
    const raw = [
      "From: josh@example.com",
      "To: alice@example.com",
      "Subject: Re: Test",
      "Message-ID: <reply@example.com>",
      "In-Reply-To: <parent@example.com>",
      "Date: Tue, 16 Jan 2024 08:15:00 -0800",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Reply",
    ].join("\r\n");

    const result = await processEmail(raw, ACCOUNT);
    expect(result.metadata.threadId).toBe("parent@example.com");
  });

  it("parses multipart email with attachments", async () => {
    const raw = [
      "From: Bob <bob@example.com>",
      "To: josh@example.com",
      "Subject: Photos",
      "Message-ID: <photos@example.com>",
      "Date: Thu, 18 Jan 2024 11:00:00 -0800",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="boundary-001"',
      "",
      "--boundary-001",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Here are the photos.",
      "",
      "--boundary-001",
      'Content-Type: image/png; name="photo.png"',
      'Content-Disposition: attachment; filename="photo.png"',
      "Content-Transfer-Encoding: base64",
      "",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "",
      "--boundary-001--",
    ].join("\r\n");

    const result = await processEmail(raw, ACCOUNT);
    expect(result.metadata.hasAttachments).toBe(1);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe("photo.png");
    expect(result.attachments[0].contentType).toBe("image/png");
    expect(result.attachments[0].isInline).toBe(0);
    expect(result.attachmentBuffers.size).toBe(1);
  });

  it("parses inline cid attachment", async () => {
    const raw = [
      "From: Mike <mike@example.com>",
      "To: josh@example.com",
      "Subject: Bug report",
      "Message-ID: <bug@example.com>",
      "Date: Wed, 07 Feb 2024 11:00:00 -0800",
      "MIME-Version: 1.0",
      'Content-Type: multipart/related; boundary="rel-001"',
      "",
      "--rel-001",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<html><body><img src="cid:screenshot-001"></body></html>',
      "",
      "--rel-001",
      'Content-Type: image/png; name="screenshot.png"',
      'Content-Disposition: inline; filename="screenshot.png"',
      "Content-ID: <screenshot-001>",
      "Content-Transfer-Encoding: base64",
      "",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "",
      "--rel-001--",
    ].join("\r\n");

    const result = await processEmail(raw, ACCOUNT);
    expect(result.attachments).toHaveLength(1);
    const att = result.attachments[0];
    expect(att.isInline).toBe(1);
    expect(att.contentId).toBe("screenshot-001");
  });

  it("generates deterministic messageId when Message-ID header is missing", async () => {
    const raw = [
      "From: test@test.com",
      "To: josh@test.com",
      "Subject: No message id",
      "Date: Mon, 15 Jan 2024 10:00:00 -0800",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Body without message-id",
    ].join("\r\n");

    const result1 = await processEmail(raw, ACCOUNT);
    const result2 = await processEmail(raw, ACCOUNT);
    expect(result1.metadata.id).toMatch(/^[0-9a-f]{64}$/);
    expect(result1.metadata.id).toBe(result2.metadata.id);
  });
});
