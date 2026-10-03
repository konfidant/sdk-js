import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  KNF_HEADER_SIZE,
  KNF_TAG_SIZE,
  KnfDecryptor,
  blobSource,
  buildShareUrl,
  bytesSource,
  ciphertextSize,
  concat,
  decodeKey,
  decodeText,
  decrypt,
  encodeKey,
  encodeMetadata,
  encrypt,
  encryptText,
  generateKey,
  hasValidHeader,
  maxFileCiphertextSize,
  maxTextCiphertextSize,
  parseShareFragment,
} from '../knf';

interface Vector {
  name: string;
  key_hex: string;
  key_b64url: string;
  nonce_prefix_hex: string;
  chunk_size: number;
  kind: 'text' | 'file';
  file_name: string;
  mime: string;
  plaintext_hex: string;
  ciphertext_hex: string;
}

const vectors = (
  JSON.parse(readFileSync(path.join(__dirname, 'fixtures/knf1-test-vectors.json'), 'utf8')) as { vectors: Vector[] }
).vectors;

const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const patterned = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 31) % 256);

describe('KNF1 test vectors', () => {
  it('covers text, empty, multi-chunk and exact-boundary cases', () => {
    expect(vectors.map((vector) => vector.name)).toEqual([
      'text-short',
      'text-empty',
      'file-multi-chunk',
      'file-exact-chunk-boundary',
    ]);
  });

  it.each(vectors.map((vector) => [vector.name, vector] as const))('%s key encodes as base64url', (_, vector) => {
    expect(encodeKey(fromHex(vector.key_hex))).toBe(vector.key_b64url);
  });

  it.each(vectors.map((vector) => [vector.name, vector] as const))('%s encrypts byte-for-byte', async (_, vector) => {
    const parts = await encrypt(
      fromHex(vector.key_hex),
      { kind: vector.kind, name: vector.file_name, mime: vector.mime },
      bytesSource(fromHex(vector.plaintext_hex)),
      { chunkSize: vector.chunk_size, noncePrefix: fromHex(vector.nonce_prefix_hex) }
    );
    expect(toHex(concat(parts))).toBe(vector.ciphertext_hex);
  });

  it.each(vectors.map((vector) => [vector.name, vector] as const))('%s decrypts', async (_, vector) => {
    const result = await decrypt(decodeKey(vector.key_b64url), fromHex(vector.ciphertext_hex));
    expect(result.kind).toBe(vector.kind);
    expect(result.name).toBe(vector.file_name);
    expect(result.mime).toBe(vector.mime);
    expect(toHex(result.data)).toBe(vector.plaintext_hex);
  });
});

