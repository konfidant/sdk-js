import * as sdk from '../index';
import { KonfidantClient, openShare } from '../client';
import { KonfidantApiError } from '../errors';
import { KnfError, bytesSource, buildShareUrl, concat, decodeKey, decrypt, encrypt, encryptText, generateKey } from '../knf';
import type { FileUpload } from '../types';

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

interface Call {
  url: string;
  init: RequestInit;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function binary(bytes: Uint8Array): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
}

/** Installs a fetch mock that answers calls in order with `handlers`. */
function mockFetch(...handlers: Handler[]): Call[] {
  const calls: Call[] = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const handler = handlers[calls.length - 1];
    if (!handler) throw new Error(`Unexpected fetch #${calls.length}: ${url}`);
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

function headersOf(call: Call): Record<string, string> {
  return { ...(call.init.headers as Record<string, string>) };
}

function hasHeader(call: Call, name: string): boolean {
  return Object.keys(headersOf(call)).some((key) => key.toLowerCase() === name.toLowerCase());
}

async function bodyBytes(call: Call): Promise<Uint8Array> {
  const body = call.init.body;
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof Uint8Array) return body;
  throw new Error('Unexpected body type');
}

function keyFromShareUrl(shareUrl: string): Uint8Array {
  const k = new URLSearchParams(new URL(shareUrl).hash.slice(1)).get('k');
  return decodeKey(k as string);
}

const DOWNLOAD_URL = 'https://download.konfidant.app/#t=hvs.CAES%2Btoken';
const SHARE_URL_PATTERN = /^https:\/\/download\.konfidant\.app\/#t=hvs\.CAES%2Btoken&k=[A-Za-z0-9_-]{43}$/;
const EXPIRES_AT = '2026-10-04T12:00:00.000Z';

const UPLOAD_HEADERS = {
  'Content-Type': 'application/octet-stream',
  'x-amz-meta-organization-id': 'org_1',
};

function createFileResponse() {
  return json(201, {
    upload_url: 'https://r2.example.com/bucket/abc.knf?X-Amz-Signature=sig',
    file_key: 'abc.knf',
    upload_headers: UPLOAD_HEADERS,
    upload_expires_in: 900,
  });
}

