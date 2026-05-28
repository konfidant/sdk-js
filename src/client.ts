import { KonfidantApiError } from './errors';
import type {
  KonfidantClientOptions,
  ShareTextRequest,
  ShareTextResponse,
  ShareFileRequest,
  ShareFileResponse,
  FileStatusResponse,
  ListSharesResponse,
  ListSharesParams,
  UploadFileOptions,
} from './types';

const DEFAULT_BASE_URL = 'https://www.konfidant.app';

export class KonfidantClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: KonfidantClientOptions) {
    if (!options.apiKey) {
      throw new Error('apiKey is required');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  private get authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        ...this.authHeaders,
        ...(init.headers as Record<string, string> | undefined),
      },
    });

    let body: unknown;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      body = await res.json();
    } else {
      body = await res.text();
    }

    if (!res.ok) {
      const message =
        typeof body === 'object' &&
        body !== null &&
        'error' in body &&
        typeof (body as Record<string, unknown>).error === 'string'
          ? (body as { error: string }).error
          : `HTTP ${res.status}`;
      throw new KonfidantApiError(message, res.status, body);
    }

    return body as T;
  }

  /**
   * Encrypt and share a text message.
   *
   * @param req - Text content and TTL in hours.
   * @returns Share URL, text ID, expiry, and burn status.
   */
  async shareText(req: ShareTextRequest): Promise<ShareTextResponse> {
    return this.request<ShareTextResponse>('/api/v1/texts', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  /**
   * Request a presigned upload URL for a file.
   * Use the returned `upload_url` with `uploadFile()` to complete the upload.
   *
   * @param req - Filename, file size in bytes, and TTL in hours.
   * @returns Presigned upload URL, file key, metadata headers, and poll URL.
   */
  async shareFile(req: ShareFileRequest): Promise<ShareFileResponse> {
    return this.request<ShareFileResponse>('/api/v1/files', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  /**
   * Poll the encryption status of an uploaded file.
   * Returns `{ status: 'processing' }` while encryption is in progress,
   * or the full share details once complete.
   *
   * @param fileKey - The `file_key` returned by `shareFile()`.
   */
  async getFileStatus(fileKey: string): Promise<FileStatusResponse> {
    return this.request<FileStatusResponse>(
      `/api/v1/files/${encodeURIComponent(fileKey)}/status`,
    );
  }

  /**
   * List all shares for the authenticated organization.
   *
   * @param params - Optional filters: type, status, limit, offset.
   */
  async listShares(params?: ListSharesParams): Promise<ListSharesResponse> {
    const qs = new URLSearchParams();
    if (params?.type) qs.set('type', params.type);
    if (params?.status) qs.set('status', params.status);
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    if (params?.offset !== undefined) qs.set('offset', String(params.offset));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return this.request<ListSharesResponse>(`/api/v1/shares${query}`);
  }

  /**
   * Upload a file to the presigned URL obtained from `shareFile()`.
   * Sends the required S3 metadata headers automatically from `shareFileResponse`.
   *
   * @param options.file            - File content as Blob, Buffer, or ArrayBuffer.
   * @param options.contentType     - MIME type of the file (e.g. "application/zip").
   * @param options.shareFileResponse - Full response from `shareFile()`.
   *
   * @example
   * const presigned = await client.shareFile({ filename: 'doc.pdf', file_size: buf.length, ttl_hours: 48 });
   * await client.uploadFile({ file: buf, contentType: 'application/pdf', shareFileResponse: presigned });
   * const status = await client.getFileStatus(presigned.file_key);
   */
  async uploadFile(options: UploadFileOptions): Promise<void> {
    const { file, contentType, shareFileResponse } = options;
    const { upload_url, metadata_headers } = shareFileResponse;

    const res = await fetch(upload_url, {
      method: 'PUT',
      body: file as BodyInit,
      headers: {
        'Content-Type': contentType,
        'x-amz-meta-organization-id': metadata_headers['x-amz-meta-organization-id'],
        'x-amz-meta-ttl-hours': metadata_headers['x-amz-meta-ttl-hours'],
        'x-amz-meta-user-id': metadata_headers['x-amz-meta-user-id'],
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new KonfidantApiError(
        `File upload failed: HTTP ${res.status}`,
        res.status,
        body,
      );
    }
  }

  /**
   * Convenience: share a file end-to-end.
   * Calls `shareFile()`, `uploadFile()`, then polls `getFileStatus()` until complete.
   *
   * @param file           - File content as Blob, Buffer, or ArrayBuffer.
   * @param filename       - Original filename including extension.
   * @param contentType    - MIME type of the file.
   * @param ttl_hours      - Time-to-live in hours.
   * @param pollIntervalMs - How often to poll (default: 2000ms).
   * @param timeoutMs      - Max total wait time (default: 60000ms).
   */
  async shareAndUploadFile(
    file: Blob | Buffer | ArrayBuffer,
    filename: string,
    contentType: string,
    ttl_hours: number,
    pollIntervalMs = 2000,
    timeoutMs = 60000,
  ): Promise<{ share_url: string; file_id: string; expires_at: string; verified_burn: boolean }> {
    const fileSize = file instanceof Blob ? file.size : (file as Buffer | ArrayBuffer).byteLength;

    const presigned = await this.shareFile({ filename, file_size: fileSize, ttl_hours });
    await this.uploadFile({ file, contentType, shareFileResponse: presigned });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.getFileStatus(presigned.file_key);
      if (status.status === 'complete') {
        return {
          share_url: status.share_url,
          file_id: status.file_id,
          expires_at: status.expires_at,
          verified_burn: status.verified_burn,
        };
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    throw new Error(`Encryption timed out after ${timeoutMs}ms`);
  }
}
