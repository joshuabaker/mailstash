export function Setup({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="shell">
      <header>
        <h1>mailstash</h1>
      </header>
      <main>
        <h2 className="page-title">Setup required</h2>

        <p className="muted text-sm" style={{ lineHeight: 1.6 }}>
          Cloudflare Access is not configured for this domain. You need to add
          an Access Application so only you can use this app.
        </p>

        <ol className="muted text-sm mt-2" style={{ lineHeight: 2, marginLeft: "1.25rem" }}>
          <li>Open the Zero Trust dashboard</li>
          <li>
            Go to <strong style={{ color: "#e5e5e5" }}>Access &gt; Applications &gt; Add</strong>
          </li>
          <li>Set the application domain to this URL</li>
          <li>Add a policy allowing your email address</li>
          <li>
            For identity, <strong style={{ color: "#e5e5e5" }}>One-time PIN</strong> works
            with zero config
          </li>
        </ol>

        <div className="mt-3 gap-sm">
          <a
            href="https://one.dash.cloudflare.com/access/apps"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary btn-block"
          >
            Open Zero Trust dashboard
          </a>
          <button className="btn btn-block" onClick={onRetry}>
            I've set it up — check again
          </button>
        </div>
      </main>
    </div>
  );
}
