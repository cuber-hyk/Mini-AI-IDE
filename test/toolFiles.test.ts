import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ToolFiles, resolveToolPath } from '../src/main/tools/files';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-tool-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'README.md'), '项目\nTODO first\nlast\n');
  await fs.writeFile(path.join(root, 'src', 'main.ts'), 'before\nTODO literal a.*\nafter');
  return root;
}

test('工具查询返回实际目录、glob 文件、字面匹配与行范围', async t => {
  const root = await fixture(t); const files = new ToolFiles();
  const info = await files.execute(root, 'get_project_info', {}) as any;
  assert.equal(info.root, await fs.realpath(root));
  assert.ok(info.entries.some((e: any) => e.path === 'README.md'));
  const listing = await files.execute(root, 'list_directory', { depth: 1 }) as any;
  assert.ok(listing.entries.some((e: any) => e.path === 'src/main.ts'));
  const glob = await files.execute(root, 'search_files', { pattern: '**/*.ts' }) as any;
  assert.deepEqual(glob.files, ['src/main.ts']);
  const singleGlob = await files.execute(root, 'search_files', { pattern: 'src/ma?n.*' }) as any;
  assert.deepEqual(singleGlob.files, ['src/main.ts']);
  const noSlash = await files.execute(root, 'search_files', { pattern: 'src/**/main.ts' }) as any;
  assert.deepEqual(noSlash.files, ['src/main.ts']);
  const literalGlob = await files.execute(root, 'search_files', { pattern: 'src/**/ain.ts' }) as any;
  assert.deepEqual(literalGlob.files, []);
  const text = await files.execute(root, 'search_text', { query: 'a.*', context: 1 }) as any;
  assert.equal(text.matches.length, 1); assert.equal(text.matches[0].line, 2);
  assert.deepEqual(text.matches[0].context.map((c: any) => c.content), ['before', 'after']);
  const read = await files.execute(root, 'read_file', { path: 'README.md', start_line: 2, end_line: 2 }) as any;
  assert.equal(read.content, '2: TODO first\n'); assert.equal(read.total_lines, 4);
  const single = await files.execute(root, 'search_text', { path: 'README.md', query: 'TODO' }) as any;
  assert.equal(single.matches[0].path, 'README.md');
});

test('查询明示截断，排除构建目录，保留其他点文件', async t => {
  const root = await fixture(t); const files = new ToolFiles();
  await fs.mkdir(path.join(root, 'node_modules')); await fs.writeFile(path.join(root, 'node_modules', 'hidden.ts'), 'TODO');
  await fs.writeFile(path.join(root, '.env.example'), 'EXAMPLE=yes');
  const limited = await files.execute(root, 'list_directory', { limit: 1 }) as any;
  assert.equal(limited.entries.length, 1); assert.equal(limited.truncated, true);
  const search = await files.execute(root, 'search_files', { pattern: '**/*' }) as any;
  assert.ok(search.files.includes('.env.example')); assert.ok(!search.files.includes('node_modules/hidden.ts'));
  assert.ok(search.skipped.some((s: any) => s.path === 'node_modules'));
  await fs.writeFile(path.join(root, 'long.txt'), `${'a'.repeat(49_990)}\nline 2\nline 3`);
  const read = await files.execute(root, 'read_file', { path: 'long.txt' }) as any;
  assert.equal(read.truncated, true); assert.equal(read.next_start_line, 2); assert.ok(read.content.length <= 50_000);
});

test('复用编码探测，拒绝二进制与不存在文件；搜索明示跳过原因', async t => {
  const root = await fixture(t); const files = new ToolFiles();
  await fs.writeFile(path.join(root, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  const gbk = await files.execute(root, 'read_file', { path: 'gbk.txt' }) as any;
  assert.equal(gbk.encoding, 'gbk'); assert.equal(gbk.content, '1: 中文\n');
  await fs.writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
  await assert.rejects(files.execute(root, 'read_file', { path: 'binary.dat' }), /二进制/);
  await assert.rejects(files.execute(root, 'read_file', { path: 'absent.txt' }), /ENOENT/);
  const search = await files.execute(root, 'search_text', { query: 'TODO' }) as any;
  assert.ok(search.skipped.some((s: any) => s.path === 'binary.dat' && s.reason.includes('二进制')));
});

test('真实路径暴露链接越界和缺失末尾，不递归链接或读取其文件', async t => {
  const root = await fixture(t); const external = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-tool-outside-'));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  await fs.writeFile(path.join(external, 'outside.txt'), 'secret TODO');
  await fs.symlink(external, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await resolveToolPath(root, 'linked/outside.txt'), await fs.realpath(path.join(external, 'outside.txt')));
  assert.equal(await resolveToolPath(root, 'linked/new/deep.txt'), path.join(await fs.realpath(external), 'new', 'deep.txt'));
  const files = new ToolFiles(); const search = await files.execute(root, 'search_text', { query: 'secret' }) as any;
  assert.equal(search.matches.length, 0); assert.ok(search.skipped.some((s: any) => s.path === 'linked'));
  // 绝对路径由上层授权；工具层不隐瞒或误称路径在项目内。
  const read = await files.execute(root, 'read_file', { path: path.join(external, 'outside.txt') }) as any;
  assert.equal(read.path, await fs.realpath(path.join(external, 'outside.txt')));
});

test('路径不能穿过文件父级，参数也不能绕过工具协议', async t => {
  const root = await fixture(t); const files = new ToolFiles();
  await assert.rejects(resolveToolPath(root, 'README.md/a.txt'), /ENOTDIR|父级/);
  await assert.rejects(resolveToolPath(root, 'a\0b'), /路径无效/);
  await assert.rejects(files.execute(root, 'read_file', { path: 'README.md', start_line: 0 }), /无效/);
});
