import type { KnfKind } from './knf';

export interface KonfidantClientOptions {
  apiKey: string;
  /** API base URL. Default: `https://www.konfidant.app`. */
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Public method options and results
// ---------------------------------------------------------------------------

export interface ShareTextOptions {
  /** Time-to-live in hours. Default: 8 (the Free tier maximum). */
  ttlHours?: number;
}

export interface ShareTextResult {
  /** One-time link for the recipient. Carries the token and the decryption key in the URL fragment. */
  shareUrl: string;
  /** Present only when the organization has verified burn enabled. */
  textId: string | null;
  /** ISO 8601 expiry timestamp. */
  expiresAt: string;
}

/** File content accepted by `shareFile()`. Node.js `Buffer` is a `Uint8Array`. */
export type FileData = Blob | ArrayBuffer | Uint8Array;

export interface ShareFileOptions {
  /** Original file name, encrypted together with the content (at most 1024 UTF-8 bytes). */
  filename: string;
  /** MIME type, encrypted together with the content (at most 255 UTF-8 bytes). Default: the Blob's type, or empty. */
  contentType?: string;
  /** Time-to-live in hours. Default: 8 (the Free tier maximum). */
  ttlHours?: number;
}

export interface ShareFileResult {
  /** One-time link for the recipient. Carries the token and the decryption key in the URL fragment. */
  shareUrl: string;
  /** Present only when the organization has verified burn enabled. */
  fileId: string | null;
  /** ISO 8601 expiry timestamp. */
  expiresAt: string;
  verifiedBurn: boolean;
}

/** Upload slot returned by `createFileUpload()`. */
export interface FileUpload {
  /** Presigned PUT URL for the KNF1 ciphertext. The API key is never sent to it. */
  uploadUrl: string;
  fileKey: string;
  /** Headers that must be sent verbatim with the PUT. */
  uploadHeaders: Record<string, string>;
  /** Seconds until `uploadUrl` expires. */
  uploadExpiresIn: number;
  /** Exact ciphertext byte length the upload slot was created for. */
  ciphertextSize: number;
}

export interface CompleteFileUploadResult {
  /** Server-issued download URL (`https://<host>/#t=<token>`), without the decryption key. */
  downloadUrl: string;
  /** Present only when the organization has verified burn enabled. */
  fileId: string | null;
  /** ISO 8601 expiry timestamp. */
  expiresAt: string;
  verifiedBurn: boolean;
}

export interface OpenedShare {
  kind: KnfKind;
  /** Original file name (empty for text shares). */
  name: string;
  /** MIME type (empty for text shares; may be empty for files). */
  mime: string;
  /** Decrypted content. */
  data: Uint8Array;
  /** Decoded UTF-8 text (text shares only). */
  text?: string;
}

// ---------------------------------------------------------------------------
// Raw API payloads (snake_case, as sent over the wire)
// ---------------------------------------------------------------------------

/** POST /api/v1/texts response. */
export interface ApiShareTextResponse {
  download_url: string;
  text_id: string | null;
  expires_at: string;
}

/** POST /api/v1/files response. */
export interface ApiCreateFileResponse {
  upload_url: string;
  file_key: string;
  upload_headers: Record<string, string>;
  upload_expires_in: number;
}

/** POST /api/v1/files/{file_key}/complete response. */
export interface ApiCompleteFileResponse {
  download_url: string;
  file_id: string | null;
  expires_at: string;
  verified_burn: boolean;
}

// GET /api/v1/shares
export interface Share {
  type: 'file' | 'text';
  /** Ciphertext size for files; null for texts. */
  file_size_bytes: number | null;
  created_at: string;
  expires_at: string;
  accessed_at: string | null;
  /** Creator email; null if the user was deleted. */
  created_by: string | null;
}

export interface Pagination {
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface ListSharesResponse {
  shares: Share[];
  pagination: Pagination;
}

export interface ListSharesParams {
  type?: 'file' | 'text';
  status?: 'active' | 'accessed';
  limit?: number;
  offset?: number;
}

/** Error body returned by the API. */
export interface KonfidantErrorBody {
  error: string;
  message?: string;
  required_scope?: string;
  available_scopes?: string[];
}