describe('encrypt / decrypt', () => {
  it('round-trips text', async () => {
    const key = generateKey();
    const ciphertext = await encryptText(key, 'postgres://user:s3cret@db:5432');
    expect(decodeText(await decrypt(key, ciphertext))).toBe('postgres://user:s3cret@db:5432');
  });

  it('round-trips a multi-chunk file from a Blob', async () => {
    const key = generateKey();
    const content = patterned(50_000);
    const parts = await encrypt(
      key,
      { kind: 'file', name: 'dump.sql', mime: 'application/sql' },
      blobSource(new Blob([content])),
      { chunkSize: 4096 }
    );
    const result = await decrypt(key, concat(parts));
    expect(result).toMatchObject({ kind: 'file', name: 'dump.sql', mime: 'application/sql' });
    expect(result.data).toEqual(content);
  });

  it('produces exactly the predicted ciphertext size', async () => {
    const key = generateKey();
    for (const length of [0, 1, 4096, 4096 * 3 - 20, 12_345]) {
      const metadata = { kind: 'file' as const, name: 'x.txt', mime: 'text/plain' };
      const parts = await encrypt(key, metadata, bytesSource(patterned(length)), { chunkSize: 4096 });
      expect(concat(parts).length).toBe(ciphertextSize(encodeMetadata(metadata).length, length, 4096));
    }
  });

  it('uses a fresh nonce prefix for every encryption', async () => {
    const key = generateKey();
    const a = await encryptText(key, 'same');
    const b = await encryptText(key, 'same');
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it('decrypts when bytes arrive in arbitrary slices', async () => {
    const key = generateKey();
    const content = patterned(20_000);
    const ciphertext = concat(
      await encrypt(key, { kind: 'file', name: 'f', mime: '' }, bytesSource(content), { chunkSize: 4096 })
    );
    const decryptor = new KnfDecryptor(key);
    for (let offset = 0; offset < ciphertext.length; offset += 777) {
      await decryptor.push(ciphertext.subarray(offset, offset + 777));
    }
    expect((await decryptor.finish()).data).toEqual(content);
  });
});

describe('tamper resistance', () => {
  const sealedChunk = 4096 + KNF_TAG_SIZE;

  async function multiChunk() {
    const key = generateKey();
    const ciphertext = concat(
      await encrypt(key, { kind: 'file', name: 'f', mime: '' }, bytesSource(patterned(10_000)), { chunkSize: 4096 })
    );
    return { key, ciphertext };
  }

  it('rejects the wrong key', async () => {
    const { ciphertext } = await multiChunk();
    await expect(decrypt(generateKey(), ciphertext)).rejects.toThrow('Decryption failed');
  });

  it('rejects ciphertext truncated at a chunk boundary', async () => {
    const { key, ciphertext } = await multiChunk();
    await expect(decrypt(key, ciphertext.subarray(0, KNF_HEADER_SIZE + 2 * sealedChunk))).rejects.toThrow(
      'Decryption failed'
    );
  });

  it('rejects reordered chunks', async () => {
    const { key, ciphertext } = await multiChunk();
    const header = ciphertext.subarray(0, KNF_HEADER_SIZE);
    const first = ciphertext.subarray(KNF_HEADER_SIZE, KNF_HEADER_SIZE + sealedChunk);
    const second = ciphertext.subarray(KNF_HEADER_SIZE + sealedChunk, KNF_HEADER_SIZE + 2 * sealedChunk);
    const rest = ciphertext.subarray(KNF_HEADER_SIZE + 2 * sealedChunk);
    await expect(decrypt(key, concat([header, second, first, rest]))).rejects.toThrow('Decryption failed');
  });

  it('rejects a modified header', async () => {
    const { key, ciphertext } = await multiChunk();
    const tampered = new Uint8Array(ciphertext);
    tampered[9] ^= 0xff;
    await expect(decrypt(key, tampered)).rejects.toThrow('Decryption failed');
  });

  it('rejects a flipped ciphertext bit', async () => {
    const { key, ciphertext } = await multiChunk();
    const tampered = new Uint8Array(ciphertext);
    tampered[KNF_HEADER_SIZE + 100] ^= 0x01;
    await expect(decrypt(key, tampered)).rejects.toThrow('Decryption failed');
  });

  it('rejects payloads that are not KNF1', async () => {
    await expect(decrypt(generateKey(), patterned(100))).rejects.toThrow('Not a KNF1 payload');
  });
});

describe('metadata limits', () => {
  it('rejects names longer than 1024 bytes and MIME types longer than 255 bytes', () => {
    expect(() => encodeMetadata({ kind: 'file', name: 'a'.repeat(1025), mime: '' })).toThrow('File name');
    expect(() => encodeMetadata({ kind: 'file', name: '', mime: 'a'.repeat(256) })).toThrow('MIME type');
  });

  it('rejects a name on text shares', () => {
    expect(() => encodeMetadata({ kind: 'text', name: 'x', mime: '' })).toThrow('Text shares');
  });

  it('computes server-side upper bounds', () => {
    expect(maxTextCiphertextSize(10 * 1024)).toBe(16 + 4 + 5 + 10 * 1024 + 16);
    expect(maxFileCiphertextSize(5 * 1024 * 1024)).toBe(16 + 4 + 1284 + 5 * 1024 * 1024 + 16 * 6);
  });
});

describe('header and link helpers', () => {
  it('validates the plaintext header', async () => {
    expect(hasValidHeader(await encryptText(generateKey(), 'x'))).toBe(true);
    expect(hasValidHeader(patterned(64))).toBe(false);
  });

  it('round-trips keys as 43-character base64url', () => {
    const key = generateKey();
    const encoded = encodeKey(key);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(decodeKey(encoded)).toEqual(key);
    expect(() => decodeKey('short')).toThrow('Invalid key encoding');
  });

  it('builds and parses share links with token and key in the fragment', () => {
    const key = generateKey();
    const url = buildShareUrl('https://download.konfidant.app/#t=hvs.CAES%2Babc', key);
    const parsed = parseShareFragment(new URL(url).hash);
    expect(parsed?.token).toBe('hvs.CAES+abc');
    expect(parsed?.key).toEqual(key);
    expect(parseShareFragment('#t=abc')).toBeNull();
    expect(parseShareFragment('#t=abc&k=invalid')).toBeNull();
  });
});
