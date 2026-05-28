import { KonfidantClient } from '../client';
import { KonfidantApiError } from '../errors';
import type { ShareFileResponse } from '../types';

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetch(status: number, body: unknown, contentType = 'application/json'): jest.Mock {
  const mock = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  });
  global.fetch = mock;
  return mock;
}

function makeSigned(): ShareFileResponse {
  return {
    upload_url: 'https://s3.example.com/upload?sig=abc',
    file_key: 'abc123.zip',
    poll_url: 'https://www.konfidant.app/api/v1/files/abc123.zip/status',
    metadata_headers: {
      'x-amz-meta-user-id': 'user-1',
      'x-amz-meta-ttl-hours': '48',
      'x-amz-meta-organization-id': 'org-1',
    },
  };
}

beforeEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('KonfidantClient constructor', () => {
  it('throws when apiKey is missing', () => {
    expect(() => new KonfidantClient({ apiKey: '' })).toThrow('apiKey is required');
  });

  it('strips trailing slash from baseUrl', () => {
    const client = new KonfidantClient({ apiKey: 'k', baseUrl: 'https://example.com/' });
    // Access private field via cast for testing
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe('https://example.com');
  });

  it('defaults to production baseUrl', () => {
    const client = new KonfidantClient({ apiKey: 'k' });
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe('https://www.konfidant.app');
  });
});

// ---------------------------------------------------------------------------
// shareText
// ---------------------------------------------------------------------------

