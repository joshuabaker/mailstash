import PostalMime from "postal-mime";
import type { EmailMetadata, AttachmentMeta, ProcessedEmail } from "./types.js";
import {
  normalizeMessageId,
  generateMessageId,
  extractGmailLabels,
  computeThreadId,
  sanitizeFilename,
  emailR2Key,
  attachmentR2Key,
} from "../shared/email-utils.js";

export async function processEmail(
  rawEmail: string,
  accountId: string,
): Promise<ProcessedEmail> {
  const labels = extractGmailLabels(rawEmail);

  const parser = new PostalMime();
  const parsed = await parser.parse(rawEmail);

  const messageId =
    normalizeMessageId(parsed.messageId) ||
    (await generateMessageId(rawEmail));

  const referencesHeader = parsed.headers?.find(
    (h) => h.key === "references",
  )?.value;
  const inReplyToRaw = parsed.inReplyTo;
  const inReplyTo = normalizeMessageId(inReplyToRaw) || "";
  const threadId = computeThreadId(messageId, referencesHeader, inReplyToRaw);

  const fromAddress = parsed.from?.address || "";
  const fromName = parsed.from?.name || "";

  const toAddresses = JSON.stringify(
    (parsed.to || []).map((a) => ({ address: a.address, name: a.name })),
  );
  const ccAddresses = JSON.stringify(
    (parsed.cc || []).map((a) => ({ address: a.address, name: a.name })),
  );

  const date = parsed.date ? new Date(parsed.date) : new Date(0);
  const dateUnix = Math.floor(date.getTime() / 1000);
  const dateIso = date.toISOString();

  const attachments: AttachmentMeta[] = [];
  const attachmentBuffers = new Map<string, Uint8Array>();

  for (const att of parsed.attachments || []) {
    const filename = att.filename || "unnamed";
    const sanitized = sanitizeFilename(filename);
    const attId = `${messageId}/${sanitized}`;
    const r2Key = attachmentR2Key(accountId, messageId, sanitized);
    const contentId = att.contentId
      ? normalizeMessageId(att.contentId) || ""
      : "";

    const content =
      typeof att.content === "string"
        ? new TextEncoder().encode(att.content)
        : new Uint8Array(att.content);

    attachments.push({
      id: attId,
      emailId: messageId,
      filename,
      contentType: att.mimeType || "application/octet-stream",
      sizeBytes: content.byteLength,
      contentId,
      isInline: att.disposition === "inline" ? 1 : 0,
      r2Key,
    });

    attachmentBuffers.set(r2Key, content);
  }

  const metadata: EmailMetadata = {
    id: messageId,
    accountId,
    threadId,
    fromAddress,
    fromName,
    toAddresses,
    ccAddresses,
    subject: parsed.subject || "",
    dateUnix,
    dateIso,
    labels: JSON.stringify(labels),
    hasAttachments: attachments.length > 0 ? 1 : 0,
    bodyText: parsed.text || "",
    bodyHtml: parsed.html || "",
    r2Key: emailR2Key(accountId, messageId),
    inReplyTo,
  };

  return { metadata, attachments, attachmentBuffers };
}
