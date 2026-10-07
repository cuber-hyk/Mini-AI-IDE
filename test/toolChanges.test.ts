import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileService } from '../src/main/fileService';
import { ReturnPathService } from '../src/main/returnPathService';
import { ToolChanges, checkBatchChanges, checkResolvedBatchChanges } from '../src/main/tools/changes';
import type { ToolRequest } from '../src/shared/toolProtocol';
const edit = (p: string, old = 'A', next = 'C'): ToolRequest => ({ id: 'edit', tool: 'apply_changes', args: { changes: [{ path: p, operation: 'replace', edits: [{ old_string: old, new_string: next }] }] } });
it('目录 junction 别名不能绕过未保存保护及同批物理目标唯一性', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-alias-'));
  try {
    await fs.mkdir(path.join(root, 'real')); await fs.writeFile(path.join(root, 'real/a.txt'), 'A');
    await fs.symlink(path.join(root, 'real'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const files = new FileService(); files.setRoot(root); let asked = 0; let allow = false; const notices: string[] = [];
    const changes = new ToolChanges(files, new ReturnPathService(files), p => p === 'alias/a.txt', async () => { asked++; return allow; }, p => notices.push(p), () => ['alias/a.txt']);
    await assert.rejects(changes.execute(root, edit('real/a.txt')), /停止修改/); assert.equal(asked, 1); assert.equal(await fs.readFile(path.join(root, 'real/a.txt'), 'utf8'), 'A');
    await assert.rejects(checkResolvedBatchChanges(root, { protocol_version: 1, batch_id: 'aliases', requests: [edit('real/a.txt'), { ...edit('alias/a.txt'), id: 'second' }] }), /一个 apply_changes/);
    allow = true; await changes.execute(root, edit('real/a.txt')); assert.deepEqual(new Set(notices), new Set(['real/a.txt', 'alias/a.txt']));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it('停止未保存修改不写盘；继续用 A→C，不把 B 先保存，并复用原文保护与撤销', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-change-')); const p = path.join(root, 'a.txt');
  try {
    await fs.writeFile(p, 'A'); const files = new FileService(); files.setRoot(root); const returns = new ReturnPathService(files);
    let allow = false; const events: unknown[] = [];
    const changes = new ToolChanges(files, returns, () => true, async () => allow, (...args) => events.push(args));
    await assert.rejects(changes.execute(root, edit('a.txt')), /停止修改/); assert.equal(await fs.readFile(p, 'utf8'), 'A');
    allow = true; const outcome = await changes.execute(root, edit('a.txt')) as { status: string };
    assert.equal(outcome.status, 'done'); assert.equal(await fs.readFile(p, 'utf8'), 'C'); assert.deepEqual(events, [['a.txt', 'updated', true]]);
    assert.equal((await changes.undo()).ok, false); // dirty 仍被主进程报告时不能撤销。
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it('外部授权文件修改使用隔离 owner，编辑器 FileService 不扩大，且可撤销', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-change-')); const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-out-'));
  try {
    const p = path.join(outside, 'a.txt'); await fs.writeFile(p, 'A'); const files = new FileService(); files.setRoot(root);
    const changes = new ToolChanges(files, new ReturnPathService(files), () => false, async () => true, () => assert.fail('外部文件不能广播为项目文件'));
    await changes.execute(root, edit(p)); assert.equal(await fs.readFile(p, 'utf8'), 'C');
    assert.equal((await files.readRawText(p)).ok, false);
    assert.equal((await changes.undo()).ok, true); assert.equal(await fs.readFile(p, 'utf8'), 'A');
    const nested = path.join(outside, 'new/nested/empty.txt');
    await changes.execute(root, { id: 'create', tool: 'apply_changes', args: { changes: [{ path: nested, operation: 'create', content: '' }] } });
    assert.equal(await fs.readFile(nested, 'utf8'), ''); assert.equal((await changes.undo()).ok, true);
    await assert.rejects(fs.stat(path.join(outside, 'new')), { code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});

it('连续修改超过快照窗口后，仍能按真实记录逆序撤销二十次', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-undo-'));
  try {
    const files = new FileService(); files.setRoot(root); await fs.writeFile(path.join(root, 'a.txt'), '0');
    const changes = new ToolChanges(files, new ReturnPathService(files), () => false, async () => true, () => {});
    for (let i = 1; i <= 21; i++) await changes.execute(root, edit('a.txt', String(i - 1), String(i)));
    for (let i = 20; i >= 1; i--) { assert.equal((await changes.undo()).ok, true); assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), String(i)); }
    assert.equal(changes.canUndo, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it('同批覆盖与新建冲突在执行前拒绝，同请求实际重叠不写任何文件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-change-'));
  try {
    assert.throws(() => checkBatchChanges(root, { protocol_version: 1, batch_id: 'b', requests: [{ id: 'e', tool: 'apply_changes', args: { changes: [{ path: 'a', operation: 'create', content: 'A' }, { path: './a', operation: 'overwrite', content: 'B' }] } }] }), /混合/);
    const files = new FileService(); files.setRoot(root); const changes = new ToolChanges(files, new ReturnPathService(files), () => false, async () => true, () => {});
    await fs.writeFile(path.join(root, 'a.txt'), 'abcd');
    await assert.rejects(changes.execute(root, { id: 'e', tool: 'apply_changes', args: { changes: [{ path: 'a.txt', operation: 'replace', edits: [{ old_string: 'abc', new_string: 'X' }, { old_string: 'bcd', new_string: 'Y' }] }] } }), /重叠/);
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'abcd');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
