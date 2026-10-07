/** 实际修改由工具 owner 执行，编辑器与变更视图不能绕过权限再次应用。 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';

function loadBridge(file: string) {
  let bridge: Record<string, (...args: unknown[]) => unknown> = {};
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(source, { exports: {}, require: (name: string) => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld(_name: string, value: typeof bridge) { bridge = value; } },
      ipcRenderer: { invoke(channel: string, ...args: unknown[]) { calls.push({ channel, args }); return Promise.resolve({ ok: true }); }, on() {}, send() {} } };
  } });
  return { bridge, calls };
}

it('编辑器没有旧人工应用和内联差异桥，修改入口统一通过工具权限 owner', async () => {
  const { bridge, calls } = loadBridge('src/main/preload.ts');
  for (const name of ['applyChange', 'undoSave', 'showDiffInEditor', 'stepDiff', 'onDiffData']) assert.equal(name in bridge, false, name);
  await bridge.collectReply!();
  await bridge.undoToolChange!();
  assert.deepEqual(calls.map(call => call.channel), ['return:collect', 'tools:undo']);
  const html = fs.readFileSync('src/renderer/index.html', 'utf8');
  assert.doesNotMatch(html, /id="(?:diff-actions|btn-diff-apply)"/);
});

it('右侧查看桥不提供应用或重定向写盘，查询快照只使用 review 只读通道', async () => {
  const { bridge, calls } = loadBridge('src/main/previewPreload.ts');
  assert.deepEqual(Object.keys(bridge).sort(), ['getReviewState', 'onReviewState', 'undoToolChange', 'setPreviewPanel', 'onChromeState'].sort());
  await bridge.getReviewState!();
  assert.deepEqual(calls, [{ channel: 'review:get-state', args: [] }]);
  await bridge.undoToolChange!();
  assert.deepEqual(calls[1], { channel: 'review:undo', args: [] });
});

it('普通代码块只交给工具入口解释，不进入旧块解析或人工应用路径', () => {
  const source = fs.readFileSync('src/main/index.ts', 'utf8');
  const collect = source.slice(source.indexOf('ipcMain.handle(CHANNELS.collectReply'), source.indexOf('function notifyFileChanged'));
  assert.match(collect, /await tools\.accept\(collected\.replyText, snapshot\.completion\)/);
  assert.doesNotMatch(collect, /parseModelReply|prepareBatch|collections\.set/);
  assert.doesNotMatch(source, /ipcMain\.handle\(CHANNELS\.(?:applyChange|undoSave|showDiffInEditor|stepDiff)/);
});
