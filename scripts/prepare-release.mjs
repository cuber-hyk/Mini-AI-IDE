/** 离线核验发布文件。不会创建 tag、Release、上传文件或读取发布凭据。 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import yaml from 'js-yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function digest(filePath) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('base64');
}

export async function verifyReleaseArtifacts(releaseDir, version) {
  requireCondition(/^\d+\.\d+\.\d+$/.test(version), '只允许发布稳定版本（major.minor.patch）');
  const setupName = `Mini-AI-IDE-Setup-${version}-x64.exe`;
  const portableName = `Mini-AI-IDE-Portable-${version}-x64.exe`;
  const blockmapName = `${setupName}.blockmap`;
  const names = ['latest.yml', setupName, blockmapName, portableName];
  const entries = await readdir(releaseDir);
  const stale = entries.filter((name) => /\.(exe|blockmap)$/.test(name) && !names.includes(name));
  requireCondition(stale.length === 0, `存在其他版本或未知发布产物：${stale.join(', ')}`);
  const metadata = yaml.load(await readFile(path.join(releaseDir, 'latest.yml'), 'utf8'));
  requireCondition(metadata?.version === version, `latest.yml 版本必须为 ${version}`);
  requireCondition(Array.isArray(metadata.files) && metadata.files.length === 1, 'latest.yml 必须仅包含一个 NSIS 安装包');
  const installer = metadata.files[0];
  requireCondition(installer?.url === setupName && metadata.path === setupName, '更新清单必须指向当前版本 NSIS 安装包，不能指向 Portable');

  const files = [];
  for (const name of names) {
    const filePath = path.join(releaseDir, name);
    const fileStat = await stat(filePath);
    requireCondition(fileStat.isFile() && fileStat.size > 0, `发布文件必须为非空普通文件：${name}`);
    files.push({ name, size: fileStat.size, sha512: await digest(filePath) });
  }
  const setup = files.find((file) => file.name === setupName);
  requireCondition(installer.size === setup.size, 'NSIS 安装包大小与 latest.yml 不一致');
  requireCondition(installer.sha512 === setup.sha512 && metadata.sha512 === setup.sha512, 'NSIS 安装包 SHA-512 与 latest.yml 不一致');

  const blockmap = JSON.parse(gunzipSync(await readFile(path.join(releaseDir, blockmapName))).toString('utf8'));
  requireCondition(blockmap.version === '2' && Array.isArray(blockmap.files) && blockmap.files.length === 1, 'NSIS blockmap 结构无效');
  const mappedFile = blockmap.files[0];
  requireCondition(mappedFile.offset === 0 && Array.isArray(mappedFile.sizes) && Array.isArray(mappedFile.checksums), 'NSIS blockmap 文件映射无效');
  requireCondition(mappedFile.sizes.length > 0 && mappedFile.sizes.length === mappedFile.checksums.length && mappedFile.sizes.every((size) => Number.isSafeInteger(size) && size > 0), 'NSIS blockmap 分块无效');
  requireCondition(mappedFile.sizes.reduce((sum, size) => sum + size, 0) === setup.size, 'NSIS blockmap 覆盖大小与安装包不一致');
  return { version, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
    const result = await verifyReleaseArtifacts(path.join(repoRoot, 'release'), packageJson.version);
    console.log(`[prepare-release] v${result.version} 发布产物一致；仅本地校验，未发布：`);
    for (const file of result.files) console.log(`  ${file.name}  ${file.size} bytes  SHA-512=${file.sha512}`);
  } catch (error) {
    console.error(`[prepare-release] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
