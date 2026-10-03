// KNF1 — Konfidant client-side encryption format (see "Encryption format" in README.md). Kept byte-for-byte
// compatible with the reference implementation used by the Konfidant web app.
//
// Isomorphic (browser + Node 20+): uses only WebCrypto. Content is encrypted on the sender's device with a random
// 256-bit key that travels in the share link's URL fragment, so the server only ever handles ciphertext.

export const KNF_MAGIC = [0x4b, 0x4e, 0x46, 0x31] as const; // "KNF1"
export const KNF_HEADER_SIZE = 16;
export const KNF_TAG_SIZE = 16;
export const KNF_KEY_SIZE = 32;
export const KNF_NONCE_PREFIX_SIZE = 7;
export const KNF_DEFAULT_CHUNK_SIZE = 1024 * 1024;
export const KNF_MIN_CHUNK_SIZE = 4096;
export const KNF_MAX_CHUNK_SIZE = 16 * 1024 * 1024;
export const KNF_MAX_NAME_BYTES = 1024;
export const KNF_MAX_MIME_BYTES = 255;

const KIND_TEXT = 1;
const KIND_FILE = 2;
const META_FIXED_SIZE = 5; // kind (1) + name length (2) + mime length (2)
const META_LENGTH_PREFIX = 4;

export type KnfKind = 'text' | 'file';

export interface KnfMetadata {
  kind: KnfKind;
  /** Original file name (files only). */
  name: string;
  /** MIME type (files only). */
  mime: string;
}

export interface KnfDecrypted extends KnfMetadata {
  data: Uint8Array<ArrayBuffer>;
}

/** Random-access source of content bytes, so large browser files can be encrypted slice by slice. */
export interface KnfSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export class KnfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnfError';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function subtle(): SubtleCrypto {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) {
    throw new KnfError('WebCrypto is not available in this environment');
  }
  return crypto.subtle;
}

export function generateKey(): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(KNF_KEY_SIZE));
}

export function encodeKey(key: Uint8Array): string {
  let binary = '';
  for (const byte of key) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeKey(encoded: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new KnfError('Invalid key encoding');
  }
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '=');
  const key = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) key[i] = binary.charCodeAt(i);
  if (key.length !== KNF_KEY_SIZE) throw new KnfError('Invalid key length');
  return key;
}

export function encodeMetadata(metadata: KnfMetadata): Uint8Array<ArrayBuffer> {
  const name = encoder.encode(metadata.name);
  const mime = encoder.encode(metadata.mime);
  if (metadata.kind === 'text' && (name.length > 0 || mime.length > 0)) {
    throw new KnfError('Text shares must not carry a name or MIME type');
  }
  if (name.length > KNF_MAX_NAME_BYTES) throw new KnfError(`File name exceeds ${KNF_MAX_NAME_BYTES} bytes`);
  if (mime.length > KNF_MAX_MIME_BYTES) throw new KnfError(`MIME type exceeds ${KNF_MAX_MIME_BYTES} bytes`);

  const out = new Uint8Array(META_FIXED_SIZE + name.length + mime.length);
  const view = new DataView(out.buffer);
  out[0] = metadata.kind === 'text' ? KIND_TEXT : KIND_FILE;
  view.setUint16(1, name.length);
  out.set(name, 3);
  view.setUint16(3 + name.length, mime.length);
  out.set(mime, 5 + name.length);
  return out;
}

