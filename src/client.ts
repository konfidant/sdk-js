import { KonfidantApiError } from './errors';
import {
  KnfError,
  blobSource,
  buildShareUrl,
  bytesSource,
  decodeText,
  decrypt,
  encrypt,
  encryptText,
  generateKey,
  parseShareFragment,
} from './knf';
import type { KnfSource } from './knf';
import type {
  ApiCompleteFileResponse,
  ApiCreateFileResponse,
  ApiShareTextResponse,
  CompleteFileUploadResult,
  FileData,
  FileUpload,
  KonfidantClientOptions,
  ListSharesParams,
  ListSharesResponse,
  OpenedShare,
  ShareFileOptions,
  ShareFileResult,
  ShareTextOptions,
  ShareTextResult,
} from './types';

export const DEFAULT_BASE_URL = 'https://www.konfidant.app';
/** Default share lifetime: the Free tier maximum, so it is accepted on every plan. */

/** Standard base64 (with padding) without relying on Node's Buffer, so the SDK also runs in browsers. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function toSource(data: FileData): KnfSource {
  if (isBlob(data)) return blobSource(data);
  if (data instanceof Uint8Array) return bytesSource(data);
  if (data instanceof ArrayBuffer) return bytesSource(new Uint8Array(data));
  throw new TypeError('data must be a Blob, ArrayBuffer, Uint8Array or Buffer');
}

/**
 * Appends the key to the server-issued download URL. Refuses URLs without a `#t=` fragment: appending the key
 * there would put it in the query string, which is sent to the server.
 */
function shareUrlFor(downloadUrl: string, key: Uint8Array): string {
  if (!new URL(downloadUrl).hash.startsWith('#t=')) {
    throw new KnfError('Unexpected download_url from the API: missing #t= fragment');
  }
  return buildShareUrl(downloadUrl, key);
}

async function readBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

async function apiError(res: Response, fallback: string): Promise<KonfidantApiError> {
  const body = await readBody(res);
  let code: string | undefined;
  let message = `${fallback}: HTTP ${res.status}`;
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.error === 'string') {
      code = record.error;
      message = record.error;
    }
    if (typeof record.message === 'string') message = record.message;
  }
  return new KonfidantApiError(message, res.status, body, code);
}

/**
 * Downloads and decrypts a share. The single-use token is consumed: a second call fails with HTTP 410.
 * Needs no API key — the link alone grants access. Only the token is sent to the server, never the key.
 */
