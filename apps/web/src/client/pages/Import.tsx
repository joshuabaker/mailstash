import { useState, useEffect, useRef } from "react";
import {
  fetchAccounts,
  createAccount,
  requestPresignedUrls,
  ingestBatch,
  type Account,
  type PresignedUrl,
  type BatchIngestItem,
} from "../api";
import {
  putEmail,
  getByState,
  updateState,
  countByState,
  saveHandle,
  getHandle,
  clearHandle,
  clearCommitted,
  clearAll,
  hasIncompleteImport,
  type IDBEmail,
  type StateCounts,
} from "../idb";
import { parseEmailForIDB } from "../email-parser-client";
import { formatBytes } from "../../shared/email-utils";

type Phase = "account" | "file" | "phase1" | "phase2" | "phase3" | "done";

interface PhaseProgress {
  current: number;
  total: number;
  errors: number;
  startTime: number;
}

const UPLOAD_CONCURRENCY = 6;
const BATCH_SIZE = 50;
const PRESIGN_BATCH = 100;
const PRESIGN_REFRESH_MARGIN = 60 * 60 * 1000; // 1 hour in ms

export function Import({ onAccountCreated }: { onAccountCreated?: () => void } = {}) {
  const [phase, setPhase] = useState<Phase>("account");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileHandle, setFileHandle] = useState<FileSystemFileHandle | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [resumeAvailable, setResumeAvailable] = useState(false);
  const [resumeCounts, setResumeCounts] = useState<StateCounts | null>(null);
  const [progress, setProgress] = useState<PhaseProgress>({ current: 0, total: 0, errors: 0, startTime: 0 });
  const [bytesRead, setBytesRead] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const presignCache = useRef<Map<string, { url: string; expiresAt: number }>>(new Map());

  useEffect(() => {
    fetchAccounts().then(setAccounts);
    checkResume();
  }, []);

  async function checkResume() {
    const incomplete = await hasIncompleteImport();
    if (!incomplete) return;
    const saved = await getHandle();
    if (!saved) return;
    const counts = await countByState();
    setResumeAvailable(true);
    setResumeCounts(counts);
    setSelectedAccount(saved.accountId);
  }

  // ── account phase ─────────────────────────────────────────────────

  function selectAccount(id: string) {
    setSelectedAccount(id);
    setPhase("file");
  }

  async function handleCreateAccount(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const id = (form.get("id") as string).trim();
    const name = (form.get("name") as string).trim();
    const email = (form.get("email") as string).trim();
    if (!id || !name) return;

    await createAccount(id, name, email);
    onAccountCreated?.();
    const updated = await fetchAccounts();
    setAccounts(updated);
    setShowNewForm(false);
    selectAccount(id);
  }

  async function handleResume() {
    const saved = await getHandle();
    if (!saved) return;

    const permission = await saved.handle.requestPermission({ mode: "read" });
    if (permission !== "granted") return;

    setFileHandle(saved.handle);
    setSelectedAccount(saved.accountId);
    const f = await saved.handle.getFile();
    setFile(f);
    setBytesRead(saved.bytesRead);

    const counts = await countByState();
    if (counts.parsed > 0) {
      // There are parsed but not uploaded emails — go to phase 2
      startPhase2(saved.accountId, counts);
    } else if (counts.uploaded > 0) {
      // All uploaded but not committed — go to phase 3
      startPhase3(saved.accountId, counts);
    }
  }

  async function handleDiscardResume() {
    await clearAll();
    await clearHandle();
    setResumeAvailable(false);
    setResumeCounts(null);
  }

  // ── file phase ────────────────────────────────────────────────────

  async function pickFile() {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "Mbox files", accept: { "application/mbox": [".mbox"] } }],
      });
      setFileHandle(handle);
      setFile(await handle.getFile());
    } catch {
      // user cancelled
    }
  }

  // ── Phase 1: Stream mbox → IDB ───────────────────────────────────

  async function startPhase1() {
    if (!selectedAccount || !fileHandle) return;
    setPhase("phase1");

    const controller = new AbortController();
    abortRef.current = controller;

    // Clear any stale data from a different import
    await clearAll();
    presignCache.current.clear();

    const f = await fileHandle.getFile();
    const totalSize = f.size;
    const stream = f.stream();
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();

    const p: PhaseProgress = { current: 0, total: totalSize, errors: 0, startTime: Date.now() };
    setProgress({ ...p });

    let buffer = "";
    let currentEmail: string | null = null;
    let totalBytesRead = 0;
    let emailCount = 0;

    // Persist file handle for resume
    await saveHandle(fileHandle, selectedAccount, 0);

    while (true) {
      if (controller.signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += value;
      totalBytesRead += new TextEncoder().encode(value).byteLength;

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (controller.signal.aborted) break;
        if (line.startsWith("From ")) {
          if (currentEmail !== null && currentEmail.length > 0) {
            try {
              const parsed = await parseEmailForIDB(currentEmail, selectedAccount);
              await putEmail(parsed);
              emailCount++;
            } catch {
              p.errors++;
            }
          }
          currentEmail = "";
        } else if (currentEmail !== null) {
          currentEmail += line + "\n";
        }
      }

      p.current = totalBytesRead;
      setBytesRead(totalBytesRead);
      setProgress({ ...p });

      // Periodically save progress for resume
      if (emailCount % 100 === 0 && emailCount > 0) {
        await saveHandle(fileHandle, selectedAccount, totalBytesRead);
      }
    }

    // Flush last email
    if (buffer && currentEmail !== null) {
      currentEmail += buffer + "\n";
    }
    if (currentEmail && currentEmail.length > 0 && !controller.signal.aborted) {
      try {
        const parsed = await parseEmailForIDB(currentEmail, selectedAccount);
        await putEmail(parsed);
        emailCount++;
      } catch {
        p.errors++;
      }
    }

    await saveHandle(fileHandle, selectedAccount, totalBytesRead);
    setProgress({ ...p });

    if (!controller.signal.aborted) {
      const counts = await countByState();
      startPhase2(selectedAccount, counts);
    }
  }

  // ── Phase 2: Upload to R2 via presigned URLs ──────────────────────

  async function startPhase2(accountId: string, initialCounts?: StateCounts) {
    setPhase("phase2");
    const controller = abortRef.current || new AbortController();
    abortRef.current = controller;

    const counts = initialCounts || await countByState();
    const totalToUpload = counts.parsed;
    const p: PhaseProgress = { current: 0, total: totalToUpload, errors: 0, startTime: Date.now() };
    setProgress({ ...p });

    while (!controller.signal.aborted) {
      const batch = await getByState("parsed", BATCH_SIZE);
      if (batch.length === 0) break;

      // Collect all R2 keys needed for presigning
      const filesToSign: Array<{ key: string; contentType: string }> = [];
      for (const email of batch) {
        if (!presignCache.current.has(email.metadata.r2Key) ||
            presignCache.current.get(email.metadata.r2Key)!.expiresAt - Date.now() < PRESIGN_REFRESH_MARGIN) {
          filesToSign.push({ key: email.metadata.r2Key, contentType: "message/rfc822" });
        }
        for (const blob of email.attachmentBlobs) {
          if (!presignCache.current.has(blob.r2Key) ||
              presignCache.current.get(blob.r2Key)!.expiresAt - Date.now() < PRESIGN_REFRESH_MARGIN) {
            filesToSign.push({ key: blob.r2Key, contentType: blob.contentType });
          }
        }
      }

      // Request presigned URLs in chunks of 100
      for (let i = 0; i < filesToSign.length; i += PRESIGN_BATCH) {
        if (controller.signal.aborted) break;
        const chunk = filesToSign.slice(i, i + PRESIGN_BATCH);
        const { urls, expiresAt } = await requestPresignedUrls(accountId, chunk);
        for (const u of urls) {
          presignCache.current.set(u.key, { url: u.url, expiresAt });
        }
      }

      // Upload with concurrency control
      let inFlight = 0;
      let resolveSlot: (() => void) | null = null;

      async function waitForSlot() {
        while (inFlight >= UPLOAD_CONCURRENCY) {
          await new Promise<void>((r) => { resolveSlot = r; });
        }
      }

      function releaseSlot() {
        inFlight--;
        if (resolveSlot) { const r = resolveSlot; resolveSlot = null; r(); }
      }

      async function uploadFile(key: string, body: ArrayBuffer, contentType: string) {
        await waitForSlot();
        if (controller.signal.aborted) return;
        inFlight++;
        try {
          const cached = presignCache.current.get(key);
          if (!cached) throw new Error(`No presigned URL for ${key}`);
          const res = await fetch(cached.url, {
            method: "PUT",
            headers: { "Content-Type": contentType },
            body,
          });
          if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        } finally {
          releaseSlot();
        }
      }

      const uploads: Promise<void>[] = [];
      for (const email of batch) {
        if (controller.signal.aborted) break;

        const emailUploads: Promise<void>[] = [];

        // Upload .eml
        emailUploads.push(
          uploadFile(email.metadata.r2Key, email.emlBytes, "message/rfc822"),
        );

        // Upload attachment blobs
        for (const blob of email.attachmentBlobs) {
          emailUploads.push(
            uploadFile(blob.r2Key, blob.data, blob.contentType),
          );
        }

        uploads.push(
          Promise.all(emailUploads).then(async () => {
            await updateState(email.id, "uploaded");
            p.current++;
            setProgress({ ...p });
          }).catch(() => {
            p.errors++;
            setProgress({ ...p });
          }),
        );
      }

      await Promise.all(uploads);
    }

    if (!controller.signal.aborted) {
      const counts2 = await countByState();
      startPhase3(accountId, counts2);
    }
  }

  // ── Phase 3: Flush metadata to D1 ────────────────────────────────

  async function startPhase3(accountId: string, initialCounts?: StateCounts) {
    setPhase("phase3");
    const controller = abortRef.current || new AbortController();
    abortRef.current = controller;

    const counts = initialCounts || await countByState();
    const totalToCommit = counts.uploaded;
    const p: PhaseProgress = { current: 0, total: totalToCommit, errors: 0, startTime: Date.now() };
    setProgress({ ...p });

    while (!controller.signal.aborted) {
      const batch = await getByState("uploaded", BATCH_SIZE);
      if (batch.length === 0) break;

      const items: BatchIngestItem[] = batch.map((email) => ({
        id: email.id,
        threadId: email.metadata.threadId,
        fromAddress: email.metadata.fromAddress,
        fromName: email.metadata.fromName,
        toAddresses: email.metadata.toAddresses,
        ccAddresses: email.metadata.ccAddresses,
        subject: email.metadata.subject,
        dateUnix: email.metadata.dateUnix,
        dateIso: email.metadata.dateIso,
        labels: email.metadata.labels,
        hasAttachments: email.metadata.hasAttachments,
        bodyText: email.metadata.bodyText,
        bodyHtml: email.metadata.bodyHtml,
        r2Key: email.metadata.r2Key,
        inReplyTo: email.metadata.inReplyTo,
        attachments: email.attachments.map((att) => ({
          id: att.id,
          filename: att.filename,
          contentType: att.contentType,
          sizeBytes: att.sizeBytes,
          contentId: att.contentId,
          isInline: att.isInline,
          r2Key: att.r2Key,
        })),
      }));

      try {
        await ingestBatch(accountId, items);
        for (const email of batch) {
          await updateState(email.id, "committed");
        }
        p.current += batch.length;
      } catch {
        p.errors += batch.length;
      }
      setProgress({ ...p });
    }

    if (!controller.signal.aborted) {
      await clearCommitted();
      await clearHandle();
      setPhase("done");
    }
  }

  // ── abort ─────────────────────────────────────────────────────────

  function handleAbort() {
    abortRef.current?.abort();
    // Progress is saved — user can resume later
    setPhase("file");
  }

  // ── render helpers ────────────────────────────────────────────────

  const totalSize = file?.size || 0;
  const isPhase1 = phase === "phase1";
  const pct = isPhase1
    ? (totalSize > 0 ? (bytesRead / totalSize) * 100 : 0)
    : (progress.total > 0 ? (progress.current / progress.total) * 100 : 0);
  const elapsed = progress.startTime > 0 ? (Date.now() - progress.startTime) / 1000 : 0;

  function phaseLabel(p: Phase): string {
    switch (p) {
      case "phase1": return "Parsing emails";
      case "phase2": return "Uploading to storage";
      case "phase3": return "Saving metadata";
      default: return "";
    }
  }

  const activePhases: Phase[] = ["phase1", "phase2", "phase3"];
  const isImporting = activePhases.includes(phase);

  return (
    <>
      <h2 className="page-title">Import</h2>

      {phase === "account" && (
        <div>
          {resumeAvailable && resumeCounts && (
            <div className="card mt-2" style={{ borderColor: "#8b8bff" }}>
              <div style={{ marginBottom: "0.5rem", color: "#8b8bff", fontWeight: 500 }}>Resume previous import</div>
              <div className="subtitle">
                {resumeCounts.parsed > 0 && `${resumeCounts.parsed} awaiting upload`}
                {resumeCounts.parsed > 0 && resumeCounts.uploaded > 0 && " · "}
                {resumeCounts.uploaded > 0 && `${resumeCounts.uploaded} awaiting commit`}
                {resumeCounts.committed > 0 && ` · ${resumeCounts.committed} done`}
              </div>
              <div className="row mt-1">
                <button className="btn" style={{ flex: 1 }} onClick={handleDiscardResume}>Discard</button>
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleResume}>Resume</button>
              </div>
            </div>
          )}

          <div className="gap-sm mt-2">
            {accounts.map((acc) => (
              <div key={acc.id} className="card" onClick={() => selectAccount(acc.id)}>
                <div>{acc.name}</div>
                <div className="subtitle">{acc.email || acc.id}</div>
              </div>
            ))}
          </div>

          {!showNewForm ? (
            <button className="btn btn-block mt-2" onClick={() => setShowNewForm(true)}>
              New account
            </button>
          ) : (
            <form onSubmit={handleCreateAccount} className="mt-2">
              <div className="field">
                <label>ID (short name)</label>
                <input name="id" placeholder="personal" required />
              </div>
              <div className="field">
                <label>Display name</label>
                <input name="name" placeholder="Personal Gmail" required />
              </div>
              <div className="field">
                <label>Email address</label>
                <input name="email" type="email" placeholder="you@gmail.com" />
              </div>
              <div className="row mt-1">
                <button type="button" className="btn" style={{ flex: 1 }} onClick={() => setShowNewForm(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>
                  Create
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {phase === "file" && (
        <div>
          <button className="btn btn-primary btn-block" onClick={pickFile}>
            Choose .mbox file
          </button>

          {file && (
            <div className="card mt-2">
              <div>{file.name}</div>
              <div className="subtitle">{formatBytes(file.size)}</div>
            </div>
          )}

          {file && (
            <button className="btn btn-primary btn-block mt-2" onClick={startPhase1}>
              Start import
            </button>
          )}
        </div>
      )}

      {isImporting && (
        <div>
          {/* Stepper */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "1.5rem" }}>
            {activePhases.map((p, i) => {
              const phaseIndex = activePhases.indexOf(phase);
              const isComplete = i < phaseIndex;
              const isActive = p === phase;
              return (
                <div key={p} style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                  <div style={{
                    width: 24, height: 24, borderRadius: "50%",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: "0.75rem", fontWeight: 600,
                    background: isComplete ? "#1a2e1a" : isActive ? "#1a1a2e" : "#1a1a1a",
                    color: isComplete ? "#6b6" : isActive ? "#8b8bff" : "#666",
                    border: `1px solid ${isComplete ? "#363" : isActive ? "#334" : "#333"}`,
                  }}>
                    {isComplete ? "\u2713" : i + 1}
                  </div>
                  <span style={{
                    fontSize: "0.85rem",
                    color: isComplete ? "#6b6" : isActive ? "#e5e5e5" : "#666",
                  }}>
                    {phaseLabel(p)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Active phase progress */}
          <div className="progress-bar">
            <div className="fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="stats-grid">
            {isPhase1 ? (
              <>
                <span className="label">Parsed</span>
                <span className="value">{progress.current > 0 ? formatBytes(progress.current) : "—"}</span>
                <span className="label">Total</span>
                <span className="value">{formatBytes(totalSize)}</span>
              </>
            ) : (
              <>
                <span className="label">Progress</span>
                <span className="value">{progress.current.toLocaleString()} / {progress.total.toLocaleString()}</span>
              </>
            )}
            <span className="label">Errors</span>
            <span className="value">{progress.errors.toLocaleString()}</span>
            <span className="label">Elapsed</span>
            <span className="value">{elapsed > 0 ? formatDuration(elapsed) : "—"}</span>
          </div>

          <button className="btn btn-block mt-3" onClick={handleAbort}>
            Pause (progress saved)
          </button>
        </div>
      )}

      {phase === "done" && (
        <div style={{ textAlign: "center", padding: "2rem 0" }}>
          <h3 style={{ fontSize: "1.1rem", color: "#fff", marginBottom: "0.5rem" }}>Import complete</h3>
          <p className="muted text-sm">
            {progress.current.toLocaleString()} emails imported
            {progress.errors > 0 && ` · ${progress.errors.toLocaleString()} errors`}
          </p>
          <button className="btn btn-block mt-3" onClick={() => {
            setPhase("account");
            setFile(null);
            setFileHandle(null);
            setBytesRead(0);
            setProgress({ current: 0, total: 0, errors: 0, startTime: 0 });
          }}>
            Import another
          </button>
        </div>
      )}
    </>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
