/** 真实磁盘目录列举测量；夹具只存在于本次独立临时目录。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { FileService } from '../src/main/fileService';
import type { DirEntry } from '../src/shared/contract';
import { isProbablyTextFile } from '../src/shared/limits';
import { DEFAULT_LIST_POLICY, filterAndSortEntries, type DirEntryLike } from '../src/shared/pathGuard';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const median = (values: number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;
const sourcePath = path.resolve('src/main/fileService.ts');
const output = path.resolve(process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length) ?? path.join(os.tmpdir(), 'mini-directory-list-measure.json'));

interface Sample {
  sample: number;
  elapsedMs: number;
  resolveCalls: number;
  peakInFlight: number;
  outputHash: string;
}

async function main(): Promise<void> {
  const sourceHash = digest(await fs.readFile(sourcePath, 'utf8'));
  const temporaryParent = await fs.realpath(os.tmpdir());
  const temporary = await fs.mkdtemp(path.join(temporaryParent, 'mini-directory-list-measure-'));
  const cases: Array<{ size: number; depth: number; entries: DirEntry[]; truncated: boolean; samples: Sample[]; medianMs: number }> = [];
  try {
    for (const size of [10, 100, 500, 600]) {
      for (const depth of [0, 5]) {
        const root = path.join(temporary, `size-${size}-depth-${depth}`);
        const relative = Array.from({ length: depth }, (_, index) => `level-${index + 1}`).join('/');
        const directory = path.join(root, relative);
        await fs.mkdir(directory, { recursive: true });
        const fixture: DirEntryLike[] = Array.from({ length: size }, (_, index) => ({
          name: index === 0 ? '.editorconfig' : `${index % 5 === 0 ? 'directory' : 'file'}-${String(index).padStart(4, '0')}${index % 5 === 0 ? '' : index % 2 === 0 ? '.txt' : '.png'}`,
          isDirectory: index !== 0 && index % 5 === 0,
        }));
        fixture.push({ name: '.git', isDirectory: true }, { name: 'node_modules', isDirectory: true });
        for (const entry of fixture) {
          const target = path.join(directory, entry.name);
          if (entry.isDirectory) await fs.mkdir(target);
          else await fs.writeFile(target, 'fixture\n', { flag: 'wx' });
        }
        const filtered = filterAndSortEntries(fixture, { ...DEFAULT_LIST_POLICY, hideDotfiles: false, skipDirs: [...DEFAULT_LIST_POLICY.skipDirs, '.git'] });
        const expected: DirEntry[] = filtered.shown.map(entry => ({
          name: entry.name,
          relPath: [relative, entry.name].filter(Boolean).join('/'),
          isDirectory: entry.isDirectory,
          textLike: entry.isDirectory ? null : isProbablyTextFile(entry.name),
        }));
        assert.equal(expected.length, Math.min(size, 500));
        assert.equal(filtered.truncated, size > 500);
        const samples: Sample[] = [];
        for (let sample = 1; sample <= 3; sample += 1) {
          assert.equal(digest(await fs.readFile(sourcePath, 'utf8')), sourceHash, '测量期间源码发生变化');
          const service = new FileService();
          service.setRoot(root);
          const original = service.resolveSafePath.bind(service);
          let calls = 0;
          let inFlight = 0;
          let peak = 0;
          service.resolveSafePath = async (relPath, allowMissing = false) => {
            calls += 1;
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            try { return await original(relPath, allowMissing); }
            finally { inFlight -= 1; }
          };
          const started = performance.now();
          const result = await service.listDir(relative);
          const elapsedMs = performance.now() - started;
          assert.equal(result.ok, true, JSON.stringify(result));
          assert.deepEqual(result.entries, expected, '条目字段、排序、过滤或截断输出不一致');
          assert.equal(result.truncated, filtered.truncated);
          assert.equal(calls, expected.length + 1, '每项及目录本身必须经过完整安全校验');
          assert.equal(inFlight, 0, '返回时仍有未完成检查');
          samples.push({ sample, elapsedMs, resolveCalls: calls, peakInFlight: peak, outputHash: digest(JSON.stringify(result)) });
        }
        assert.equal(new Set(samples.map(sample => sample.outputHash)).size, 1);
        const medianMs = median(samples.map(sample => sample.elapsedMs));
        cases.push({ size, depth, entries: expected, truncated: filtered.truncated, samples, medianMs });
        process.stdout.write(`${size} entries / depth ${depth}: ${medianMs.toFixed(2)} ms; calls ${samples[0]!.resolveCalls}; peak ${Math.max(...samples.map(sample => sample.peakInFlight))}\n`);
      }
    }
    assert.equal(digest(await fs.readFile(sourcePath, 'utf8')), sourceHash, '测量期间源码发生变化');
    await fs.writeFile(output, `${JSON.stringify({
      measuredAt: new Date().toISOString(), platform: process.platform, node: process.version, sourceHash,
      scope: 'FileService.listDir real local temporary disk entries; sequential samples, OS cache not reset; excludes file content reads, UI/FPS and installed startup',
      cases,
    }, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`Report: ${output}\n`);
  } finally {
    const absolute = path.resolve(temporary);
    const parent = temporaryParent;
    assert.equal(path.dirname(absolute), parent, '清理目标必须是本次临时目录');
    assert(path.basename(absolute).startsWith('mini-directory-list-measure-'), '临时目录前缀不匹配');
    assert.equal(await fs.realpath(absolute), absolute, '临时目录不能替换为链接');
    await fs.rm(absolute, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
