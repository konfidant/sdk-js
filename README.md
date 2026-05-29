# @konfidant/sdk

[![Test](https://github.com/konfidant/sdk-js/actions/workflows/test.yml/badge.svg)](https://github.com/konfidant/sdk-js/actions/workflows/test.yml)
[![Codacy Badge](https://app.codacy.com/project/badge/Grade/1ba1a70f10384a8f9a65d4757785b678)](https://app.codacy.com/gh/konfidant/sdk-js/dashboard?utm_source=gh&utm_medium=referral&utm_content=&utm_campaign=Badge_grade)
[![Codacy Badge](https://app.codacy.com/project/badge/Coverage/1ba1a70f10384a8f9a65d4757785b678)](https://app.codacy.com/gh/konfidant/sdk-js/dashboard?utm_source=gh&utm_medium=referral&utm_content=&utm_campaign=Badge_coverage)

Official JavaScript/TypeScript SDK for the [Konfidant](https://www.konfidant.app) API.

Konfidant lets you share secrets — encrypted text and files — that self-destruct after being read.

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

const client = new KonfidantClient({ apiKey: 'your-api-key' });

// Share encrypted text
const { share_url } = await client.shareText({
  text: 'super-secret-password',
  ttl_hours: 24,
});

console.log('Share this link:', share_url);
```

---

## Authentication

All requests require a Bearer API key. Generate one from the Konfidant dashboard.

```ts
const client = new KonfidantClient({
  apiKey: process.env.KONFIDANT_API_KEY!,
});
```

---

## API Reference

### `new KonfidantClient(options)`

| Option    | Type     | Required | Description                                                  |
|-----------|----------|----------|--------------------------------------------------------------|
| `apiKey`  | `string` | Yes      | Your Konfidant API key                                       |
| `baseUrl` | `string` | No       | Override the base URL (default: `https://www.konfidant.app`) |

---

### `client.shareText(request)`

Encrypt and share a text message.

**Request**

| Field       | Type     | Required | Description              |
|-------------|----------|----------|--------------------------|
| `text`      | `string` | Yes      | The secret text to share |
| `ttl_hours` | `number` | Yes      | Time-to-live in hours    |

**Response: `ShareTextResponse`**

| Field          | Type      | Description                              |
|----------------|-----------|------------------------------------------|
| `text_id`      | `string`  | Unique ID of the shared text             |
| `share_url`    | `string`  | One-time download link to send to recipient |
| `expires_at`   | `string`  | Expiry datetime                          |
| `verified_burn`| `boolean` | Whether burn-on-read is verified         |

**Example**

```ts
const result = await client.shareText({
  text: 'db-password: hunter2',
  ttl_hours: 48,
});
// result.share_url → send to recipient
```

---

### `client.shareFile(request)`

Requests a presigned upload URL for a file. Uses the returned URL with `uploadFile()` to complete the upload, then
polls `getFileStatus()` for the share link.

> For a one-call convenience wrapper, see `shareAndUploadFile()`.

**Request**

| Field       | Type     | Required | Description                      |
|-------------|----------|----------|----------------------------------|
| `filename`  | `string` | Yes      | Original filename with extension |
| `file_size` | `number` | Yes      | File size in bytes               |
| `ttl_hours` | `number` | Yes      | Time-to-live in hours            |

**Response: `ShareFileResponse`**

| Field              | Type     | Description                                      |
|--------------------|----------|--------------------------------------------------|
| `upload_url`       | `string` | Short-lived presigned S3 PUT URL                 |
| `file_key`         | `string` | Use with `getFileStatus()` and `uploadFile()`    |
| `poll_url`         | `string` | Convenience URL for status polling               |
| `metadata_headers` | `object` | Required S3 headers — pass to `uploadFile()`     |

---

### `client.uploadFile(options)`

Upload a file to the presigned URL returned by `shareFile()`. Automatically attaches the required S3 metadata headers.

**Options**

| Field                | Type                                  | Required | Description                            |
|----------------------|---------------------------------------|----------|----------------------------------------|
| `file`               | `Blob \| Buffer \| ArrayBuffer`       | Yes      | File content                           |
| `contentType`        | `string`                              | Yes      | MIME type (e.g. `application/pdf`)     |
| `shareFileResponse`  | `ShareFileResponse`                   | Yes      | Full response from `shareFile()`       |

**Example**

```ts
import { readFileSync } from 'fs';

const buf = readFileSync('./report.pdf');

// Step 1 – get presigned URL
const presigned = await client.shareFile({
  filename: 'report.pdf',
  file_size: buf.length,
  ttl_hours: 72,
});

// Step 2 – upload to S3
await client.uploadFile({
  file: buf,
  contentType: 'application/pdf',
  shareFileResponse: presigned,
});

// Step 3 – poll for share link
let status = await client.getFileStatus(presigned.file_key);
while (status.status === 'processing') {
  await new Promise((r) => setTimeout(r, 2000));
  status = await client.getFileStatus(presigned.file_key);
}
console.log('Share URL:', status.share_url);
```

---

### `client.getFileStatus(fileKey)`

Poll the encryption status of an uploaded file.

| Argument  | Type     | Description                                    |
|-----------|----------|------------------------------------------------|
| `fileKey` | `string` | The `file_key` from the `shareFile()` response |

**Returns: `FileStatusResponse`**

While processing:

```ts
{ status: 'processing', message: 'Encryption in progress' }
```

When complete:

```ts
{
  status: 'complete',
  file_id: string,
  file_name: string,
  share_url: string,
  expires_at: string,
  verified_burn: boolean,
}
```

---

### `client.listShares(params?)`

List all shares for the authenticated organization.

**Params (all optional)**

| Field    | Type                     | Description             |
|----------|--------------------------|-------------------------|
| `type`   | `'file' \| 'text'`       | Filter by share type    |
| `status` | `'active' \| 'accessed'` | Filter by share status  |
| `limit`  | `number`                 | Page size (default 50)  |
| `offset` | `number`                 | Pagination offset       |

**Response: `ListSharesResponse`**

```ts
{
  shares: Share[],
  pagination: {
    total: number,
    limit: number,
    offset: number,
    has_more: boolean,
  }
}
```

**Example**

```ts
const { shares, pagination } = await client.listShares({ type: 'file', limit: 10 });
for (const share of shares) {
  console.log(share.file_name, share.created_by, share.expires_at);
}
```

---

### `client.shareAndUploadFile(file, filename, contentType, ttl_hours, pollIntervalMs?, timeoutMs?)`

Convenience method that wraps `shareFile()` → `uploadFile()` → `getFileStatus()` polling in one call.

| Argument         | Type                            | Default  | Description                           |
|------------------|---------------------------------|----------|---------------------------------------|
| `file`           | `Blob \| Buffer \| ArrayBuffer` | —        | File content                          |
| `filename`       | `string`                        | —        | Filename with extension               |
| `contentType`    | `string`                        | —        | MIME type                             |
| `ttl_hours`      | `number`                        | —        | Time-to-live in hours                 |
| `pollIntervalMs` | `number`                        | `2000`   | How often to check status (ms)        |
| `timeoutMs`      | `number`                        | `60000`  | Max time to wait for encryption (ms)  |

**Returns**

```ts
{ share_url: string, file_id: string, expires_at: string, verified_burn: boolean }
```

Throws `Error` with message `Encryption timed out after Xms` if encryption does not complete within `timeoutMs`.

**Example**

```ts
import { readFileSync } from 'fs';

const file = readFileSync('./confidential.zip');

const { share_url } = await client.shareAndUploadFile(
  file,
  'confidential.zip',
  'application/zip',
  48,
);
console.log('Ready to share:', share_url);
```

---

## Error handling

All API errors throw `KonfidantApiError`.

```ts
import { KonfidantApiError } from '@konfidant/sdk';

try {
  await client.shareText({ text: 'secret', ttl_hours: 1 });
} catch (err) {
  if (err instanceof KonfidantApiError) {
    console.error(err.message);  // e.g. "Missing or invalid Authorization header."
    console.error(err.status);   // e.g. 401
    console.error(err.body);     // raw response body
  }
}
```

### Common error codes

| Status | Meaning                    |
|--------|----------------------------|
| `400`  | Bad request / invalid body |
| `401`  | Missing or invalid API key |
| `403`  | Insufficient API key scope |
| `404`  | Resource not found         |

---

## TypeScript

The SDK is written in TypeScript and ships full type definitions. No `@types/*` packages needed.

```ts
import type {
  ShareTextRequest,
  ShareTextResponse,
  ShareFileRequest,
  ShareFileResponse,
  FileStatusResponse,
  FileStatusComplete,
  FileStatusProcessing,
  ListSharesResponse,
  ListSharesParams,
  Share,
} from '@konfidant/sdk';
```

---

## Development

```bash
npm install           # install dependencies
npm test              # run tests (jest)
npm run test:coverage # test + coverage report
npm run build         # compile to dist/
npm run lint          # type-check
```