function completeResponse() {
  return json(201, { download_url: DOWNLOAD_URL, file_id: 'file_1', expires_at: EXPIRES_AT, verified_burn: true });
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Constructor and exports
// ---------------------------------------------------------------------------

describe('KonfidantClient constructor', () => {
  it('throws when apiKey is missing', () => {
    expect(() => new KonfidantClient({ apiKey: '' })).toThrow('apiKey is required');
  });

  it('strips trailing slashes from baseUrl', async () => {
    const calls = mockFetch(() => json(200, { shares: [], pagination: {} }));
    await new KonfidantClient({ apiKey: 'k', baseUrl: 'https://example.com//' }).listShares();
    expect(calls[0].url).toBe('https://example.com/api/v1/shares');
  });

  it('defaults to the production baseUrl', async () => {
    const calls = mockFetch(() => json(200, { shares: [], pagination: {} }));
    await new KonfidantClient({ apiKey: 'k' }).listShares();
    expect(calls[0].url).toBe('https://www.konfidant.app/api/v1/shares');
  });
});

describe('package exports', () => {
  it('exposes the client, openShare and KNF primitives', () => {
    for (const name of ['KonfidantClient', 'KonfidantApiError', 'openShare', 'encrypt', 'decrypt', 'generateKey',
      'encodeKey', 'decodeKey', 'KnfDecryptor', 'buildShareUrl', 'parseShareFragment', 'ciphertextSize']) {
      expect(sdk).toHaveProperty(name);
    }
  });

  it('no longer has the plaintext-era methods', () => {
    const client = new KonfidantClient({ apiKey: 'k' }) as unknown as Record<string, unknown>;
    expect(client.shareAndUploadFile).toBeUndefined();
    expect(client.getFileStatus).toBeUndefined();
    expect(client.uploadFile).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// shareText
// ---------------------------------------------------------------------------

describe('shareText', () => {
  const client = new KonfidantClient({ apiKey: 'test-key' });

  it('encrypts locally, POSTs only ciphertext and builds the share URL with the key in the fragment', async () => {
    const calls = mockFetch(() => json(201, { download_url: DOWNLOAD_URL, text_id: 'txt_1', expires_at: EXPIRES_AT }));

    const result = await client.shareText('db-password: hunter2', { ttlHours: 24 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://www.konfidant.app/api/v1/texts');
    expect(calls[0].init.method).toBe('POST');
    expect(headersOf(calls[0])).toEqual({ Authorization: 'Bearer test-key', 'Content-Type': 'application/json' });

    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['ciphertext', 'ttl_hours']);
    expect(body.ttl_hours).toBe(24);
    expect(body.ciphertext).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(calls[0].init.body).not.toContain('hunter2');

    expect(result.shareUrl).toMatch(SHARE_URL_PATTERN);
    expect(result).toMatchObject({ textId: 'txt_1', expiresAt: EXPIRES_AT });

    const key = keyFromShareUrl(result.shareUrl);
    expect(calls[0].init.body).not.toContain(sdk.encodeKey(key));
    const ciphertext = new Uint8Array(Buffer.from(body.ciphertext as string, 'base64'));
    const decrypted = await decrypt(key, ciphertext);
    expect(decrypted.kind).toBe('text');
    expect(Buffer.from(decrypted.data).toString('utf8')).toBe('db-password: hunter2');
  });

  it('uses a fresh key per share and omits ttl_hours by default', async () => {
    const response = () => json(201, { download_url: DOWNLOAD_URL, text_id: null, expires_at: EXPIRES_AT });
    const calls = mockFetch(response, response);

    const a = await client.shareText('same');
    const b = await client.shareText('same');

    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty('ttl_hours');
    expect(a.textId).toBeNull();
    expect(keyFromShareUrl(a.shareUrl)).not.toEqual(keyFromShareUrl(b.shareUrl));
  });

  it('encodes large texts as standard base64', async () => {
    const calls = mockFetch(() => json(201, { download_url: DOWNLOAD_URL, text_id: null, expires_at: EXPIRES_AT }));
    const text = 'ü'.repeat(100_000);
    const { shareUrl } = await client.shareText(text);
    const body = JSON.parse(calls[0].init.body as string) as { ciphertext: string };
    const decrypted = await decrypt(keyFromShareUrl(shareUrl), new Uint8Array(Buffer.from(body.ciphertext, 'base64')));
    expect(Buffer.from(decrypted.data).toString('utf8')).toBe(text);
  });

  it('refuses a download_url without a #t= fragment so the key never lands in the query string', async () => {
    mockFetch(() => json(201, { download_url: 'https://download.konfidant.app/?t=x', text_id: null, expires_at: '' }));
    await expect(client.shareText('secret')).rejects.toThrow(KnfError);
  });

  it('throws KonfidantApiError with status, code, message and body', async () => {
    mockFetch(() => json(400, { error: 'invalid_ttl', message: 'ttl_hours exceeds plan maximum' }));
    const err = (await client.shareText('x', { ttlHours: 999 }).catch((e: unknown) => e)) as KonfidantApiError;
    expect(err).toBeInstanceOf(KonfidantApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('invalid_ttl');
    expect(err.message).toBe('ttl_hours exceeds plan maximum');
    expect(err.body).toEqual({ error: 'invalid_ttl', message: 'ttl_hours exceeds plan maximum' });
  });

  it('uses the error field as message when no message is given', async () => {
    mockFetch(() => json(401, { error: 'Missing or invalid Authorization header.' }));
    await expect(client.shareText('x')).rejects.toMatchObject({
      status: 401,
      message: 'Missing or invalid Authorization header.',
    });
  });

  it('handles non-JSON error bodies', async () => {
    mockFetch(() => new Response('Bad Gateway', { status: 502, headers: { 'content-type': 'text/plain' } }));
    await expect(client.shareText('x')).rejects.toMatchObject({
      status: 502,
      code: undefined,
      message: 'Request failed: HTTP 502',
      body: 'Bad Gateway',
    });
  });
});

// ---------------------------------------------------------------------------
// shareFile
// ---------------------------------------------------------------------------

describe('shareFile', () => {
  const client = new KonfidantClient({ apiKey: 'test-key' });
  const content = Uint8Array.from({ length: 3 * 1024 * 1024 + 123 }, (_, i) => (i * 7) % 256);

  async function runShare(data: sdk.FileData, options: sdk.ShareFileOptions) {
    const calls = mockFetch(createFileResponse, () => new Response(null, { status: 200 }), completeResponse);
    const result = await client.shareFile(data, options);
    return { calls, result };
  }

  it('creates the upload, PUTs the ciphertext without the API key and completes it', async () => {
    const { calls, result } = await runShare(Buffer.from(content), {
      filename: 'Quarterly report – Q3.pdf',
      contentType: 'application/pdf',
      ttlHours: 48,
    });

    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['POST', 'https://www.konfidant.app/api/v1/files'],
      ['PUT', 'https://r2.example.com/bucket/abc.knf?X-Amz-Signature=sig'],
      ['POST', 'https://www.konfidant.app/api/v1/files/abc.knf/complete'],
    ]);

    // 1. create: only size + ttl, no plaintext metadata
    const createBody = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    expect(Object.keys(createBody).sort()).toEqual(['ciphertext_size', 'ttl_hours']);
    expect(createBody.ttl_hours).toBe(48);
    expect(headersOf(calls[0]).Authorization).toBe('Bearer test-key');

    // 2. upload: exactly upload_headers, no Authorization, size matches
    expect(headersOf(calls[1])).toEqual(UPLOAD_HEADERS);
    expect(hasHeader(calls[1], 'authorization')).toBe(false);
    const uploaded = await bodyBytes(calls[1]);
    expect(uploaded.length).toBe(createBody.ciphertext_size);
    expect(sdk.hasValidHeader(uploaded)).toBe(true);

    // 3. complete: authenticated POST without a body
    expect(headersOf(calls[2])).toEqual({ Authorization: 'Bearer test-key' });
    expect(calls[2].init.body).toBeUndefined();

    expect(result).toEqual({
      shareUrl: expect.stringMatching(SHARE_URL_PATTERN),
      fileId: 'file_1',
      expiresAt: EXPIRES_AT,
      verifiedBurn: true,
    });

    const decrypted = await decrypt(keyFromShareUrl(result.shareUrl), uploaded);
    expect(decrypted).toMatchObject({ kind: 'file', name: 'Quarterly report – Q3.pdf', mime: 'application/pdf' });
    // Buffer.equals: Jest's toEqual is very slow on multi-megabyte typed arrays.
    expect(Buffer.from(decrypted.data).equals(content)).toBe(true);
  });

  it('accepts a Blob and takes the MIME type from it', async () => {
    const { calls, result } = await runShare(new Blob([content.subarray(0, 5000)], { type: 'image/png' }), {
      filename: 'a.png',
    });
    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty('ttl_hours');
    const decrypted = await decrypt(keyFromShareUrl(result.shareUrl), await bodyBytes(calls[1]));
    expect(decrypted).toMatchObject({ name: 'a.png', mime: 'image/png' });
    expect(decrypted.data).toEqual(content.subarray(0, 5000));
  });

  it('accepts an ArrayBuffer and empty files', async () => {
    const { calls, result } = await runShare(new ArrayBuffer(0), { filename: 'empty.txt' });
    const decrypted = await decrypt(keyFromShareUrl(result.shareUrl), await bodyBytes(calls[1]));
    expect(decrypted).toMatchObject({ kind: 'file', name: 'empty.txt', mime: '' });
    expect(decrypted.data.length).toBe(0);
  });

  it('requires a filename', async () => {
    await expect(client.shareFile(new Uint8Array(1), { filename: '' })).rejects.toThrow('filename is required');
  });

  it('surfaces 409 upload_incomplete from complete', async () => {
    mockFetch(createFileResponse, () => new Response(null, { status: 200 }), () =>
      json(409, { error: 'upload_incomplete' }),
    );
    await expect(client.shareFile(new Uint8Array(10), { filename: 'f' })).rejects.toMatchObject({
      name: 'KonfidantApiError',
      status: 409,
      code: 'upload_incomplete',
    });
  });

  it('throws when the storage upload fails and does not complete', async () => {
    const calls = mockFetch(createFileResponse, () =>
      new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', {
        status: 403,
        headers: { 'content-type': 'application/xml' },
      }),
    );
    await expect(client.shareFile(new Uint8Array(10), { filename: 'f' })).rejects.toMatchObject({
      status: 403,
      message: 'Upload failed: HTTP 403',
    });
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Low-level upload API
// ---------------------------------------------------------------------------

describe('createFileUpload', () => {
  const client = new KonfidantClient({ apiKey: 'test-key' });

  it('maps the response to camelCase and remembers the size', async () => {
    const calls = mockFetch(createFileResponse);
    const upload = await client.createFileUpload(1234, 12);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ ciphertext_size: 1234, ttl_hours: 12 });
    expect(upload).toEqual({
      uploadUrl: 'https://r2.example.com/bucket/abc.knf?X-Amz-Signature=sig',
      fileKey: 'abc.knf',
      uploadHeaders: UPLOAD_HEADERS,
      uploadExpiresIn: 900,
      ciphertextSize: 1234,
    });
  });

  it('rejects invalid sizes without calling the API', async () => {
    const calls = mockFetch();
    await expect(client.createFileUpload(0, 1)).rejects.toThrow(RangeError);
    await expect(client.createFileUpload(1.5, 1)).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('throws KonfidantApiError on 413', async () => {
    mockFetch(() => json(413, { error: 'file_too_large' }));
    await expect(client.createFileUpload(10, 1)).rejects.toMatchObject({ status: 413, code: 'file_too_large' });
  });
});

describe('uploadCiphertext', () => {
  const client = new KonfidantClient({ apiKey: 'test-key' });
  const upload = (headers: Record<string, string> = UPLOAD_HEADERS): FileUpload => ({
    uploadUrl: 'https://r2.example.com/u',
    fileKey: 'k',
    uploadHeaders: headers,
    uploadExpiresIn: 60,
    ciphertextSize: 4,
  });

  it('PUTs bytes with the upload headers only', async () => {
    const calls = mockFetch(() => new Response(null, { status: 200 }));
    await client.uploadCiphertext(upload(), new Uint8Array([1, 2, 3, 4]));
    expect(calls[0].init.method).toBe('PUT');
    expect(headersOf(calls[0])).toEqual(UPLOAD_HEADERS);
    expect(await bodyBytes(calls[0])).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('leaves Content-Length to fetch when it matches the body', async () => {
    const calls = mockFetch(() => new Response(null, { status: 200 }));
    await client.uploadCiphertext(upload({ ...UPLOAD_HEADERS, 'Content-Length': '4' }), new Uint8Array(4));
    expect(headersOf(calls[0])).toEqual(UPLOAD_HEADERS);
  });

  it('rejects a body whose size differs from the slot', async () => {
    const calls = mockFetch();
    await expect(client.uploadCiphertext(upload(), new Uint8Array(5))).rejects.toThrow('expects 4');
    await expect(
      client.uploadCiphertext(upload({ 'content-length': '5' }), new Uint8Array(4)),
    ).rejects.toThrow('Content-Length');
    expect(calls).toHaveLength(0);
  });
});

describe('completeFileUpload', () => {
  const client = new KonfidantClient({ apiKey: 'test-key' });

  it('URL-encodes the file key and maps the response', async () => {
    const calls = mockFetch(completeResponse);
    const result = await client.completeFileUpload('org 1/abc.knf');
    expect(calls[0].url).toBe('https://www.konfidant.app/api/v1/files/org%201%2Fabc.knf/complete');
    expect(calls[0].init.method).toBe('POST');
    expect(result).toEqual({ downloadUrl: DOWNLOAD_URL, fileId: 'file_1', expiresAt: EXPIRES_AT, verifiedBurn: true });
  });

  it('throws 409 upload_incomplete when the object is missing', async () => {
    mockFetch(() => json(409, { error: 'upload_incomplete' }));
    const err = (await client.completeFileUpload('abc.knf').catch((e: unknown) => e)) as KonfidantApiError;
    expect(err).toBeInstanceOf(KonfidantApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('upload_incomplete');
  });

  it('can be combined with buildShareUrl', async () => {
    mockFetch(completeResponse);
    const key = generateKey();
    const { downloadUrl } = await client.completeFileUpload('abc.knf');
    expect(buildShareUrl(downloadUrl, key)).toMatch(SHARE_URL_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// listShares
// ---------------------------------------------------------------------------

describe('listShares', () => {
  const client = new KonfidantClient({ apiKey: 'test-key' });
  const response = {
    shares: [
      {
        type: 'file',
        file_size_bytes: 2048,
        created_at: '2026-10-01T00:00:00.000Z',
        expires_at: EXPIRES_AT,
        accessed_at: null,
        created_by: 'dev@example.com',
      },
    ],
    pagination: { total: 1, limit: 10, offset: 5, has_more: false },
  };

  it('GETs /api/v1/shares with filters', async () => {
    const calls = mockFetch(() => json(200, response));
    const result = await client.listShares({ type: 'file', status: 'active', limit: 10, offset: 5 });
    expect(calls[0].url).toBe('https://www.konfidant.app/api/v1/shares?type=file&status=active&limit=10&offset=5');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
    expect(headersOf(calls[0])).toEqual({ Authorization: 'Bearer test-key' });
    expect(result).toEqual(response);
  });

  it('omits the query string without params', async () => {
    const calls = mockFetch(() => json(200, response));
    await client.listShares();
    expect(calls[0].url).toBe('https://www.konfidant.app/api/v1/shares');
  });

  it('throws on 403', async () => {
    mockFetch(() => json(403, { error: 'Insufficient scope', required_scope: 'shares:read' }));
    await expect(client.listShares()).rejects.toMatchObject({ status: 403, code: 'Insufficient scope' });
  });
});

// ---------------------------------------------------------------------------
// openShare
// ---------------------------------------------------------------------------

describe('openShare', () => {
  const client = new KonfidantClient({ apiKey: 'test-key' });

  it('POSTs only the token to the link origin, without the API key, and decrypts text', async () => {
    const key = generateKey();
    const ciphertext = await encryptText(key, 'postgres://user:s3cret@db:5432');
    const calls = mockFetch(() => binary(ciphertext));

    const shareUrl = buildShareUrl(DOWNLOAD_URL, key);
    const opened = await client.openShare(shareUrl);

    expect(calls[0].url).toBe('https://download.konfidant.app/api/download');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ t: 'hvs.CAES+token' });
    expect(hasHeader(calls[0], 'authorization')).toBe(false);
    expect(calls[0].init.body).not.toContain(sdk.encodeKey(key));
    expect(opened).toMatchObject({ kind: 'text', name: '', mime: '', text: 'postgres://user:s3cret@db:5432' });
  });

  it('decrypts file shares from a custom domain without needing a client', async () => {
    const key = generateKey();
    const content = Uint8Array.from({ length: 10_000 }, (_, i) => i % 251);
    const ciphertext = concat(
      await encrypt(key, { kind: 'file', name: 'report.pdf', mime: 'application/pdf' }, bytesSource(content)),
    );
    const calls = mockFetch(() => binary(ciphertext));

    const opened = await openShare(buildShareUrl('https://share.example.com/#t=tok', key));

    expect(calls[0].url).toBe('https://share.example.com/api/download');
    expect(opened.kind).toBe('file');
    expect(opened.name).toBe('report.pdf');
    expect(opened.mime).toBe('application/pdf');
    expect(opened.data).toEqual(content);
    expect(opened.text).toBeUndefined();
  });

  it('round-trips with shareText', async () => {
    const calls = mockFetch(() => json(201, { download_url: DOWNLOAD_URL, text_id: null, expires_at: EXPIRES_AT }));
    const { shareUrl } = await client.shareText('round trip ✓');
    const uploaded = new Uint8Array(
      Buffer.from((JSON.parse(calls[0].init.body as string) as { ciphertext: string }).ciphertext, 'base64'),
    );
    mockFetch(() => binary(uploaded));
    expect((await openShare(shareUrl)).text).toBe('round trip ✓');
  });

  it('throws KonfidantApiError 410 when the share was already used or expired', async () => {
    mockFetch(() => json(410, { error: 'gone', message: 'This link has already been used or has expired.' }));
    const err = (await openShare(buildShareUrl(DOWNLOAD_URL, generateKey())).catch((e: unknown) => e)) as
      KonfidantApiError;
    expect(err).toBeInstanceOf(KonfidantApiError);
    expect(err.status).toBe(410);
    expect(err.message).toBe('This link has already been used or has expired.');
  });

  it('rejects links without token or key before any request', async () => {
    const calls = mockFetch();
    await expect(openShare('https://download.konfidant.app/#t=tok')).rejects.toThrow(KnfError);
    await expect(openShare('https://download.konfidant.app/#k=abc')).rejects.toThrow(KnfError);
    await expect(openShare('https://download.konfidant.app/?t=tok&k=x')).rejects.toThrow(KnfError);
    await expect(openShare('ftp://download.konfidant.app/#t=a&k=b')).rejects.toThrow('http(s)');
    await expect(openShare('not a url')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('fails on the wrong key', async () => {
    const ciphertext = await encryptText(generateKey(), 'secret');
    mockFetch(() => binary(ciphertext));
    await expect(openShare(buildShareUrl(DOWNLOAD_URL, generateKey()))).rejects.toThrow('Decryption failed');
  });

  it('fails on tampered ciphertext', async () => {
    const key = generateKey();
    const ciphertext = await encryptText(key, 'secret');
    ciphertext[ciphertext.length - 1] ^= 0x01;
    mockFetch(() => binary(ciphertext));
    await expect(openShare(buildShareUrl(DOWNLOAD_URL, key))).rejects.toThrow('Decryption failed');
  });
});
