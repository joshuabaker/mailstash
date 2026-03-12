import { useEffect, useState } from "react";
import { useRoute, navigate } from "./router";
import { fetchStatus, type AppStatus } from "./api";
import { Setup } from "./pages/Setup";
import { Import } from "./pages/Import";
import { Mailbox } from "./pages/Mailbox";
import { Thread } from "./pages/Thread";

export function App() {
  const path = useRoute();
  const [status, setStatus] = useState<AppStatus | null>(null);

  const refresh = () => fetchStatus().then(setStatus);

  useEffect(() => {
    refresh();
  }, []);

  if (!status) return null;

  // 1. Access not configured
  if (!status.access) return <Setup onRetry={refresh} />;

  const hasAccounts = status.accounts > 0;

  // 2. No accounts yet — show importer only, no app nav
  if (!hasAccounts) {
    return (
      <div className="shell">
        <header>
          <h1>mailstash</h1>
        </header>
        <main>
          <Import onAccountCreated={refresh} />
        </main>
      </div>
    );
  }

  // 3. Full app
  return (
    <div className="shell">
      <header>
        <h1>
          <a href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }} style={{ color: "inherit", textDecoration: "none" }}>
            mailstash
          </a>
        </h1>
        <nav>
          <a
            href="/importer"
            className={path === "/importer" ? "active" : ""}
            onClick={(e) => { e.preventDefault(); navigate("/importer"); }}
          >
            Import
          </a>
        </nav>
      </header>
      <main>
        <Route path={path} />
      </main>
    </div>
  );
}

function Route({ path }: { path: string }) {
  if (path === "/importer") return <Import />;

  const threadMatch = path.match(/^\/mail\/(.+)/);
  if (threadMatch) return <Thread threadId={decodeURIComponent(threadMatch[1])} />;

  return <Mailbox />;
}
