# @konfidant/sdk

[![Test](https://github.com/konfidant/sdk-js/actions/workflows/test.yml/badge.svg)](https://github.com/konfidant/sdk-js/actions/workflows/test.yml)
[![Codacy Badge](https://app.codacy.com/project/badge/Grade/1ba1a70f10384a8f9a65d4757785b678)](https://app.codacy.com/gh/konfidant/sdk-js/dashboard?utm_source=gh&utm_medium=referral&utm_content=&utm_campaign=Badge_grade)
[![Codacy Badge](https://app.codacy.com/project/badge/Coverage/1ba1a70f10384a8f9a65d4757785b678)](https://app.codacy.com/gh/konfidant/sdk-js/dashboard?utm_source=gh&utm_medium=referral&utm_content=&utm_campaign=Badge_coverage)

Official JavaScript/TypeScript SDK for the [Konfidant](https://www.konfidant.app) API.

Konfidant lets you share secrets — text and files — through one-time links that self-destruct after being read.
The SDK **encrypts everything on your machine** before it is sent: Konfidant only ever stores and delivers
ciphertext and cannot read what you share.

- Zero runtime dependencies; uses the standard WebCrypto API.
- Works in Node.js 20+ and modern browsers (ESM and CommonJS builds, full TypeScript types).

---

## Installation

```bash
npm install @konfidant/sdk
# or
yarn add @konfidant/sdk
# or
pnpm add @konfidant/sdk
```

---

## Quick start

```ts
import { KonfidantClient } from '@konfidant/sdk';

const client = new KonfidantClient({ apiKey: process.env.KONFIDANT_API_KEY! });

const { shareUrl } = await client.shareText('db-password: hunter2', { ttlHours: 24 });

console.log('Send this link:', shareUrl);
// https://download.konfidant.app/#t=<one-time token>&k=<decryption key>
```

---

## Security model (zero-knowledge)

1. For every share the SDK generates a fresh random 256-bit key and encrypts the content locally with AES-256-GCM
   (the [KNF1 format](#encryption-format-knf1)). For files, the file name and MIME type are encrypted too.
2. Only the ciphertext is sent to Konfidant. The API responds with a `download_url` containing a server-issued,
   single-use token in the URL fragment (`#t=…`).
3. The SDK appends the key to the fragment: `shareUrl = download_url + "&k=" + base64url(key)`.

The URL **fragment** (everything after `#`) is never sent to any server by browsers or by this SDK. The key
therefore exists only in the share link: it is never sent to Konfidant, never logged by Konfidant and cannot be
recovered by Konfidant. The recipient's browser (or `openShare()`) sends only the token, receives the ciphertext
once — after which it is deleted — and decrypts it locally.

Consequences:

- **Treat `shareUrl` as the secret.** Anyone holding the full link can open it once. Do not log it.
- If the link is lost, the content cannot be recovered — not even by Konfidant.
- Konfidant learns only the ciphertext size and when the share was created and opened.
- The API key is sent only to the API base URL — never to the storage upload URL or to download hosts.

---

## Authentication

All API requests use a Bearer API key. Generate one in the Konfidant dashboard.

```ts
const client = new KonfidantClient({
  apiKey: process.env.KONFIDANT_API_KEY!,
});
```

Opening a share (`openShare()`) needs no API key: the link alone grants one-time access.

---

## API reference

### `new KonfidantClient(options)`

| Option    | Type     | Required | Description                                                  |
|-----------|----------|----------|--------------------------------------------------------------|
| `apiKey`  | `string` | Yes      | Your Konfidant API key                                       |
| `baseUrl` | `string` | No       | Override the API base URL (default: `https://www.konfidant.app`) |

---

### `client.shareText(text, options?)`

Encrypts `text` locally and creates a one-time text share.

| Option     | Type     | Default | Description           |
|------------|----------|---------|-----------------------|
| `ttlHours` | `number` | plan maximum | Time-to-live in hours (omitted → server uses your plan's maximum) |

**Returns `ShareTextResult`**

| Field       | Type             | Description                                                        |
|-------------|------------------|--------------------------------------------------------------------|
| `shareUrl`  | `string`         | One-time link (token + key in the fragment) to send to the recipient |
| `textId`    | `string \| null` | Share ID (only when verified burn is enabled for the organization) |
| `expiresAt` | `string`         | ISO 8601 expiry timestamp                                          |

```ts
const { shareUrl, expiresAt } = await client.shareText('API_TOKEN=sk_live_…', { ttlHours: 48 });
```

---

### `client.shareFile(data, options)`

Encrypts a file locally (content, file name and MIME type) and shares it: creates an upload slot, uploads the
ciphertext straight to storage and completes the share.

| Argument / option     | Type                                         | Required | Description                                                   |
|-----------------------|----------------------------------------------|----------|---------------------------------------------------------------|
| `data`                | `Blob \| ArrayBuffer \| Uint8Array \| Buffer` | Yes      | File content                                                  |
| `options.filename`    | `string`                                     | Yes      | Original file name (encrypted; at most 1024 UTF-8 bytes)      |
| `options.contentType` | `string`                                     | No       | MIME type (encrypted; defaults to the Blob's type, or empty)  |
| `options.ttlHours`    | `number`                                     | No       | Time-to-live in hours (default `8`)                           |

**Returns `ShareFileResult`**

| Field          | Type             | Description                                                        |
|----------------|------------------|--------------------------------------------------------------------|
| `shareUrl`     | `string`         | One-time link (token + key in the fragment)                        |
| `fileId`       | `string \| null` | Share ID (only when verified burn is enabled)                      |
| `expiresAt`    | `string`         | ISO 8601 expiry timestamp                                          |
| `verifiedBurn` | `boolean`        | Whether verified burn is enabled for the organization             |

```ts
import { readFile } from 'node:fs/promises';

const { shareUrl } = await client.shareFile(await readFile('./report.pdf'), {
  filename: 'report.pdf',
  contentType: 'application/pdf',
  ttlHours: 72,
});
```

In the browser, pass a `File` directly: `client.shareFile(file, { filename: file.name })`.

The ciphertext is slightly larger than the file (16 bytes per MiB plus the encrypted name and MIME type); the server
allows for this overhead when applying the plan's file size limit.

---

### `client.openShare(shareUrl)` / `openShare(shareUrl)`

Downloads and decrypts a share link. This **consumes** the share: a second call fails with HTTP `410`. Only the
token is sent (`POST <link origin>/api/download`), never the key or your API key. Works with
`download.konfidant.app` and custom download domains. The standalone `openShare` export needs no client.

**Returns `OpenedShare`**

| Field  | Type                 | Description                                  |
|--------|----------------------|----------------------------------------------|
| `kind` | `'text' \| 'file'`   | Share type                                   |
| `name` | `string`             | Original file name (empty for text)          |
| `mime` | `string`             | MIME type (empty for text; may be empty)     |
| `data` | `Uint8Array`         | Decrypted content                            |
| `text` | `string \| undefined` | Decoded UTF-8 text (text shares only)        |

```ts
import { openShare } from '@konfidant/sdk';

const share = await openShare(link);
if (share.kind === 'text') console.log(share.text);
else await writeFile(share.name, share.data);
```

Throws `KnfError` for malformed links, the wrong key, or tampered or truncated ciphertext.

---

### `client.listShares(params?)`

Lists shares of the authenticated organization. Only metadata is returned — no content, names or keys.

| Param    | Type                     | Description            |
|----------|--------------------------|------------------------|
| `type`   | `'file' \| 'text'`       | Filter by share type   |
| `status` | `'active' \| 'accessed'` | Filter by share status |
| `limit`  | `number`                 | Page size (default 50) |
| `offset` | `number`                 | Pagination offset      |

```ts
const { shares, pagination } = await client.listShares({ type: 'file', limit: 10 });
// shares[i]: { type, file_size_bytes, created_at, expires_at, accessed_at, created_by }
```

---

### Low-level file upload

`shareFile()` is built from three calls you can use directly, for example to encrypt in a worker or to retry the
upload step yourself.

```ts
import { KonfidantClient, bytesSource, buildShareUrl, concat, encrypt, generateKey } from '@konfidant/sdk';

const key = generateKey();
const ciphertext = concat(
  await encrypt(key, { kind: 'file', name: 'dump.sql', mime: 'application/sql' }, bytesSource(bytes)),
);

const upload = await client.createFileUpload(ciphertext.length, 24); // POST /api/v1/files
await client.uploadCiphertext(upload, ciphertext);                     // PUT to upload.uploadUrl
const done = await client.completeFileUpload(upload.fileKey);          // POST /api/v1/files/{key}/complete

const shareUrl = buildShareUrl(done.downloadUrl, key);
```

| Method                                         | Description                                                                                   |
|------------------------------------------------|-----------------------------------------------------------------------------------------------|
| `createFileUpload(ciphertextSize, ttlHours?)`  | Reserves an upload slot. Returns `{ uploadUrl, fileKey, uploadHeaders, uploadExpiresIn, ciphertextSize }` |
| `uploadCiphertext(upload, ciphertext)`         | PUTs a `Uint8Array` or `Blob` with exactly `uploadHeaders`. Size must equal `ciphertextSize`; no API key is sent |
| `completeFileUpload(fileKey)`                  | Finalizes the share. Returns `{ downloadUrl, fileId, expiresAt, verifiedBurn }`. `409 upload_incomplete` if not uploaded |

---

### Encryption primitives

The KNF1 implementation is exported for advanced use: `generateKey`, `encodeKey`, `decodeKey`, `encrypt`,
`encryptText`, `decrypt`, `decodeText`, `KnfDecryptor` (incremental decryption of streamed downloads),
`bytesSource`, `blobSource`, `concat`, `ciphertextSize`, `maxFileCiphertextSize`, `maxTextCiphertextSize`,
`encodeMetadata`, `hasValidHeader`, `buildShareUrl`, `parseShareFragment`, `KnfError` and the `KNF_*` constants.

---

## Encryption format (KNF1)

```
ciphertext = header (16 bytes) || sealed_chunk_0 || … || sealed_chunk_n
header     = "KNF1" || uint32_be(chunk_size) || nonce_prefix (7 random bytes) || 0x00
stream     = uint32_be(len(meta)) || meta || content     ; split into chunk_size pieces (default 1 MiB)
meta       = kind (1 = text, 2 = file) || uint16_be(len(name)) || name || uint16_be(len(mime)) || mime
nonce_i    = nonce_prefix || uint32_be(i) || last_flag (1 for the final chunk, else 0)
sealed_i   = AES-256-GCM(key, nonce_i, chunk_i, aad = header)   ; ciphertext || 16-byte tag
```

The per-chunk nonce (STREAM construction) prevents reordering, duplication and truncation; any authentication
failure aborts decryption. Ciphertext size: `16 + S + 16 × ceil(S / chunk_size)`, with `S = 4 + len(meta) +
len(content)`. The SDK's test suite reproduces the official KNF1 test vectors byte-for-byte.

Share link: `https://<download host>/#t=<urlencoded token>&k=<unpadded base64url key, 43 chars>`.

---

## Error handling

API and HTTP errors throw `KonfidantApiError`; encryption and link errors throw `KnfError`.

```ts
import { KonfidantApiError, KnfError } from '@konfidant/sdk';

try {
  await client.shareText('secret', { ttlHours: 1 });
} catch (err) {
  if (err instanceof KonfidantApiError) {
    console.error(err.status);  // e.g. 401
    console.error(err.code);    // the response's `error` field, e.g. "upload_incomplete"
    console.error(err.message); // the response's `message`, else `error`
    console.error(err.body);    // raw response body
  } else if (err instanceof KnfError) {
    console.error(err.message); // e.g. "Decryption failed: wrong key or corrupted or truncated ciphertext"
  }
}
```

| Status | Meaning                                              |
|--------|------------------------------------------------------|
| `400`  | Bad request / invalid body / TTL above plan maximum  |
| `401`  | Missing or invalid API key                           |
| `403`  | Insufficient API key scope                           |
| `404`  | Resource not found                                   |
| `409`  | `upload_incomplete`: ciphertext not uploaded yet     |
| `410`  | Share already opened or expired (`openShare`)        |
| `429`  | Rate limit exceeded                                  |

---

## Development

```bash
npm install           # install dependencies
npm test              # run tests (jest)
npm run test:coverage # test + coverage report
npm run build         # compile to dist/
npm run lint          # type-check
```
