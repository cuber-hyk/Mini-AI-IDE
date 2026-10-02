/**
 * 路径白名单测试（ADR-0002 的硬边界）
 *
 * 这些断言是"渲染进程不能越界读文件"的可执行表达 —— 比文档更可靠。
 */
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { filterAndSortEntries, isInsideRoot, resolveWithinRoot } from '../src/shared/pathGuard';

const root = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';

describe('resolveWithinRoot', () => {
  it('接受根目录自身', () => {
    const v = resolveWithinRoot(root, '.');
    assert.equal(v.ok, true);
  });

  it('接受根目录内的相对路径', () => {
    const v = resolveWithinRoot(root, 'src/index.ts');
    assert.equal(v.ok, true);
    if (!v.ok) return;
    assert.equal(v.relative, path.join('src', 'index.ts'));
  });

  it('接受根目录内的绝对路径', () => {
    const target = path.join(root, 'a', 'b.txt');
    const v = resolveWithinRoot(root, target);
    assert.equal(v.ok, true);
  });

  it('拒绝用 .. 穿越到根目录之外', () => {
    const v = resolveWithinRoot(root, '../../windows/win.ini');
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.equal(v.reason, 'outside-root');
  });

  it('拒绝绝对路径越界', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
    const v = resolveWithinRoot(root, outside);
    assert.equal(v.ok, false);
  });

  it('拒绝空路径与含 NUL 的路径', () => {
    assert.equal(resolveWithinRoot(root, '').ok, false);
    assert.equal(resolveWithinRoot(root, 'a\0b').ok, false);
  });

  it('拒绝前缀相似但不同目录（C:\\work\\project2）', () => {
    if (process.platform !== 'win32') return;
    const v = resolveWithinRoot('C:\\work\\project', 'C:\\work\\project2\\secret.txt');
    assert.equal(v.ok, false);
    if (v.ok) return;
    assert.equal(v.reason, 'outside-root');
  });
});

describe('isInsideRoot', () => {
  it('Windows 下大小写不敏感', () => {
    if (process.platform !== 'win32') return;
    assert.equal(isInsideRoot('C:\\Work\\Project', 'c:\\work\\project\\src\\a.ts'), true);
  });

  it('相同路径返回 true', () => {
    assert.equal(isInsideRoot(root, root), true);
  });
});

describe('filterAndSortEntries', () => {
  it('目录在前、名称排序、隐藏点文件并跳过 node_modules', () => {
    const entries = [
      { name: 'b.txt', isDirectory: false },
      { name: 'node_modules', isDirectory: true },
      { name: '.git', isDirectory: true },
      { name: 'src', isDirectory: true },
      { name: 'a.txt', isDirectory: false },
    ];
    const { shown, truncated } = filterAndSortEntries(entries);
    assert.equal(truncated, false);
    assert.deepEqual(
      shown.map((e) => e.name),
      ['src', 'a.txt', 'b.txt']
    );
  });

  it('超过上限时截断并标记', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.txt`, isDirectory: false }));
    const { shown, truncated } = filterAndSortEntries(many, {
      maxEntries: 3,
      hideDotfiles: true,
      skipDirs: [],
    });
    assert.equal(truncated, true);
    assert.equal(shown.length, 3);
  });
});