function decodeMetadata(bytes: Uint8Array): KnfMetadata {
  if (bytes.length < META_FIXED_SIZE) throw new KnfError('Metadata truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kindByte = bytes[0];
  if (kindByte !== KIND_TEXT && kindByte !== KIND_FILE) throw new KnfError('Unknown content kind');
  const nameLength = view.getUint16(1);
  if (3 + nameLength + 2 > bytes.length) throw new KnfError('Metadata truncated');
  const mimeLength = view.getUint16(3 + nameLength);
  if (META_FIXED_SIZE + nameLength + mimeLength !== bytes.length) throw new KnfError('Metadata length mismatch');
  return {
    kind: kindByte === KIND_TEXT ? 'text' : 'file',
    name: decoder.decode(bytes.subarray(3, 3 + nameLength)),
    mime: decoder.decode(bytes.subarray(5 + nameLength)),
  };
}

/** Exact ciphertext size for a given metadata length and content length. */
export function ciphertextSize(
  metadataLength: number,
  contentLength: number,
  chunkSize: number = KNF_DEFAULT_CHUNK_SIZE
): number {
  const streamLength = META_LENGTH_PREFIX + metadataLength + contentLength;
  return KNF_HEADER_SIZE + streamLength + KNF_TAG_SIZE * Math.ceil(streamLength / chunkSize);
}

/** Largest ciphertext a file share of at most `maxContentBytes` can produce (longest name and MIME type). */
export function maxFileCiphertextSize(maxContentBytes: number): number {
  return ciphertextSize(META_FIXED_SIZE + KNF_MAX_NAME_BYTES + KNF_MAX_MIME_BYTES, maxContentBytes);
}

/** Largest ciphertext a text share of at most `maxTextBytes` UTF-8 bytes can produce. */
export function maxTextCiphertextSize(maxTextBytes: number): number {
  return ciphertextSize(META_FIXED_SIZE, maxTextBytes);
}

/** Checks the plaintext header of a KNF1 payload; the server uses this to reject non-KNF uploads early. */
export function hasValidHeader(bytes: Uint8Array): boolean {
  if (bytes.length < KNF_HEADER_SIZE + KNF_TAG_SIZE) return false;
  if (!KNF_MAGIC.every((byte, i) => bytes[i] === byte)) return false;
  const chunkSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
  return chunkSize >= KNF_MIN_CHUNK_SIZE && chunkSize <= KNF_MAX_CHUNK_SIZE && bytes[15] === 0;
}

function buildHeader(chunkSize: number, noncePrefix: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(KNF_HEADER_SIZE);
  header.set(KNF_MAGIC, 0);
  new DataView(header.buffer).setUint32(4, chunkSize);
  header.set(noncePrefix, 8);
  header[15] = 0;
  return header;
}

function chunkNonce(noncePrefix: Uint8Array, index: number, last: boolean): Uint8Array<ArrayBuffer> {
  if (index > 0xffffffff) throw new KnfError('Too many chunks');
  const nonce = new Uint8Array(12);
  nonce.set(noncePrefix, 0);
  new DataView(nonce.buffer).setUint32(7, index);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

async function importKey(key: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (key.length !== KNF_KEY_SIZE) throw new KnfError('Key must be 32 bytes');
  return subtle().importKey('raw', new Uint8Array(key), { name: 'AES-GCM' }, false, [usage]);
}

function copy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

export function bytesSource(bytes: Uint8Array): KnfSource {
  return { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) };
}

export function blobSource(blob: Blob): KnfSource {
  return {
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  };
}

export interface EncryptOptions {
  chunkSize?: number;
  /** Test vectors only: fixed nonce prefix. Never pass in production. */
  noncePrefix?: Uint8Array;
}

/**
 * Encrypts `source` with `metadata` into KNF1 parts (header + one part per chunk).
 * Concatenate the parts (or wrap them in a Blob) to obtain the ciphertext.
 */
export async function encrypt(
  key: Uint8Array,
  metadata: KnfMetadata,
  source: KnfSource,
  options: EncryptOptions = {}
): Promise<Uint8Array<ArrayBuffer>[]> {
  const chunkSize = options.chunkSize ?? KNF_DEFAULT_CHUNK_SIZE;
  if (chunkSize < KNF_MIN_CHUNK_SIZE || chunkSize > KNF_MAX_CHUNK_SIZE) throw new KnfError('Invalid chunk size');
  const noncePrefix = options.noncePrefix
    ? copy(options.noncePrefix)
    : globalThis.crypto.getRandomValues(new Uint8Array(KNF_NONCE_PREFIX_SIZE));
  if (noncePrefix.length !== KNF_NONCE_PREFIX_SIZE) throw new KnfError('Nonce prefix must be 7 bytes');

  const meta = encodeMetadata(metadata);
  const prefix = new Uint8Array(META_LENGTH_PREFIX + meta.length);
  new DataView(prefix.buffer).setUint32(0, meta.length);
  prefix.set(meta, META_LENGTH_PREFIX);

  const header = buildHeader(chunkSize, noncePrefix);
  const cryptoKey = await importKey(key, 'encrypt');
  const streamLength = prefix.length + source.size;
  const chunkCount = Math.ceil(streamLength / chunkSize);
  const parts: Uint8Array<ArrayBuffer>[] = [header];

  for (let index = 0; index < chunkCount; index++) {
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, streamLength);
    const chunk = new Uint8Array(end - start);
    // The stream is the metadata prefix followed by the content; a chunk may span both.
    if (start < prefix.length) chunk.set(prefix.subarray(start, Math.min(end, prefix.length)), 0);
    const contentStart = Math.max(start, prefix.length) - prefix.length;
    const contentEnd = end - prefix.length;
    if (contentEnd > contentStart) {
      chunk.set(await source.read(contentStart, contentEnd - contentStart), Math.max(prefix.length - start, 0));
    }
    const sealed = await subtle().encrypt(
      { name: 'AES-GCM', iv: chunkNonce(noncePrefix, index, index === chunkCount - 1), additionalData: header },
      cryptoKey,
      chunk
    );
    parts.push(new Uint8Array(sealed));
  }
  return parts;
}

