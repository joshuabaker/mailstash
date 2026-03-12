export function normalizeMessageId(
  raw: string | undefined | null,
): string | null {
  if (!raw) return null;
  return raw.replace(/^<|>$/g, "").toLowerCase().trim() || null;
}

export async function generateMessageId(raw: string): Promise<string> {
  const snippet = new TextEncoder().encode(raw.slice(0, 2048));
  const hash = await crypto.subtle.digest("SHA-256", snippet);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function extractGmailLabels(raw: string): string[] {
  const match = raw.match(/^X-Gmail-Labels:\s*(.+(?:\r?\n[ \t]+.+)*)/m);
  if (!match) return [];
  const value = match[1].replace(/\r?\n[ \t]+/g, " ").trim();
  return value
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function computeThreadId(
  messageId: string,
  references: string | undefined | null,
  inReplyTo: string | undefined | null,
): string {
  if (references) {
    const refs = references.match(/<[^>]+>/g);
    if (refs && refs.length > 0) {
      return normalizeMessageId(refs[0]) || messageId;
    }
  }
  if (inReplyTo) {
    const normalized = normalizeMessageId(inReplyTo);
    if (normalized) return normalized;
  }
  return messageId;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 200);
}

export function emailR2Key(accountId: string, messageId: string): string {
  return `${accountId}/emails/${encodeURIComponent(messageId)}.eml`;
}

export function attachmentR2Key(
  accountId: string,
  messageId: string,
  sanitizedFilename: string,
): string {
  return `${accountId}/attachments/${encodeURIComponent(messageId)}/${sanitizedFilename}`;
}