describe('shareText', () => {
  const client = new KonfidantClient({ apiKey: 'test-key' });

  it('POST /api/v1/texts and returns response', async () => {
    const expected = {
      text_id: 'abc',
      share_url: 'https://download.konfidant.app?t=tok',
      expires_at: '2026-06-01 00:00:00',
      verified_burn: true,
    };
    const fetchMock = mockFetch(201, expected);

    const result = await client.shareText({ text: 'Secret', ttl_hours: 24 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.konfidant.app/api/v1/texts');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'Secret', ttl_hours: 24 });
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(result).toEqual(expected);
  });

  it('throws KonfidantApiError on 400', async () => {
    mockFetch(400, { error: 'Invalid JSON body' });
    await expect(client.shareText({ text: '', ttl_hours: 0 })).rejects.toThrow(KonfidantApiError);
  });

  it('KonfidantApiError carries status and body', async () => {
    mockFetch(401, { error: 'Missing or invalid Authorization header.' });
    let err!: KonfidantApiError;
    try {
      await client.shareText({ text: 'x', ttl_hours: 1 });
    } catch (e) {
      err = e as KonfidantApiError;
    }
    expect(err.status).toBe(401);
    expect(err.message).toBe('Missing or invalid Authorization header.');
  });
});

// ---------------------------------------------------------------------------
// shareFile
// ---------------------------------------------------------------------------

describe('shareFile', () => {
  const client = new KonfidantClient({ apiKey: 'test-key' });

  it('POST /api/v1/files and returns presigned response', async () => {
    const expected = makeSigned();
    const fetchMock = mockFetch(202, expected);

    const result = await client.shareFile({ filename: 'doc.pdf', file_size: 1024, ttl_hours: 48 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.konfidant.app/api/v1/files');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ filename: 'doc.pdf', file_size: 1024, ttl_hours: 48 });
    expect(result).toEqual(expected);
  });

  it('throws on 401', async () => {
    mockFetch(401, { error: 'Unauthorized' });
    await expect(client.shareFile({ filename: 'x', file_size: 1, ttl_hours: 1 })).rejects.toThrow(
      KonfidantApiError,
    );
  });
});

// ---------------------------------------------------------------------------
// getFileStatus
// ---------------------------------------------------------------------------

describe('getFileStatus', () => {
  const client = new KonfidantClient({ apiKey: 'test-key' });

  it('returns processing status (202)', async () => {
    const expected = { status: 'processing', message: 'Encryption in progress' };
    const fetchMock = mockFetch(202, expected);

    const result = await client.getFileStatus('abc123.zip');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://www.konfidant.app/api/v1/files/abc123.zip/status');
    expect(result).toEqual(expected);
  });

  it('returns complete status (200)', async () => {
    const expected = {
      status: 'complete',
      file_id: 'file-1',
      file_name: 'doc.pdf',
      share_url: 'https://download.konfidant.app?t=tok',
      expires_at: '2026-06-01 00:00:00',
      verified_burn: true,
    };
    mockFetch(200, expected);
    const result = await client.getFileStatus('abc123.zip');
    expect(result).toEqual(expected);
  });

  it('URL-encodes fileKey', async () => {
    const fetchMock = mockFetch(200, { status: 'complete', file_id: 'x', file_name: 'x', share_url: 'x', expires_at: 'x', verified_burn: false });
    await client.getFileStatus('has spaces.zip');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('has%20spaces.zip');
  });

  it('throws KonfidantApiError on 404', async () => {
    mockFetch(404, { error: 'File not found' });
    await expect(client.getFileStatus('nope')).rejects.toThrow(KonfidantApiError);
  });
});

// ---------------------------------------------------------------------------
// listShares
// ---------------------------------------------------------------------------

describe('listShares', () => {
  const client = new KonfidantClient({ apiKey: 'test-key' });
  const sharesResponse = {
    shares: [],
    pagination: { total: 0, limit: 50, offset: 0, has_more: false },
  };

  it('GET /api/v1/shares with no params', async () => {
    const fetchMock = mockFetch(200, sharesResponse);
    await client.listShares();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://www.konfidant.app/api/v1/shares');
  });

  it('appends query params', async () => {
    const fetchMock = mockFetch(200, sharesResponse);
    await client.listShares({ type: 'file', status: 'active', limit: 10, offset: 20 });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('type=file');
    expect(url).toContain('status=active');
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=20');
  });

  it('returns shares and pagination', async () => {
    const body = {
      shares: [
        {
          type: 'file',
          file_name: 'doc.pdf',
          file_size_bytes: 1024,
          created_at: '2026-05-01T00:00:00.000Z',
          expires_at: '2026-05-08T00:00:00.000Z',
          accessed_at: null,
          created_by: 'user@example.com',
        },
      ],
      pagination: { total: 1, limit: 50, offset: 0, has_more: false },
    };
    mockFetch(200, body);
    const result = await client.listShares();
    expect(result.shares).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
  });

  it('throws KonfidantApiError on 403', async () => {
    mockFetch(403, {
      error: 'Insufficient permissions',
      required_scope: 'shares:list',
      available_scopes: ['files:create'],
    });
    await expect(client.listShares()).rejects.toThrow(KonfidantApiError);
  });
});

// ---------------------------------------------------------------------------
// uploadFile
// ---------------------------------------------------------------------------

describe('uploadFile', () => {
  const client = new KonfidantClient({ apiKey: 'test-key' });

  it('PUT to upload_url with correct headers and body', async () => {
    const fetchMock = mockFetch(200, '', 'text/plain');
    const fileContent = Buffer.from('hello');
    const signed = makeSigned();

    await client.uploadFile({ file: fileContent, contentType: 'text/plain', shareFileResponse: signed });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(signed.upload_url);
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(fileContent);
    expect(init.headers).toMatchObject({
      'Content-Type': 'text/plain',
      'x-amz-meta-organization-id': 'org-1',
      'x-amz-meta-ttl-hours': '48',
      'x-amz-meta-user-id': 'user-1',
    });
  });

  it('does NOT send Konfidant Authorization header to S3', async () => {
    const fetchMock = mockFetch(200, '', 'text/plain');
    await client.uploadFile({
      file: Buffer.from('x'),
      contentType: 'text/plain',
      shareFileResponse: makeSigned(),
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('throws KonfidantApiError when S3 returns error', async () => {
    mockFetch(403, 'AccessDenied', 'application/xml');
    await expect(
      client.uploadFile({ file: Buffer.from('x'), contentType: 'text/plain', shareFileResponse: makeSigned() }),
    ).rejects.toThrow(KonfidantApiError);
  });
});

// ---------------------------------------------------------------------------
// shareAndUploadFile (convenience)
// ---------------------------------------------------------------------------

describe('shareAndUploadFile', () => {
  const client = new KonfidantClient({ apiKey: 'test-key' });

  it('calls shareFile → uploadFile → polls getFileStatus until complete', async () => {
    const signed = makeSigned();
    const processing = { status: 'processing', message: 'Encryption in progress' };
    const complete = {
      status: 'complete',
      file_id: 'file-1',
      file_name: 'doc.pdf',
      share_url: 'https://download.konfidant.app?t=tok',
      expires_at: '2026-06-01 00:00:00',
      verified_burn: true,
    };

    const fetchMock = jest.fn()
      // shareFile → 202
      .mockResolvedValueOnce({ ok: true, status: 202, headers: { get: () => 'application/json' }, json: () => Promise.resolve(signed) })
      // uploadFile → 200
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'text/plain' }, text: () => Promise.resolve('') })
      // getFileStatus → 202 processing
      .mockResolvedValueOnce({ ok: true, status: 202, headers: { get: () => 'application/json' }, json: () => Promise.resolve(processing) })
      // getFileStatus → 200 complete
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: () => Promise.resolve(complete) });

    global.fetch = fetchMock;
    jest.useFakeTimers();

    const resultPromise = client.shareAndUploadFile(Buffer.from('data'), 'doc.pdf', 'application/pdf', 48, 100, 5000);
    // advance past each poll interval
    await jest.runAllTimersAsync();
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.share_url).toBe(complete.share_url);
    expect(result.file_id).toBe(complete.file_id);

    jest.useRealTimers();
  });

  it('throws on timeout if encryption never completes', async () => {
    const signed = makeSigned();
    const processing = { status: 'processing', message: 'Encryption in progress' };

    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 202, headers: { get: () => 'application/json' }, json: () => Promise.resolve(signed) })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'text/plain' }, text: () => Promise.resolve('') })
      .mockResolvedValue({ ok: true, status: 202, headers: { get: () => 'application/json' }, json: () => Promise.resolve(processing) });

    jest.useFakeTimers();

    const resultPromise = client.shareAndUploadFile(Buffer.from('data'), 'doc.pdf', 'application/pdf', 48, 100, 300);
    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection warning
    const assertion = expect(resultPromise).rejects.toThrow('Encryption timed out');
    await jest.runAllTimersAsync();
    await assertion;

    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// KonfidantApiError
// ---------------------------------------------------------------------------

describe('KonfidantApiError', () => {
  it('has correct name, status and body', () => {
    const err = new KonfidantApiError('Unauthorized', 401, { error: 'Unauthorized' });
    expect(err.name).toBe('KonfidantApiError');
    expect(err.status).toBe(401);
    expect(err.body).toEqual({ error: 'Unauthorized' });
    expect(err instanceof Error).toBe(true);
  });
});
