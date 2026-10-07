import assert from 'node:assert/strict';
import { it } from 'node:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeTool, readAutoReply, createToolIntegration, registerToolShutdown } from '../src/main/tools/integration';
import { FileService } from '../src/main/fileService';
import { ReturnPathService } from '../src/main/returnPathService';
import { CHANNELS } from '../src/shared/contract';
import { parseToolBatch } from '../src/shared/toolProtocol';
const batch = (id = 'a') => '````mini-ai-tools\n' + JSON.stringify({ protocol_version: 1, batch_id: id, requests: [{ id: 'read', tool: 'get_project_info', args: {} }] }) + '\n````';
it('应用退出等待所属进程停止，重复退出不重复清理，完成后才真正 quit', async () => {
  let listener: any; let finish: (() => void) | undefined; let cleanup = 0; let quits = 0; let prevented = 0;
  const application: any = { on(_event: string, handler: any) { listener = handler; }, quit() { quits++; listener({ preventDefault() { prevented++; } }); } };
  registerToolShutdown(application, async () => true, () => { cleanup++; return new Promise<void>(resolve => { finish = resolve; }); }, () => assert.fail('不应失败'));
  listener({ preventDefault() { prevented++; } }); listener({ preventDefault() { prevented++; } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cleanup, 1); assert.equal(quits, 0); finish!(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(quits, 1); assert.equal(prevented, 2);
});
it('未保存确认取消退出不能停止自动采集或销毁工具，之后再退出仍完整清理', async () => {
  let listener: any; let allow = false; let cleanup = 0; let quits = 0; let approvals = 0;
  const application: any = { on(_event: string, handler: any) { listener = handler; }, quit() { quits++; listener({ preventDefault() {} }); } };
  registerToolShutdown(application, async () => { approvals++; return allow; }, async () => { cleanup++; }, () => assert.fail('不应失败'));
  listener({ preventDefault() {} }); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cleanup, 0); assert.equal(quits, 0);
  allow = true; listener({ preventDefault() {} }); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(approvals, 2); assert.equal(cleanup, 1); assert.equal(quits, 1);
});
it('正文与结束标志同一脚本读取，之后补出的第二批不能被旧正文掩盖', async () => {
  let calls = 0;
  const web: any = { getURL: () => 'https://chat.deepseek.com/a/chat/abc?tracking=1', executeJavaScript: async (script: string) => {
    calls++; assert.match(script, /const replies/); assert.match(script, /const completion/);
    return { replies: [batch('a') + '\n' + batch('b')], completion: 'complete' };
  } };
  const snapshot = await readAutoReply(web); assert.equal(calls, 1); assert.equal(snapshot.completion, 'complete');
  assert.equal(parseToolBatch(snapshot.text).kind, 'error'); assert.equal(snapshot.url.includes('?'), false);
});
it('命令授权指纹稳定；项目脚本改动失效；外部脚本仅一次且不未授权读内容', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-integration-')); const external = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-script-'));
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { check: 'node check.js' } })); await fs.writeFile(path.join(root, 'check.js'), 'one');
    const r: any = { id: 'cmd', tool: 'run_command', args: { command: 'npm run check', shell: 'powershell' } };
    const a = await describeTool(root, r); assert.equal((await describeTool(root, r)).fingerprint, a.fingerprint);
    await fs.writeFile(path.join(root, 'check.js'), 'two'); assert.notEqual((await describeTool(root, r)).fingerprint, a.fingerprint);
    r.args.command = '& ' + path.join(external, 'outside.ps1');
    const e = await describeTool(root, r); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await describeTool(root, r)).fingerprint, e.fingerprint); assert.equal(e.canRemember, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(external, { recursive: true, force: true }); }
});
it('字面引用支持空格与中文，cwd 与 package 脚本改动均重新批准；无法确定的表达式仅一次', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-quoted-script-'));
  try {
    const nested = path.join(root, 'nested'); await fs.mkdir(nested);
    const local = path.join(nested, '我的 script.ps1'); const packageScript = path.join(nested, 'package script.js');
    await fs.writeFile(local, 'safe'); await fs.writeFile(packageScript, 'safe');
    await fs.writeFile(path.join(nested, 'package.json'), JSON.stringify({ scripts: { check: 'node "package script.js"' } }));
    for (const quoted of ["'./我的 script.ps1'", '"./我的 script.ps1"']) {
      const request: any = { id: 'cmd', tool: 'run_command', args: { command: '& ' + quoted, shell: 'powershell', cwd: 'nested' } };
      const before = await describeTool(root, request); assert.equal(before.canRemember, true);
      await fs.writeFile(local, 'changed'); assert.notEqual((await describeTool(root, request)).fingerprint, before.fingerprint);
      await fs.writeFile(local, 'safe');
    }
    const request: any = { id: 'cmd', tool: 'run_command', args: { command: 'npm run check', shell: 'powershell', cwd: 'nested' } };
    const before = await describeTool(root, request); assert.equal(before.canRemember, true);
    await fs.writeFile(packageScript, 'changed'); assert.notEqual((await describeTool(root, request)).fingerprint, before.fingerprint);
    for (const command of ["& './我的 script.ps1", '& "$script.ps1"', 'bash -c "node package script.js"', "& './我的' + ' script.ps1'", 'node --require=./package script.js', "& (Join-Path 'sub' 'script.ps1')"]) {
      request.args.command = command; assert.equal((await describeTool(root, request)).canRemember, false, command);
    }
    await fs.writeFile(path.join(root, 'parent script.js'), 'one');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { check: 'node "parent script.js"' } }));
    request.args.command = 'npm run check';
    const parent = await describeTool(root, request); await fs.writeFile(path.join(root, 'parent script.js'), 'two');
    assert.notEqual((await describeTool(root, request)).fingerprint, parent.fingerprint);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it('仅编辑器主 frame 控制权限与复制；生成中手动采集不执行，追踪参数不重放', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-integration-'));
  let system: Awaited<ReturnType<typeof createToolIntegration>> | undefined;
  try {
    const handlers = new Map<string, (...args: any[]) => any>(); const editor: any = { mainFrame: {}, send() {}, isDestroyed: () => false };
    let url = 'https://chat.deepseek.com/a/chat/abc'; let copies = 0;
    const files = new FileService(); files.setRoot(root);
    const web: any = Object.assign(new EventEmitter(), { getURL: () => url, isDestroyed: () => false, executeJavaScript: async () => ({ replies: [batch()], completion: 'complete' }) });
    system = await createToolIntegration({ ipc: { handle: (c: string, f: any) => { handlers.set(c, f); } } as any, editor, web, files,
      returnPath: new ReturnPathService(files), workspace: { editor: { isDirty: () => false }, run: (f: any) => f() } as any,
      storePath: path.join(root, 'state.json'), disabled: true, ask: async () => ({ response: 0, checkboxChecked: false }), notifyFile() {}, copy() { copies++; } });
    const good = { sender: editor, senderFrame: editor.mainFrame };
    assert.throws(() => handlers.get(CHANNELS.setToolConfig)!({ sender: web, senderFrame: {} }, { permission: 'full' }), /本地编辑器/);
    await handlers.get(CHANNELS.setToolConfig)!(good, { permission: 'full' });
    const unsupported = '### 文件：legacy.txt\n### 操作：新建\n````text\nx\n````';
    assert.equal(await system.accept(unsupported, 'complete'), true, '旧格式被工具入口拦住，不能退回人工可应用解析');
    assert.match(system.getState().batchError!.error, /不再支持文件操作块/);
    assert.equal(system.getState().results.length, 0);
    await assert.rejects(fs.access(path.join(root, 'legacy.txt')));
    await system.accept(batch(), 'generating'); assert.equal(system.getState().results.length, 0);
    await system.accept(batch(), 'complete');
    for (let n = 0; system.getState().busy && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(system.getState().results[0]?.status, 'done');
    url += '?utm_source=changed'; await system.accept(batch(), 'complete');
    for (let n = 0; system.getState().busy && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
    const persisted = JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8')); assert.equal(persisted.ledger.length, 1);
    assert.equal(copies, 1, '首次执行自动复制，追踪参数和重复采集不能重复复制');
    handlers.get(CHANNELS.copyToolResults)!(good); assert.equal(copies, 2);
  } finally { await system?.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

it('真实复制 IPC 只输出最近一轮，失败新轮不能再次复制上一轮内容', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-copy-latest-'));
  let system: Awaited<ReturnType<typeof createToolIntegration>> | undefined;
  try {
    const handlers = new Map<string, (...args: any[]) => any>();
    const editor: any = { mainFrame: {}, send() {}, isDestroyed: () => false };
    const files = new FileService(); files.setRoot(root);
    const web: any = Object.assign(new EventEmitter(), { getURL: () => 'https://chat.deepseek.com/a/chat/copy', isDestroyed: () => false, executeJavaScript: async () => ({ replies: [], completion: 'complete' }) });
    const copies: string[] = [];
    system = await createToolIntegration({ ipc: { handle: (c: string, f: any) => { handlers.set(c, f); } } as any, editor, web, files,
      returnPath: new ReturnPathService(files), workspace: { editor: { isDirty: () => false }, run: (f: any) => f() } as any,
      storePath: path.join(root, 'state.json'), disabled: true, ask: async () => ({ response: 0, checkboxChecked: false }), notifyFile() {}, copy(value) { copies.push(value); } });
    const good = { sender: editor, senderFrame: editor.mainFrame };
    await handlers.get(CHANNELS.setToolConfig)!(good, { permission: 'full' });
    for (const id of ['first', 'second']) {
      await system.accept(batch(id), 'complete');
      for (let n = 0; system.getState().busy && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(system.getState().busy, false);
    }
    assert.equal(handlers.get(CHANNELS.copyToolResults)!(good).ok, true);
    assert.equal(copies.length, 3, '两轮自动复制后，手动再次复制当前轮');
    const copied = JSON.parse(copies.at(-1)!);
    assert.equal(copied.tool_results.length, 1);
    assert.equal(copied.tool_results[0].batch_id, 'second');
    assert.deepEqual(system.getState().results, copied.tool_results);
    await system.accept('```mini-ai-tools\n{invalid JSON}\n```', 'complete');
    assert.equal(handlers.get(CHANNELS.copyToolResults)!(good).ok, true);
    assert.equal(copies.length, 4, '格式错误只允许本次手动复制，不触发自动复制');
    const invalidReply = JSON.parse(copies.at(-1)!);
    assert.deepEqual(invalidReply.tool_results, []);
    assert.equal(invalidReply.batch_error.status, 'failed');
    assert.match(invalidReply.batch_error.error, /JSON 无效/);
    assert.match(invalidReply.batch_error.error, /SyntaxError/);
    assert.doesNotMatch(copies.at(-1)!, /second/);
    assert.equal(system.getState().results.length, 0);
  } finally { await system?.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

it('手动采集跨过异步完成清理边界后，项目切换或销毁不得执行旧正文', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-manual-scope-'));
  let system: Awaited<ReturnType<typeof createToolIntegration>> | undefined;
  try {
    const handlers = new Map<string, (...args: any[]) => any>(); const editor: any = { mainFrame: {}, send() {}, isDestroyed: () => false };
    const files = new FileService(); files.setRoot(root);
    const web: any = Object.assign(new EventEmitter(), { getURL: () => 'https://chat.deepseek.com/a/chat/manual', isDestroyed: () => false });
    system = await createToolIntegration({ ipc: { handle: (c: string, f: any) => { handlers.set(c, f); } } as any, editor, web, files,
      returnPath: new ReturnPathService(files), workspace: { editor: { isDirty: () => false }, run: (f: any) => f() } as any,
      storePath: path.join(root, 'state.json'), disabled: true, ask: async () => ({ response: 0, checkboxChecked: false }), notifyFile() {}, copy() {} });
    await handlers.get(CHANNELS.setToolConfig)!({ sender: editor, senderFrame: editor.mainFrame }, { permission: 'full' });
    const switched = system.accept(batch('switched'), 'complete'); system.reset(); await switched;
    assert.equal(system.getState().results.length, 0);
    const closing = system.accept(batch('closing'), 'complete'); await system.dispose(); await closing;
    assert.equal(system.getState().results.length, 0);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8')).ledger.length, 0);
  } finally { await system?.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

it('残缺JSON不预约或写文件；中断和确认期间恢复中断均不执行，补全同一批仅写一次', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-continuation-'));
  let system: Awaited<ReturnType<typeof createToolIntegration>> | undefined; let writes = 0;
  const full = '```mini-ai-tools\n' + JSON.stringify({ protocol_version: 1, batch_id: 'continued', requests: [{ id: 'create', tool: 'apply_changes', args: { changes: [{ path: 'continued.txt', operation: 'create', content: '完整内容' }] } }] }) + '\n```';
  const partial = full.slice(0, full.indexOf('完整内容') + 2) + '\n```';
  try {
    const files = new FileService(); files.setRoot(root);
    const handlers = new Map<string, (...args: any[]) => any>(); const editor: any = { mainFrame: {}, send() {}, isDestroyed: () => false };
    const web: any = Object.assign(new EventEmitter(), { getURL: () => 'https://chat.deepseek.com/a/chat/continuation', isDestroyed: () => false,
      executeJavaScript: async () => ({ replies: [full], completion: 'interrupted' }) });
    system = await createToolIntegration({ ipc: { handle: (c: string, f: any) => handlers.set(c, f) } as any, editor, web, files,
      returnPath: new ReturnPathService(files), workspace: { editor: { isDirty: () => false, current: { documents: [] } }, run: (f: any) => f() } as any,
      storePath: path.join(root, 'state.json'), disabled: true, ask: async () => ({ response: 0, checkboxChecked: false }), notifyFile() { writes++; }, copy() {} });
    await handlers.get(CHANNELS.setToolConfig)!({ sender: editor, senderFrame: editor.mainFrame }, { permission: 'full' });
    await system.accept(partial, 'complete'); assert.ok(system.getState().batchError); assert.match(system.getState().message, /未执行/);
    await system.accept(full, 'interrupted'); assert.match(system.getState().message, /等待继续生成/);
    await system.accept(full, 'unknown'); assert.match(system.getState().message, /中断/);
    assert.equal(writes, 0); await assert.rejects(fs.access(path.join(root, 'continued.txt')));
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8')).ledger.length, 0);
    for (let i = 0; i < 2; i++) {
      await system.accept(full, 'complete');
      for (let n = 0; system.getState().busy && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(system.getState().busy, false);
    }
    assert.equal(writes, 1); assert.equal(await fs.readFile(path.join(root, 'continued.txt'), 'utf8'), '完整内容');
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8')).ledger.length, 1);
  } finally { await system?.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
