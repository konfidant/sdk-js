export interface KonfidantClientOptions {
  apiKey: string;
  baseUrl?: string;
}

// POST /api/v1/texts
export interface ShareTextRequest {
  text: string;
  ttl_hours: number;
}

export interface ShareTextResponse {
  text_id: string;
  share_url: string;
  expires_at: string;
  verified_burn: boolean;
}

// POST /api/v1/files
export interface ShareFileRequest {
  filename: string;
  file_size: number;
  ttl_hours: number;
}

export interface FileMetadataHeaders {
  'x-amz-meta-user-id': string;
  'x-amz-meta-ttl-hours': string;
  'x-amz-meta-organization-id': string;
}

export interface ShareFileResponse {
  upload_url: string;
  file_key: string;
  metadata_headers: FileMetadataHeaders;
  poll_url: string;
}

// GET /api/v1/files/{fileKey}/status
export type EncryptionStatus = 'processing' | 'complete';

export interface FileStatusProcessing {
  status: 'processing';
  message: string;
}

export interface FileStatusComplete {
  status: 'complete';
  file_id: string;
  file_name: string;
  share_url: string;
  expires_at: string;
  verified_burn: boolean;
}

export type FileStatusResponse = FileStatusProcessing | FileStatusComplete;

// GET /api/v1/shares
export interface Share {
  type: 'file' | 'text';
  file_name: string;
  file_size_bytes: number;
  created_at: string;
  expires_at: string;
  accessed_at: string | null;
  created_by: string;
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

// uploadFile helper
export interface UploadFileOptions {
  file: Blob | Buffer | ArrayBuffer;
  contentType: string;
  shareFileResponse: ShareFileResponse;
}

export interface KonfidantError {
  error: string;
  required_scope?: string;
  available_scopes?: string[];
}
