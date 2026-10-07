import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { FileService } from '../src/main/fileService';
import { ReturnPathService } from '../src/main/returnPathService';
import { ToolChanges, checkBatchChanges, checkResolvedBatchChanges } from '../src/main/tools/changes';
import { ToolFiles } from '../src/main/tools/files';
import { ToolProcesses } from '../src/main/tools/processes';
import { ToolHarness } from '../src/main/tools/harness';
import { ToolStore } from '../src/main/tools/store';
import { parseToolBatch, type ToolBatch, type ToolRequest } from '../src/shared/toolProtocol';

// 样例原文是测试输入；不在测试中复制一套协议或编辑规则。
const document = readFileSync(path.join(__dirname, '../docs/工具调用测试样例.md'), 'utf8').replace(/\r\n/g, '\n');
const fence = String.fromCharCode(96).repeat(4);
const sections = document.split(/^## S/m).slice(1).map(section => {
  const heading = /^(\d{2}) (.+)\n/.exec(section)!;
  const expected = /解析预期：(batch|error|none)/.exec(section)?.[1];
  const replies = [...section.matchAll(new RegExp('^' + fence + 'text\\n([\\s\\S]*?)\\n' + fence + '$', 'gm'))].map(reply => reply[1]!);
  assert.ok(expected && replies.length, '每例必须提供可提取的解析预期与原文');
  return { id: heading[1]!, title: heading[2]!, expected, replies };
});

test('样例目录包含 35 个独立案例及 37 段回复，覆盖所有正式工具', () => {
  assert.equal(sections.length, 35);
  assert.equal(sections.flatMap(section => section.replies).length, 37);
  const tools = new Set<string>();
  for (const section of sections) for (const reply of section.replies) {
    const parsed = parseToolBatch(reply);
    if (parsed.kind === 'batch') parsed.batch.requests.forEach(request => tools.add(request.tool));
  }
  assert.deepEqual([...tools].sort(), ['apply_changes', 'get_process_output', 'get_project_info', 'list_directory', 'read_file', 'run_command', 'search_files', 'search_text', 'stop_process']);
});
for (const section of sections) section.replies.forEach((reply, index) => {
  test('文档 S' + section.id + ' ' + section.title + (index ? ' 子例 ' + (index + 1) : ''), () => {
    const parsed = parseToolBatch(reply);
    assert.equal(parsed.kind, section.expected, parsed.kind === 'error' ? parsed.error : section.title);
  });
});