export async function openShare(shareUrl: string): Promise<OpenedShare> {
  const url = new URL(shareUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new KnfError('Share link must be an http(s) URL');
  }
  const fragment = parseShareFragment(url.hash);
  if (!fragment) throw new KnfError('Invalid share link: the fragment must contain #t=<token>&k=<key>');

  const res = await fetch(`${url.origin}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: fragment.token }),
  });
  if (!res.ok) throw await apiError(res, 'Download failed');

  const decrypted = await decrypt(fragment.key, new Uint8Array(await res.arrayBuffer()));
  const opened: OpenedShare = {
    kind: decrypted.kind,
    name: decrypted.name,
    mime: decrypted.mime,
    data: decrypted.data,
  };
  if (decrypted.kind === 'text') opened.text = decodeText(decrypted);
  return opened;
}

export class KonfidantClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: KonfidantClientOptions) {
    if (!options.apiKey) {
      throw new Error('apiKey is required');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw await apiError(res, 'Request failed');
    return (await readBody(res)) as T;
  }

  /**
   * Encrypts `text` locally and shares it. Konfidant only receives the ciphertext; the key is placed in the
   * returned link's fragment.
   */
  async shareText(text: string, options: ShareTextOptions = {}): Promise<ShareTextResult> {
    const key = generateKey();
    const ciphertext = await encryptText(key, text);
    const res = await this.request<ApiShareTextResponse>('POST', '/api/v1/texts', {
      ciphertext: toBase64(ciphertext),
      ...(options.ttlHours !== undefined ? { ttl_hours: options.ttlHours } : {}),
    });
    return { shareUrl: shareUrlFor(res.download_url, key), textId: res.text_id, expiresAt: res.expires_at };
  }

  /**
   * Encrypts a file locally (content, file name and MIME type) and shares it:
   * `createFileUpload()` → `uploadCiphertext()` → `completeFileUpload()`.
   */
  async shareFile(data: FileData, options: ShareFileOptions): Promise<ShareFileResult> {
    if (!options?.filename) throw new Error('filename is required');
    const key = generateKey();
    const mime = options.contentType ?? (isBlob(data) ? data.type : '');
    const parts = await encrypt(key, { kind: 'file', name: options.filename, mime }, toSource(data));
    const ciphertext = new Blob(parts);

    const upload = await this.createFileUpload(ciphertext.size, options.ttlHours);
    await this.uploadCiphertext(upload, ciphertext);
    const done = await this.completeFileUpload(upload.fileKey);
    return {
      shareUrl: shareUrlFor(done.downloadUrl, key),
      fileId: done.fileId,
      expiresAt: done.expiresAt,
      verifiedBurn: done.verifiedBurn,
    };
  }

  /** Low-level: reserves an upload slot for `ciphertextSize` bytes of KNF1 ciphertext. */
  async createFileUpload(ciphertextSize: number, ttlHours?: number): Promise<FileUpload> {
    if (!Number.isSafeInteger(ciphertextSize) || ciphertextSize <= 0) {
      throw new RangeError('ciphertextSize must be a positive integer');
    }
    const res = await this.request<ApiCreateFileResponse>('POST', '/api/v1/files', {
      ciphertext_size: ciphertextSize,
      ...(ttlHours !== undefined ? { ttl_hours: ttlHours } : {}),
    });
    return {
      uploadUrl: res.upload_url,
      fileKey: res.file_key,
      uploadHeaders: res.upload_headers ?? {},
      uploadExpiresIn: res.upload_expires_in,
      ciphertextSize,
    };
  }

  /**
   * Low-level: PUTs KNF1 ciphertext to the presigned URL with exactly the server-provided headers.
   * The API key is not sent. `Content-Length` is derived from the body by `fetch` and must match the slot size.
   */
  async uploadCiphertext(upload: FileUpload, ciphertext: Uint8Array | Blob): Promise<void> {
    const size = isBlob(ciphertext) ? ciphertext.size : ciphertext.byteLength;
    if (size !== upload.ciphertextSize) {
      throw new RangeError(`Ciphertext is ${size} bytes but the upload slot expects ${upload.ciphertextSize}`);
    }

    // fetch() computes Content-Length from the body (and browsers forbid setting it), so it is not forwarded.
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(upload.uploadHeaders)) {
      if (name.toLowerCase() === 'content-length') {
        if (Number(value) !== size) throw new RangeError('upload_headers Content-Length does not match ciphertext');
        continue;
      }
      headers[name] = value;
    }

    const res = await fetch(upload.uploadUrl, {
      method: 'PUT',
      headers,
      body: ciphertext as Uint8Array<ArrayBuffer> | Blob,
    });
    if (!res.ok) throw await apiError(res, 'Upload failed');
  }

  /**
   * Low-level: finalizes an uploaded file and returns the server-issued download URL (without the key; append it
   * with `buildShareUrl(downloadUrl, key)`). Throws `KonfidantApiError` with status 409 / code `upload_incomplete`
   * if the ciphertext has not been uploaded yet.
   */
  async completeFileUpload(fileKey: string): Promise<CompleteFileUploadResult> {
    const res = await this.request<ApiCompleteFileResponse>(
      'POST',
      `/api/v1/files/${encodeURIComponent(fileKey)}/complete`,
    );
    return {
      downloadUrl: res.download_url,
      fileId: res.file_id,
      expiresAt: res.expires_at,
      verifiedBurn: res.verified_burn,
    };
  }

  /** Lists shares of the authenticated organization (metadata only; no content, names or keys). */
  async listShares(params?: ListSharesParams): Promise<ListSharesResponse> {
    const qs = new URLSearchParams();
    if (params?.type) qs.set('type', params.type);
    if (params?.status) qs.set('status', params.status);
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    if (params?.offset !== undefined) qs.set('offset', String(params.offset));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return this.request<ListSharesResponse>('GET', `/api/v1/shares${query}`);
  }

  /** Downloads and decrypts a share link. Equivalent to the standalone `openShare()`; the API key is not sent. */
  async openShare(shareUrl: string): Promise<OpenedShare> {
    return openShare(shareUrl);
  }
}
