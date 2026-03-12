import { useState, useEffect, useRef, useCallback } from "react";
import { navigate } from "../router";
import { fetchThread, type EmailDetail, type AttachmentMeta } from "../api";
import { formatBytes, parseJsonArray } from "../../shared/email-utils";

function formatDate(unix: number): string {
  return new Date(unix * 1000).toLocaleString("en", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function rewriteCidUrls(html: string, emailId: string): string {
  return html.replace(
    /(?:src|href)=(["'])cid:([^"']+)\1/gi,
    (match, quote, cid) =>
      `src=${quote}/api/files/cid/${encodeURIComponent(emailId)}/${encodeURIComponent(cid)}${quote}`,
  );
}

function EmailBodyFrame({ html, emailId }: { html: string; emailId: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const rewritten = rewriteCidUrls(html, emailId);
  const srcDoc = `<!DOCTYPE html>
<html><head><style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #e5e5e5; background: #111; margin: 0; padding: 12px;
    word-wrap: break-word; overflow-wrap: break-word; font-size: 14px; line-height: 1.5; }
  img { max-width: 100%; height: auto; }
  a { color: #8b8bff; }
  blockquote { border-left: 3px solid #333; margin: 0.5em 0; padding-left: 0.75em; color: #999; }
</style></head><body>${rewritten}</body></html>`;

  const resize = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentDocument?.body) return;
    iframe.style.height =
      iframe.contentDocument.body.scrollHeight + "px";
  }, []);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let observer: MutationObserver | null = null;
    const onLoad = () => {
      resize();
      // Watch for delayed image loads
      observer = new MutationObserver(resize);
      if (iframe.contentDocument?.body) {
        observer.observe(iframe.contentDocument.body, {
          childList: true,
          subtree: true,
          attributes: true,
        });
      }
    };
    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
  }, [resize]);

  return (
    <iframe
      ref={iframeRef}
      className="email-body-frame"
      sandbox="allow-same-origin"
      srcDoc={srcDoc}
    />
  );
}

function AttachmentList({ attachments }: { attachments: AttachmentMeta[] }) {
  const nonInline = attachments.filter((a) => !a.is_inline);
  if (nonInline.length === 0) return null;

  return (
    <div className="attachment-list">
      {nonInline.map((a) => (
        <a
          key={a.id}
          href={`/api/files/attachment/${encodeURIComponent(a.id)}`}
          className="attachment-chip"
          download={a.filename}
        >
          {a.filename}
          <span className="attachment-size">{formatBytes(a.size_bytes)}</span>
        </a>
      ))}
    </div>
  );
}

function EmailCard({
  email,
  defaultExpanded,
}: {
  email: EmailDetail;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const toList = parseJsonArray(email.to_addresses);
  const ccList = parseJsonArray(email.cc_addresses);

  if (!expanded) {
    const snippet = email.body_text
      ? email.body_text.slice(0, 120).replace(/\s+/g, " ")
      : "";

    return (
      <div
        className="thread-email collapsed"
        onClick={() => setExpanded(true)}
      >
        <div className="thread-email-summary">
          <span className="thread-email-from">
            {email.from_name || email.from_address}
          </span>
          <span className="thread-email-snippet">{snippet}</span>
          <span className="thread-email-date">
            {formatDate(email.date_unix)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="thread-email expanded">
      <div
        className="email-header"
        onClick={() => setExpanded(false)}
      >
        <div className="email-header-row">
          <span className="email-header-label">From</span>
          <span>
            {email.from_name} &lt;{email.from_address}&gt;
          </span>
        </div>
        {toList.length > 0 && (
          <div className="email-header-row">
            <span className="email-header-label">To</span>
            <span>{toList.join(", ")}</span>
          </div>
        )}
        {ccList.length > 0 && (
          <div className="email-header-row">
            <span className="email-header-label">Cc</span>
            <span>{ccList.join(", ")}</span>
          </div>
        )}
        <div className="email-header-row">
          <span className="email-header-label">Date</span>
          <span>{formatDate(email.date_unix)}</span>
        </div>
      </div>

      {email.body_html ? (
        <EmailBodyFrame html={email.body_html} emailId={email.id} />
      ) : (
        <pre className="email-body-text">{email.body_text}</pre>
      )}

      <AttachmentList attachments={email.attachments || []} />
    </div>
  );
}

export function Thread({ threadId }: { threadId: string }) {
  const [emails, setEmails] = useState<EmailDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    fetchThread(threadId)
      .then((data) => setEmails(data.emails))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [threadId]);

  if (loading) return <p className="muted text-sm">Loading thread…</p>;
  if (error) return <p className="error">{error}</p>;
  if (emails.length === 0) return <p className="muted text-sm">Thread not found.</p>;

  const subject = emails[0].subject || "(no subject)";

  return (
    <>
      <a
        href="/"
        className="back-link"
        onClick={(e) => {
          e.preventDefault();
          navigate("/");
        }}
      >
        &larr; Back to mailbox
      </a>
      <h2 className="thread-subject">{subject}</h2>
      <div className="thread-emails">
        {emails.map((e, i) => (
          <EmailCard
            key={e.id}
            email={e}
            defaultExpanded={i === emails.length - 1}
          />
        ))}
      </div>
    </>
  );
}
