import { useState, useEffect, useRef, useCallback } from "react";
import { navigate } from "../router";
import {
  fetchAccounts,
  searchEmails,
  type Account,
  type EmailSummary,
} from "../api";

function relativeDate(unix: number): string {
  const now = Date.now();
  const ms = now - unix * 1000;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days === 1) return "Yesterday";
  const d = new Date(unix * 1000);
  const thisYear = new Date().getFullYear();
  const month = d.toLocaleString("en", { month: "short" });
  if (d.getFullYear() === thisYear) return `${month} ${d.getDate()}`;
  return `${month} ${d.getFullYear()}`;
}

function parseLabels(raw: string): string[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function Mailbox() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [query, setQuery] = useState("");
  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    fetchAccounts().then((accs) => {
      setAccounts(accs);
      if (accs.length > 0) setAccountId(accs[0].id);
    });
  }, []);

  const doSearch = useCallback(
    async (q: string, acct: string, p: number, append: boolean) => {
      setLoading(true);
      try {
        const params: Record<string, string> = {
          page: String(p),
          limit: "50",
        };
        if (acct) params.account = acct;
        if (q.trim()) params.q = q.trim();
        const result = await searchEmails(params);
        setEmails((prev) => (append ? [...prev, ...result.emails] : result.emails));
        setTotal(result.total);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Search when account changes
  useEffect(() => {
    if (!accountId) return;
    setPage(1);
    doSearch(query, accountId, 1, false);
  }, [accountId]);

  // Debounced search on query change
  useEffect(() => {
    if (!accountId) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      doSearch(query, accountId, 1, false);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  const loadMore = () => {
    const next = page + 1;
    setPage(next);
    doSearch(query, accountId, next, true);
  };

  return (
    <>
      <div className="mailbox-toolbar">
        {accounts.length > 1 && (
          <select
            className="account-select"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.email})
              </option>
            ))}
          </select>
        )}
        <input
          className="search-bar"
          type="text"
          placeholder="Search emails…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading && emails.length === 0 && (
        <p className="muted text-sm mt-2">Loading…</p>
      )}

      {!loading && emails.length === 0 && accountId && (
        <p className="muted text-sm mt-2">No emails found.</p>
      )}

      <div className="email-list mt-1">
        {emails.map((e) => (
          <div
            key={e.id}
            className="email-row"
            onClick={() => navigate(`/mail/${encodeURIComponent(e.thread_id)}`)}
          >
            <span className="email-row-from">
              {e.from_name || e.from_address}
            </span>
            <span className="email-row-subject">
              {e.subject || "(no subject)"}
              {e.has_attachments ? (
                <span className="attachment-icon" title="Has attachments">
                  &#128206;
                </span>
              ) : null}
            </span>
            <span className="email-row-meta">
              {parseLabels(e.labels).map((l) => (
                <span key={l} className="label-tag">
                  {l}
                </span>
              ))}
              <span className="email-row-date">{relativeDate(e.date_unix)}</span>
            </span>
          </div>
        ))}
      </div>

      {emails.length < total && (
        <button
          className="btn load-more mt-2"
          onClick={loadMore}
          disabled={loading}
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </>
  );
}