function sample(id: string): ToolBatch {
  const section = sections.find(item => item.id === id);
  assert.ok(section, '样例不存在：' + id);
  const parsed = parseToolBatch(section.replies[0]!);
  assert.equal(parsed.kind, 'batch');
  if (parsed.kind !== 'batch') throw new Error('需要合法工具样例');
  return parsed.batch;
}
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-tool-samples-'));
  const files = new FileService(); files.setRoot(root);
  const changes = new ToolChanges(files, new ReturnPathService(files), () => false, async () => true, () => {});
  const queries = new ToolFiles(); const processes = new ToolProcesses();
  t.after(async () => { await processes.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await changes.execute(root, sample('01').requests[0]!);
  const execute = (request: ToolRequest): Promise<unknown> => {
    if (request.tool === 'apply_changes') return changes.execute(root, request);
    if (['run_command', 'get_process_output', 'stop_process'].includes(request.tool)) return processes.execute(root, request.tool, request.args);
    return queries.execute(root, request.tool, request.args);
  };
  return { root, changes, queries, processes, execute };
}

test('文档基线支持五类真实查询、中文读行与显式截断', async t => {
  const f = await fixture(t);
  const output = await Promise.all(sample('02').requests.map(f.execute)) as any[];
  assert.equal(output[0].root, await fs.realpath(f.root));
  assert.ok(output[1].entries.some((entry: any) => entry.path === '中文 空格.txt'));
  assert.ok(output[2].files.includes('中文 空格.txt'));
  assert.match(output[3].content, /TODO literal a\.\*/);
  assert.equal(output[4].matches[0].line, 2);
  const line = await f.execute(sample('03').requests[0]!) as any;
  assert.equal(line.content, '2: TODO literal a.*\n');
  await assert.rejects(f.execute(sample('03').requests[1]!), /ENOENT/);
  for (const request of sample('04').requests) {
    const result = await f.execute(request) as any;
    assert.equal(result.truncated, true);
    assert.equal((result.entries ?? result.files).length, 1);
  }
});

test('文档修改示例实际保留 Markdown、覆盖内容、多个替换、插入删除与空文件', async t => {
  const f = await fixture(t);
  for (const id of ['05', '06', '07', '08', '09']) {
    const batch = sample(id); checkBatchChanges(f.root, batch);
    await f.execute(batch.requests[0]!);
  }
  const read = (name: string) => fs.readFile(path.join(f.root, 'tool-samples', name), 'utf8');
  const triple = String.fromCharCode(96).repeat(3);
  assert.equal(await read('markdown.md'), "# 示例\n\n" + triple + "js\nconsole.log('hello');\n" + triple + '\n');
  assert.equal(await read('overwrite.txt'), '新内容\n第二行\n');
  assert.equal(await read('multi.txt'), 'title=new\ncolor=green\n');
  assert.equal(await read('insert-delete.txt'), 'before\nanchor\ninserted\nafter\n');
  assert.equal((await fs.stat(path.join(f.root, 'tool-samples/empty.txt'))).size, 0);
});

test('文档失败修改均保持独立基线，跨请求冲突在写盘前拒绝', async t => {
  const f = await fixture(t);
  for (const [id, name, original] of [['10', 'zero.txt', 'ALPHA'], ['11', 'many.txt', 'TOKEN TOKEN'], ['12', 'overlap.txt', 'abcd']]) {
    await assert.rejects(f.execute(sample(id!).requests[0]!));
    assert.equal(await fs.readFile(path.join(f.root, 'tool-samples', name!), 'utf8'), original);
  }
  assert.throws(() => checkBatchChanges(f.root, sample('13')), /一个 apply_changes/);
  assert.throws(() => checkBatchChanges(f.root, sample('14')), /混合/);
  assert.equal(await fs.readFile(path.join(f.root, 'tool-samples/cross.txt'), 'utf8'), 'left=A\nright=B\n');
  await assert.rejects(fs.stat(path.join(f.root, 'tool-samples/conflict.txt')), { code: 'ENOENT' });
});

test('文档命令实际返回 stdout、stderr、非零退出并跳过显式依赖', async t => {
  const f = await fixture(t);
  const store = new ToolStore(path.join(f.root, 'tools.json')); await store.ready(); await store.configure({ permission: 'full' });
  const harness = new ToolHarness({
    store, root: () => f.root, session: () => 'samples', execute: (_root, request) => f.execute(request),
    describe: async () => ({ external: false, fingerprint: 'sample' }),
    authorize: async () => { assert.fail('完全访问不应请求批准'); },
    prepare: async (root, batch) => { checkBatchChanges(root, batch); await checkResolvedBatchChanges(root, batch); },
    changed: () => {},
  });
  await harness.collect(sections.find(section => section.id === '15')!.replies[0]!);
  const ok = harness.getCopyResults()[0]!;
  assert.equal(ok.status, 'done'); assert.match((ok.data as any).stdout, /sample-ok/);
  assert.ok((ok.data as any).stdout.toLowerCase().includes(path.join(f.root, 'tool-samples').toLowerCase()));
  await harness.collect(sections.find(section => section.id === '16')!.replies[0]!);
  const failed = harness.getCopyResults();
  assert.deepEqual(failed.map(result => result.status), ['failed', 'skipped_dependency', 'done']);
  assert.equal((failed[0]!.data as any).exit_code, 7);
  assert.match((failed[0]!.data as any).stderr, /sample-error/);
  await harness.collect(sections.find(section => section.id === '17')!.replies[0]!);
  const timeout = harness.getCopyResults()[0]!;
  assert.equal(timeout.status, 'failed'); assert.equal((timeout.data as any).timed_out, true);
});

test('文档后台样例只以真实工具 ID 查询分页并停止所持进程', async t => {
  const f = await fixture(t);
  const started = await f.execute(sample('19').requests[0]!) as any;
  assert.equal(started.status, 'running'); assert.ok(started.process_id);
  const requests = structuredClone(sample('20').requests);
  for (const request of requests) request.args.process_id = started.process_id;
  let output: any;
  const deadline = Date.now() + 5000;
  do {
    output = await f.execute(requests[0]!);
    if (output.total_chars > 0) break;
    await delay(50);
  } while (Date.now() < deadline);
  assert.ok(output.total_chars > 0, '后台命令必须产生实际输出');
  assert.ok(output.output.length <= 10);
  const next = await f.processes.execute(f.root, 'get_process_output', { process_id: started.process_id, cursor: output.next_cursor, limit: 100 }) as any;
  assert.match(output.output + next.output, /background-start/);
  const stopped = await f.execute(requests[1]!) as any;
  assert.notEqual(stopped.status, 'running');
});
