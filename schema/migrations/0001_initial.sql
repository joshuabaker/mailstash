-- mailstash schema

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT
);

CREATE TABLE emails (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  thread_id TEXT,
  from_address TEXT,
  from_name TEXT,
  to_addresses TEXT,
  cc_addresses TEXT,
  subject TEXT,
  date_unix INTEGER,
  date_iso TEXT,
  labels TEXT,
  has_attachments INTEGER DEFAULT 0,
  body_text TEXT,
  body_html TEXT,
  r2_key TEXT,
  in_reply_to TEXT
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL REFERENCES emails(id),
  filename TEXT,
  content_type TEXT,
  size_bytes INTEGER,
  content_id TEXT,
  is_inline INTEGER DEFAULT 0,
  r2_key TEXT
);

-- Indexes
CREATE INDEX idx_emails_account_id ON emails(account_id);
CREATE INDEX idx_emails_thread_id ON emails(thread_id);
CREATE INDEX idx_emails_date_unix ON emails(date_unix);
CREATE INDEX idx_emails_from_address ON emails(from_address);
CREATE INDEX idx_attachments_email_id ON attachments(email_id);
CREATE INDEX idx_attachments_content_id ON attachments(content_id);

-- Full-text search
CREATE VIRTUAL TABLE emails_fts USING fts5(
  subject,
  from_name,
  from_address,
  to_addresses,
  body_text,
  content='emails',
  content_rowid='rowid'
);

-- Keep FTS in sync
CREATE TRIGGER emails_fts_insert AFTER INSERT ON emails BEGIN
  INSERT INTO emails_fts(rowid, subject, from_name, from_address, to_addresses, body_text)
  VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.to_addresses, new.body_text);
END;

CREATE TRIGGER emails_fts_delete AFTER DELETE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, from_name, from_address, to_addresses, body_text)
  VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.to_addresses, old.body_text);
END;
