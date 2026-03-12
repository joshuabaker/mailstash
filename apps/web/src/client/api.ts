export interface AppStatus {
  access: boolean;
  accounts: number;
}

export async function fetchStatus(): Promise<AppStatus> {
  try {
    const res = await fetch("/api/status");
    return await res.json();
  } catch {
    return { access: true, accounts: 0 };
  }
}

export interface Account {
  id: string;
  name: string;
  email: string;
}

export async function fetchAccounts(): Promise<Account[]> {
  const res = await fetch("/api/accounts");
  return res.json();
}

export async function createAccount(
  id: string,
  name: string,
  email: string,
): Promise<void> {
  await fetch("/api/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name, email }),
  });
}

// ── three-phase ingest API ────────────────────────────────────────────────

export interface PresignedUrl {
  key: string;
  url: string;
}

export async function requestPresignedUrls(
  accountId: string,
  files: Array<{ key: string; contentType: string }>,
): Promise<{ urls: PresignedUrl[]; expiresAt: number }> {
  const res = await fetch(`/api/ingest/presign/${accountId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) throw new Error(`Presign failed: ${res.status}`);
  return res.json();
}

export type { BatchIngestAttachment, BatchIngestItem } from "../shared/types.js";
import type { BatchIngestItem } from "../shared/types.js";

export async function ingestBatch(
  accountId: string,
  emails: BatchIngestItem[],
): Promise<{ ids: string[] }> {
  const res = await fetch(`/api/ingest/batch/${accountId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emails }),
  });
  if (!res.ok) throw new Error(`Batch ingest failed: ${res.status}`);
  return res.json();
}

// ── viewer types ─────────────────────────────────────────────────────────

export interface EmailSummary {
  id: string;
  account_id: string;
  thread_id: string;
  from_address: string;
  from_name: string;
  subject: string;
  date_unix: number;
  labels: string;
  has_attachments: number;
}

export interface SearchResult {
  emails: EmailSummary[];
  total: number;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  content_id: string;
  is_inline: number;
}

export interface EmailDetail extends EmailSummary {
  to_addresses: string;
  cc_addresses: string;
  body_text: string;
  body_html: string;
  r2_key: string;
  in_reply_to: string;
  attachments: AttachmentMeta[];
}

// ── viewer API ───────────────────────────────────────────────────────────

export async function searchEmails(
  params: Record<string, string>,
): Promise<SearchResult> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/search?${qs}`);
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  return res.json();
}

export async function fetchThread(
  threadId: string,
): Promise<{ emails: EmailDetail[] }> {
  const res = await fetch(
    `/api/threads/${encodeURIComponent(threadId)}`,
  );
  if (!res.ok) throw new Error(`Thread fetch failed: ${res.status}`);
  return res.json();
}