export async function encryptText(key: Uint8Array, text: string, options?: EncryptOptions) {
  return concat(await encrypt(key, { kind: 'text', name: '', mime: '' }, bytesSource(encoder.encode(text)), options));
}

export function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Incremental decryptor for streamed downloads: `push()` bytes as they arrive, then `finish()`.
 * A full-size chunk is only decrypted once more data arrives, because the final chunk is authenticated
 * with the "last" flag — this is what detects truncated ciphertext.
 */
export class KnfDecryptor {
  private cryptoKey: Promise<CryptoKey>;
  private header: Uint8Array<ArrayBuffer> | null = null;
  private chunkSize = 0;
  private buffer = new Uint8Array(0);
  private index = 0;
  private plaintext: Uint8Array<ArrayBuffer>[] = [];
  private metadata: KnfMetadata | null = null;
  private finished = false;

  constructor(key: Uint8Array) {
    this.cryptoKey = importKey(key, 'decrypt');
  }

  async push(bytes: Uint8Array): Promise<void> {
    if (this.finished) throw new KnfError('Decryptor already finished');
    this.buffer = concat([this.buffer, bytes]);

    if (!this.header) {
      if (this.buffer.length < KNF_HEADER_SIZE) return;
      const header = this.buffer.slice(0, KNF_HEADER_SIZE);
      if (!KNF_MAGIC.every((byte, i) => header[i] === byte) || header[15] !== 0) {
        throw new KnfError('Not a KNF1 payload');
      }
      this.chunkSize = new DataView(header.buffer).getUint32(4);
      if (this.chunkSize < KNF_MIN_CHUNK_SIZE || this.chunkSize > KNF_MAX_CHUNK_SIZE) {
        throw new KnfError('Invalid chunk size');
      }
      this.header = header;
      this.buffer = this.buffer.slice(KNF_HEADER_SIZE);
    }

    const sealedChunkSize = this.chunkSize + KNF_TAG_SIZE;
    // Keep at least one byte beyond a full chunk before decrypting it as non-final.
    while (this.buffer.length > sealedChunkSize) {
      await this.open(this.buffer.subarray(0, sealedChunkSize), false);
      this.buffer = this.buffer.slice(sealedChunkSize);
    }
  }

  async finish(): Promise<KnfDecrypted> {
    if (this.finished) throw new KnfError('Decryptor already finished');
    if (!this.header) throw new KnfError('Ciphertext truncated');
    if (this.buffer.length <= KNF_TAG_SIZE) throw new KnfError('Ciphertext truncated');
    await this.open(this.buffer, true);
    this.finished = true;
    this.buffer = new Uint8Array(0);

    const stream = concat(this.plaintext);
    this.plaintext = [];
    const view = new DataView(stream.buffer);
    if (stream.length < META_LENGTH_PREFIX) throw new KnfError('Metadata truncated');
    const metaLength = view.getUint32(0);
    if (META_LENGTH_PREFIX + metaLength > stream.length) throw new KnfError('Metadata truncated');
    this.metadata = decodeMetadata(stream.subarray(META_LENGTH_PREFIX, META_LENGTH_PREFIX + metaLength));
    return { ...this.metadata, data: stream.slice(META_LENGTH_PREFIX + metaLength) };
  }

  private async open(sealed: Uint8Array, last: boolean): Promise<void> {
    const header = this.header as Uint8Array<ArrayBuffer>;
    try {
      const opened = await subtle().decrypt(
        { name: 'AES-GCM', iv: chunkNonce(header.subarray(8, 15), this.index, last), additionalData: header },
        await this.cryptoKey,
        copy(sealed)
      );
      this.plaintext.push(new Uint8Array(opened));
      this.index++;
    } catch {
      throw new KnfError('Decryption failed: wrong key or corrupted or truncated ciphertext');
    }
  }
}

export async function decrypt(key: Uint8Array, ciphertext: Uint8Array): Promise<KnfDecrypted> {
  const decryptor = new KnfDecryptor(key);
  await decryptor.push(ciphertext);
  return decryptor.finish();
}

export function decodeText(decrypted: KnfDecrypted): string {
  if (decrypted.kind !== 'text') throw new KnfError('Share is not a text share');
  return decoder.decode(decrypted.data);
}

/** Builds the share link: the server-issued download URL (carrying `#t=`) plus the key, both in the fragment. */
export function buildShareUrl(downloadUrl: string, key: Uint8Array): string {
  return `${downloadUrl}&k=${encodeKey(key)}`;
}

/** Parses `#t=<token>&k=<key>` from a URL fragment. */
export function parseShareFragment(hash: string): { token: string; key: Uint8Array<ArrayBuffer> } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const token = params.get('t');
  const encodedKey = params.get('k');
  if (!token || !encodedKey) return null;
  try {
    return { token, key: decodeKey(encodedKey) };
  } catch {
    return null;
  }
}
