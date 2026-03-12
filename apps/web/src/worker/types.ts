export type Bindings = {
  DB: D1Database;
  BUCKET: R2Bucket;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string;
};

export interface EmailMetadata {
  id: string;
  accountId: string;
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

export interface AttachmentMeta {
  id: string;
  emailId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentId: string;
  isInline: number;
  r2Key: string;
}

export interface ProcessedEmail {
  metadata: EmailMetadata;
  attachments: AttachmentMeta[];
  attachmentBuffers: Map<string, Uint8Array>;
}

export interface BatchIngestAttachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentId: string;
  isInline: number;
  r2Key: string;
}

export interface BatchIngestItem {
  id: string;
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
  attachments: BatchIngestAttachment[];
}
