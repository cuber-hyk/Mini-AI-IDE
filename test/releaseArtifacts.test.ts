import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

async function verifyReleaseArtifacts(dir: string, version: string) {
  const verifier = await import('../scripts/prepare-release.mjs');
  return verifier.verifyReleaseArtifacts(dir, version);
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mini-ai-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const setupName = 'Mini-AI-IDE-Setup-0.1.0-x64.exe';
  const data = Buffer.from('installer');
  const sha512 = createHash('sha512').update(data).digest('base64');
  const metadata = {
    version: '0.1.0',
    files: [{ url: setupName, size: data.length, sha512 }],
    path: setupName,
    sha512,
  };
  await writeFile(path.join(dir, setupName), data);
  await writeFile(path.join(dir, 'Mini-AI-IDE-Portable-0.1.0-x64.exe'), 'portable');
  await writeFile(path.join(dir, `${setupName}.blockmap`), gzipSync(JSON.stringify({ version: '2', files: [{ offset: 0, sizes: [data.length], checksums: ['chunk-checksum'] }] })));
  const saveMetadata = () => writeFile(path.join(dir, 'latest.yml'), JSON.stringify(metadata));
  await saveMetadata();
  return { dir, metadata, setupName, saveMetadata };
}

test('发布准备仅接受同版本 NSIS 更新清单与匹配产物', async (t) => {
  const { dir } = await fixture(t);
  const result = await verifyReleaseArtifacts(dir, '0.1.0');
  assert.equal(result.version, '0.1.0');
  assert.equal(result.files.length, 4);
});

test('拒绝把 Portable 混进安装版更新清单', async (t) => {
  const { dir, metadata, saveMetadata } = await fixture(t);
  metadata.files.push({ url: 'Mini-AI-IDE-Portable-0.1.0-x64.exe', size: 8, sha512: 'hash' });
  await saveMetadata();
  await assert.rejects(verifyReleaseArtifacts(dir, '0.1.0'), /仅包含一个 NSIS/);
});

test('拒绝损坏或被替换的安装包', async (t) => {
  const { dir, setupName } = await fixture(t);
  await writeFile(path.join(dir, setupName), 'tampering');
  await assert.rejects(verifyReleaseArtifacts(dir, '0.1.0'), /SHA-512/);
});

test('拒绝旧版本清单和残留旧安装包', async (t) => {
  const { dir, metadata, saveMetadata } = await fixture(t);
  metadata.version = '0.0.9';
  await saveMetadata();
  await assert.rejects(verifyReleaseArtifacts(dir, '0.1.0'), /版本必须/);
  metadata.version = '0.1.0';
  await saveMetadata();
  await writeFile(path.join(dir, 'Mini-AI-IDE-Setup-0.0.9-x64.exe'), 'old');
  await assert.rejects(verifyReleaseArtifacts(dir, '0.1.0'), /其他版本/);
});

test('拒绝未覆盖完整安装包的 blockmap', async (t) => {
  const { dir, setupName } = await fixture(t);
  await writeFile(path.join(dir, `${setupName}.blockmap`), gzipSync(JSON.stringify({ version: '2', files: [{ offset: 0, sizes: [1], checksums: ['checksum'] }] })));
  await assert.rejects(verifyReleaseArtifacts(dir, '0.1.0'), /覆盖大小/);
});
