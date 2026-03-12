const DB_NAME = "mailstash-import";
const DB_VERSION = 1;
const EMAILS_STORE = "emails";
const META_STORE = "meta";

export type EmailState = "parsed" | "uploaded" | "committed";

export interface IDBAttachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentId: string;
  isInline: number;
  r2Key: string;
}

export interface IDBEmailMetadata {
  threadId: string;
  fromAddress: string;
  fromName: string;
  toAddresses: string;
  ccAddresses: string;
  subject: string;
  dateUnix: number;
  dateIso: string;
  labels: string;
  hasAttachments: number;
  bodyText: string;
  bodyHtml: string;
  r2Key: string;
  inReplyTo: string;
}

export interface IDBAttachmentBlob {
  r2Key: string;
  contentType: string;
  data: ArrayBuffer;
}

export interface IDBEmail {
  id: string;
  accountId: string;
  state: EmailState;
  metadata: IDBEmailMetadata;
  attachments: IDBAttachment[];
  emlBytes: ArrayBuffer;
  attachmentBlobs: IDBAttachmentBlob[];
}

export interface StateCounts {
  parsed: number;
  uploaded: number;
  committed: number;
}

export interface SavedHandle {
  handle: FileSystemFileHandle;
  accountId: string;
  bytesRead: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(EMAILS_STORE)) {
        const store = db.createObjectStore(EMAILS_STORE, { keyPath: "id" });
        store.createIndex("state", "state", { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = openDB();
  return dbPromise;
}

function tx(
  storeName: string,
  mode: IDBTransactionMode,
): Promise<{ store: IDBObjectStore; done: Promise<void> }> {
  return getDB().then((db) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return { store, done };
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putEmail(email: IDBEmail): Promise<void> {
  const { store, done } = await tx(EMAILS_STORE, "readwrite");
  store.put(email);
  await done;
}

export async function getByState(
  state: EmailState,
  limit?: number,
): Promise<IDBEmail[]> {
  const { store, done } = await tx(EMAILS_STORE, "readonly");
  const index = store.index("state");
  const results: IDBEmail[] = [];

  return new Promise((resolve, reject) => {
    const req = index.openCursor(IDBKeyRange.only(state));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && (!limit || results.length < limit)) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
    done.catch(reject);
  });
}

export async function updateState(
  id: string,
  newState: EmailState,
): Promise<void> {
  const { store, done } = await tx(EMAILS_STORE, "readwrite");
  const existing = await reqToPromise(store.get(id));
  if (existing) {
    existing.state = newState;
    // When transitioning to uploaded, drop binary blobs to free memory
    if (newState === "uploaded") {
      existing.emlBytes = new ArrayBuffer(0);
      existing.attachmentBlobs = [];
    }
    store.put(existing);
  }
  await done;
}

export async function countByState(): Promise<StateCounts> {
  const { store, done } = await tx(EMAILS_STORE, "readonly");
  const index = store.index("state");
  const counts: StateCounts = { parsed: 0, uploaded: 0, committed: 0 };

  const [parsed, uploaded, committed] = await Promise.all([
    reqToPromise(index.count(IDBKeyRange.only("parsed"))),
    reqToPromise(index.count(IDBKeyRange.only("uploaded"))),
    reqToPromise(index.count(IDBKeyRange.only("committed"))),
  ]);
  await done;

  counts.parsed = parsed;
  counts.uploaded = uploaded;
  counts.committed = committed;
  return counts;
}

export async function saveHandle(
  handle: FileSystemFileHandle,
  accountId: string,
  bytesRead: number,
): Promise<void> {
  const { store, done } = await tx(META_STORE, "readwrite");
  store.put({ key: "fileHandle", handle, accountId, bytesRead });
  await done;
}

export async function getHandle(): Promise<SavedHandle | null> {
  const { store, done } = await tx(META_STORE, "readonly");
  const result = await reqToPromise(store.get("fileHandle"));
  await done;
  if (!result) return null;
  return {
    handle: result.handle,
    accountId: result.accountId,
    bytesRead: result.bytesRead,
  };
}

export async function clearHandle(): Promise<void> {
  const { store, done } = await tx(META_STORE, "readwrite");
  store.delete("fileHandle");
  await done;
}

export async function clearCommitted(): Promise<void> {
  const { store, done } = await tx(EMAILS_STORE, "readwrite");
  const index = store.index("state");
  const req = index.openCursor(IDBKeyRange.only("committed"));
  await new Promise<void>((resolve, reject) => {
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });
  await done;
}

export async function clearAll(): Promise<void> {
  const db = await getDB();
  const transaction = db.transaction(
    [EMAILS_STORE, META_STORE],
    "readwrite",
  );
  transaction.objectStore(EMAILS_STORE).clear();
  transaction.objectStore(META_STORE).clear();
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function hasIncompleteImport(): Promise<boolean> {
  const counts = await countByState();
  return counts.parsed > 0 || counts.uploaded > 0;
}
