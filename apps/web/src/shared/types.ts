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
