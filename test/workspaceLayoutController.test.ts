import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import ts from 'typescript';
import { it } from 'node:test';
import { CHANNELS } from '../src/shared/contract';
import * as geometry from '../src/main/windowLayout';
import { SettingsStore } from '../src/main/settings';

async function fixture(settingsOverride?: Pick<SettingsStore, 'get' | 'update'>) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const writes: any[] = [];
  let saved: any = { workspaceLayout: {
    workspaceWidth: 220, workspaceVisible: true, fileWidth: 680, fileVisible: true,
    treeWidth: 180, treeVisible: true,
  } };
  const settings = settingsOverride ?? {
    get() { return structuredClone(saved); },
    update(patch: any) { writes.push(structuredClone(patch)); saved = { ...saved, ...structuredClone(patch) }; },
  };
  const notifications: any[] = [];
  let menus = 0;
  const view = () => ({ bounds: null as any, visible: true,
    setBounds(bounds: any) { this.bounds = bounds; },
    setVisible(visible: boolean) { this.visible = visible; },
    webContents: { mainFrame: {}, isDestroyed() { return false; }, send(...args: any[]) { notifications.push(args); } },
  });
  const views = { editor: view(), web: view(), webbar: view(), preview: view(), loading: view() };
  const dependencies: Record<string, unknown> = {
    electron: { ipcMain: { handle(channel: string, handler: any) { handlers.set(channel, handler); } } },
    '../shared/contract': { CHANNELS }, './windowLayout': geometry,
  };
  const exports: any = {};
  const code = ts.transpileModule(await fs.readFile('src/main/workspaceLayoutController.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, require(name: string) { assert.ok(name in dependencies, name); return dependencies[name]; } });
  let contentSize = [1600, 900];
  const controller = new exports.WorkspaceLayoutController({ isDestroyed: () => false, getContentSize: () => contentSize }, views, settings, () => { menus++; });
  controller.register(); controller.apply();
  const event = { sender: views.editor.webContents, senderFrame: views.editor.webContents.mainFrame };
  return { controller, views, writes, notifications, settings,
    get menus() { return menus; },
    resize(width: number, height: number) { contentSize = [width, height]; controller.apply(); },
    invoke(channel: string, ...args: unknown[]) { return handlers.get(channel)!(event, ...args); },
    withEvent(other: any, channel: string, ...args: unknown[]) { return handlers.get(channel)!(other, ...args); },
  };
}

it('布局写入仅接受受信本地主 frame，网页和子 frame 不能改变本地空间', async () => {
  const f = await fixture();
  const before = JSON.stringify(f.controller.state);
  for (const sender of [f.views.editor.webContents, f.views.web.webContents, f.views.webbar.webContents, f.views.preview.webContents]) {
    const event = { sender, senderFrame: sender === f.views.editor.webContents ? {} : sender.mainFrame };
    assert.throws(() => f.withEvent(event, CHANNELS.setWorkspaceLayout, { fileWidth: 800 }), /主 frame/);
    assert.throws(() => f.withEvent(event, CHANNELS.setWorkspaceLayout, { toolsVisible: true }), /主 frame/);
  }
  assert.equal(JSON.stringify(f.controller.state), before);
  assert.equal(f.writes.length, 0);
  f.invoke(CHANNELS.setWorkspaceLayout, { fileWidth: 800 });
  assert.equal(f.controller.layout.fileBounds.width, 800);
});

it('高频临时拖拽只改几何，结束或退出前落盘一次并可重启恢复最后宽度', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-layout-drag-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const f = await fixture();
  for (let i = 0; i < 60; i++) f.invoke(CHANNELS.setWorkspaceLayout, { fileWidth: 600 + i }, true);
  assert.equal(f.writes.length, 0);
  assert.equal(f.menus, 0, '宽度改变不重建菜单');
  f.invoke(CHANNELS.setWorkspaceLayout, { fileWidth: 659 });
  assert.equal(f.writes.length, 1);
  assert.equal(f.settings.get().workspaceLayout.fileWidth, 659);
  const restarted = await fixture(f.settings);
  assert.equal(restarted.controller.layout.fileBounds.width, 659);
  const real = new SettingsStore('drag.json', directory);
  const pending = await fixture(real);
  pending.invoke(CHANNELS.setWorkspaceLayout, { workspaceWidth: 280 }, true);
  assert.equal(real.get().workspaceLayout, null);
  pending.controller.flushPendingLayout();
  assert.equal(new SettingsStore('drag.json', directory).get().workspaceLayout?.workspaceWidth, 280);
  const count = f.writes.length;
  f.controller.flushPendingLayout();
  assert.equal(f.writes.length, count, '没有待提交变化时退出不重复写盘');
});

it('退出前布局保存失败保留待提交宽度，重试保存最新值且重启可恢复', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-layout-retry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const real = new SettingsStore('retry.json', directory);
  let fail = true; let attempts = 0;
  const f = await fixture({
    get: () => real.get(),
    update(patch) {
      attempts++;
      if (fail) throw new Error('设置保存失败：EACCES');
      return real.update(patch);
    },
  });
  f.invoke(CHANNELS.setWorkspaceLayout, { fileWidth: 620 }, true);
  assert.throws(() => f.controller.flushPendingLayout(), /EACCES/);
  assert.equal(attempts, 1);
  assert.equal(f.controller.layout.fileBounds.width, 620, '失败不能撤销用户当前几何');
  assert.equal(real.get().workspaceLayout, null, '失败不能冒充已保存偏好');
  f.invoke(CHANNELS.setWorkspaceLayout, { fileWidth: 740 }, true);
  fail = false;
  f.controller.flushPendingLayout();
  assert.equal(attempts, 2, '失败后 pending 仍有效，可再次提交');
  const restarted = new SettingsStore('retry.json', directory);
  assert.equal(restarted.get().workspaceLayout?.fileWidth, 740, '重试必须保存最新宽度');
  assert.equal((await fixture(restarted)).controller.layout.fileBounds.width, 740);
  f.controller.flushPendingLayout();
  assert.equal(attempts, 2, '成功后清除 pending，后续退出不重复写盘');
});

it('临时拖拽入口仍严格限制主 frame、宽度字段、参数形状，失败不能部分修改', async () => {
  const f = await fixture(); const before = JSON.stringify(f.controller.state);
  for (const patch of [{}, { fileVisible: false }, { fileWidth: 650, toolsVisible: true }, { dockHeight: 300 }, { fileWidth: NaN }]) {
    assert.throws(() => f.invoke(CHANNELS.setWorkspaceLayout, patch, true));
    assert.equal(JSON.stringify(f.controller.state), before);
  }
  assert.throws(() => f.invoke(CHANNELS.setWorkspaceLayout, { fileWidth: 650 }, 'true'));
  assert.throws(() => f.invoke(CHANNELS.setWorkspaceLayout, { fileWidth: 650 }, true, 1));
  const sender = f.views.editor.webContents;
  assert.throws(() => f.withEvent({ sender, senderFrame: {} }, CHANNELS.setWorkspaceLayout, { fileWidth: 650 }, true));
  assert.equal(f.writes.length, 0);
});

it('只有菜单语义变化调用 changed，加载层几何同步且全屏退出恢复受控显隐', async () => {
  const f = await fixture();
  const revision = f.controller.state.layoutRevision;
  f.invoke(CHANNELS.setWorkspaceLayout, { dockHeight: 200 });
  f.invoke(CHANNELS.setWorkspaceLayout, { treeWidth: 190 }, true);
  assert.equal(f.menus, 0);
  assert.ok(f.controller.state.layoutRevision > revision);
  assert.equal(f.views.loading.visible, false);
  f.controller.setLoadingViewVisible(true);
  assert.equal(f.views.loading.visible, true);
  f.invoke(CHANNELS.setWorkspaceLayout, { fileMaximized: true });
  assert.equal(f.views.loading.visible, false);
  assert.deepEqual(f.views.loading.bounds, f.controller.layout.webBounds);
  f.invoke(CHANNELS.setWorkspaceLayout, { fileMaximized: false });
  assert.equal(f.views.loading.visible, true);
  f.controller.setLoadingViewVisible(false);
  f.resize(1400, 800);
  assert.equal(f.views.loading.visible, false);
  f.invoke(CHANNELS.setWorkspaceLayout, { previewVisible: true });
  const menus = f.menus;
  f.invoke(CHANNELS.setWorkspaceLayout, { previewVisible: true });
  assert.equal(f.menus, menus, '同一显隐状态不会反复重建菜单');
  assert.equal(menus, 3);
});

it('零宽请求通过真实设置归一化后仍保留完整布局，极窄目录恢复窗口后可见', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-layout-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settings = new SettingsStore('layout-test.json', directory);
  const f = await fixture(settings);
  f.invoke(CHANNELS.setWorkspaceLayout, { workspaceWidth: 0, fileWidth: 0, treeWidth: 0 });
  const saved = settings.get().workspaceLayout;
  assert.ok(saved, '一个零宽拖动请求不能让 SettingsStore 丢弃整个布局偏好');
  assert.ok(saved.workspaceWidth > 0 && saved.fileWidth > 0 && saved.treeWidth > 0);
  assert.equal(saved.treeVisible, true);
  assert.ok(f.controller.layout.treeBounds.width >= 120);
  assert.deepEqual(new SettingsStore('layout-test.json', directory).get().workspaceLayout, saved);

  f.resize(200, 200);
  f.invoke(CHANNELS.setWorkspaceLayout, { treeWidth: 0 });
  assert.equal(f.controller.layout.treeBounds.width, 0, '空间不足时实际目录矩形允许临时为零');
  const narrowSaved = settings.get().workspaceLayout;
  assert.ok(narrowSaved, '实际零宽目录不能污染完整持久布局');
  assert.ok(narrowSaved.treeWidth > 0);
  assert.equal(narrowSaved.treeVisible, true);
  const restarted = await fixture(new SettingsStore('layout-test.json', directory));
  assert.ok(restarted.controller.layout.treeBounds.width >= 120, '恢复正常窗口后目录应按最小可用宽度重新显示');
});

it('布局白名单拒绝未知字段和非法数值，整个无效 patch 不得部分生效', async () => {
  const f = await fixture(); const before = JSON.stringify(f.controller.state);
  for (const patch of [null, [], 2, { webVisible: false }, { fileWidth: Number.NaN },
    { fileWidth: Infinity }, { fileWidth: -1 }, { fileWidth: 10001 }, { treeVisible: 'true' },
    { workspaceWidth: 250, unknown: 1 }, { toolsVisible: 'true' }]) {
    assert.throws(() => f.invoke(CHANNELS.setWorkspaceLayout, patch));
    assert.equal(JSON.stringify(f.controller.state), before);
  }
  assert.equal(f.writes.length, 0);
});

it('项目栏、文件区和目录隐藏再恢复保留各自展开偏好及目录显隐选择', async () => {
  const f = await fixture();
  const initial = f.settings.get().workspaceLayout;
  for (const key of ['workspaceVisible', 'fileVisible', 'treeVisible']) {
    f.invoke(CHANNELS.setWorkspaceLayout, { [key]: false });
    const saved = f.settings.get().workspaceLayout;
    for (const width of ['workspaceWidth', 'fileWidth', 'treeWidth']) assert.equal(saved[width], initial[width]);
    f.invoke(CHANNELS.setWorkspaceLayout, { [key]: true });
  }
  assert.equal(f.controller.layout.workspaceBounds.width, initial.workspaceWidth);
  assert.equal(f.controller.layout.fileBounds.width, initial.fileWidth);
  assert.equal(f.controller.layout.treeBounds.width, initial.treeWidth);
  f.invoke(CHANNELS.setWorkspaceLayout, { treeVisible: false });
  f.invoke(CHANNELS.setWorkspaceLayout, { fileVisible: false });
  f.invoke(CHANNELS.setWorkspaceLayout, { fileVisible: true });
  assert.equal(f.controller.layout.treeVisible, false);
  assert.equal(f.settings.get().workspaceLayout.treeWidth, initial.treeWidth);
});

it('工具区高度与 Diff 模式只是当前显示状态，不污染持久布局宽度', async () => {
  const f = await fixture(); const saved = f.settings.get();
  f.invoke(CHANNELS.setWorkspaceLayout, { dockHeight: 260, previewVisible: true });
  assert.equal(f.controller.layout.dockBounds.height, 260);
  assert.equal(f.views.preview.visible, true);
  assert.deepEqual(f.settings.get(), saved);
  assert.equal(f.writes.length, 0);
  f.invoke(CHANNELS.setWorkspaceLayout, { previewVisible: false });
  assert.equal(f.views.preview.visible, false);
  assert.deepEqual(f.settings.get(), saved);
});

it('原生 Diff 只占正文区域，目录树始终在最右且不会被预览遮盖', async () => {
  const f = await fixture();
  f.invoke(CHANNELS.setWorkspaceLayout, { previewVisible: true });
  const layout = f.controller.layout;
  assert.deepEqual(f.views.preview.bounds, layout.contentBounds);
  assert.equal(f.views.preview.bounds.x + f.views.preview.bounds.width, layout.treeBounds.x);
  assert.equal(layout.treeBounds.x + layout.treeBounds.width, 1600);
  assert.ok(layout.treeBounds.width > 0);
});

it('工具标签与原生 Diff 互斥，关闭工具展示不污染持久布局', async () => {
  const f = await fixture(); const saved = f.settings.get();
  f.invoke(CHANNELS.setWorkspaceLayout, { previewVisible: true });
  f.invoke(CHANNELS.setWorkspaceLayout, { toolsVisible: true });
  assert.equal(f.controller.state.toolsVisible, true);
  assert.equal(f.controller.state.previewVisible, false);
  assert.equal(f.views.preview.visible, false, '原生预览不能挡住本地工具正文');
  assert.equal(f.controller.layout.previewBounds.width, 0);
  f.invoke(CHANNELS.setWorkspaceLayout, { toolsVisible: false });
  assert.equal(f.controller.state.toolsVisible, false);
  assert.equal(f.controller.state.previewVisible, false, '关闭工具不会恢复先前的 Diff');
  assert.deepEqual(f.settings.get(), saved);
  assert.equal(f.writes.length, 0);
  f.invoke(CHANNELS.setWorkspaceLayout, { toolsVisible: true });
  f.invoke(CHANNELS.setPreviewPanel, 500);
  assert.equal(f.controller.state.toolsVisible, false);
  assert.equal(f.controller.state.previewVisible, true);
  f.invoke(CHANNELS.setPreviewPanel, 0);
  assert.equal(f.writes.length, 1, '只有显式预览宽度调整保存偏好，工具显隐不持久化');
  assert.equal('toolsVisible' in f.settings.get().workspaceLayout, false);
  assert.equal(saved.workspaceLayout.treeVisible, f.settings.get().workspaceLayout.treeVisible);
});

it('从临时拓宽 Diff 切换到工具恢复原宽度，文件区隐藏后恢复仍保留工具选择', async () => {
  const f = await fixture(); const initial = f.controller.layout.fileBounds.width;
  f.invoke(CHANNELS.setPreviewPanel, 700, true);
  assert.ok(f.controller.layout.fileBounds.width > initial);
  f.invoke(CHANNELS.setWorkspaceLayout, { toolsVisible: true });
  assert.equal(f.controller.layout.fileBounds.width, initial);
  assert.equal(f.views.preview.visible, false);
  assert.equal(f.writes.length, 0);
  f.invoke(CHANNELS.setWorkspaceLayout, { fileVisible: false });
  assert.equal(f.controller.state.toolsVisible, false);
  f.invoke(CHANNELS.setWorkspaceLayout, { fileVisible: true });
  assert.equal(f.controller.state.toolsVisible, true);
  assert.equal(f.controller.state.previewVisible, false);
});

it('临时拓宽 Diff 关闭后恢复文件区宽度，整个过程不保存临时宽度', async () => {
  const f = await fixture(); const initial = f.controller.layout.fileBounds.width; const saved = f.settings.get();
  f.invoke(CHANNELS.setPreviewPanel, 700, true);
  assert.ok(f.controller.layout.fileBounds.width > initial);
  const temporary = f.controller.layout.fileBounds.width;
  f.invoke(CHANNELS.setPreviewPanel, 740, true);
  assert.ok(f.controller.layout.fileBounds.width >= temporary);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.settings.get(), saved);
  f.invoke(CHANNELS.setPreviewPanel, 0, false);
  assert.equal(f.controller.layout.fileBounds.width, initial);
  assert.equal(f.controller.state.previewVisible, false);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.settings.get(), saved);
});

it('临时预览期间调整项目栏仍只保存原文件宽度，重启不会恢复临时拓宽', async () => {
  const f = await fixture(); const initial = f.settings.get().workspaceLayout.fileWidth;
  f.invoke(CHANNELS.setPreviewPanel, 700, true);
  f.invoke(CHANNELS.setWorkspaceLayout, { workspaceVisible: false });
  assert.equal(f.settings.get().workspaceLayout.fileWidth, initial);
  assert.equal(f.settings.get().workspaceLayout.workspaceVisible, false);
  f.invoke(CHANNELS.setPreviewPanel, 0);
  assert.equal(f.controller.layout.fileBounds.width, initial);
});


it('文件区全屏隐藏官网但保留原宽度，显隐和重启不保存临时布局', async () => {
  const f = await fixture(); const initial = f.controller.layout.fileBounds.width; const saved = f.settings.get();
  f.invoke(CHANNELS.setWorkspaceLayout, { fileMaximized: true });
  assert.equal(f.controller.state.fileMaximized, true);
  assert.ok(f.controller.layout.fileBounds.width > initial);
  assert.equal(f.views.web.visible, false);
  assert.equal(f.views.webbar.visible, false);
  assert.equal(f.controller.layout.dockBounds.width, 0);
  assert.deepEqual(f.settings.get(), saved);
  f.invoke(CHANNELS.setWorkspaceLayout, { treeVisible: false });
  assert.equal(f.settings.get().workspaceLayout.fileWidth, initial);
  f.invoke(CHANNELS.setWorkspaceLayout, { fileMaximized: false });
  assert.equal(f.controller.layout.fileBounds.width, initial);
  f.invoke(CHANNELS.setWorkspaceLayout, { fileMaximized: true });
  f.invoke(CHANNELS.setWorkspaceLayout, { fileVisible: false });
  assert.equal(f.controller.state.fileMaximized, false);
  f.invoke(CHANNELS.setWorkspaceLayout, { fileVisible: true });
  assert.equal(f.controller.layout.fileBounds.width, initial);
});


it('官网顶栏的恢复与工作区切换仅允许自己的主 frame，不授予通用布局权限', async () => {
  const f = await fixture(); f.invoke(CHANNELS.setWorkspaceLayout, { fileVisible: false });
  assert.equal(f.controller.layout.fileBounds.width, 0);
  assert.throws(() => f.invoke(CHANNELS.restoreFileWorkspace), /主 frame/);
  const sender = f.views.webbar.webContents;
  assert.throws(() => f.withEvent({sender,senderFrame:{}}, CHANNELS.restoreFileWorkspace), /主 frame/);
  f.withEvent({sender,senderFrame:sender.mainFrame}, CHANNELS.restoreFileWorkspace);
  assert.equal(f.controller.layout.fileVisible, true);
  assert.equal(f.controller.state.fileMaximized, false);
  f.invoke(CHANNELS.setWorkspaceLayout, { workspaceVisible: false });
  assert.equal(f.controller.layout.workspaceBounds.width, 0);
  assert.throws(() => f.invoke(CHANNELS.toggleWorkspace), /主 frame/);
  assert.throws(() => f.withEvent({sender,senderFrame:{}}, CHANNELS.toggleWorkspace), /主 frame/);
  f.withEvent({sender,senderFrame:sender.mainFrame}, CHANNELS.toggleWorkspace);
  assert.equal(f.controller.layout.workspaceBounds.width, 220);
  f.withEvent({sender,senderFrame:sender.mainFrame}, CHANNELS.toggleWorkspace);
  assert.equal(f.controller.layout.workspaceBounds.width, 0);
});


it('文件区全屏中的 Diff 拓宽不覆盖退出全屏时的正常宽度', async () => {
  const f = await fixture(); const width = f.controller.layout.fileBounds.width;
  f.invoke(CHANNELS.setWorkspaceLayout, { fileMaximized: true });
  f.invoke(CHANNELS.setPreviewPanel, 1000, true);
  f.invoke(CHANNELS.setPreviewPanel, 1100, false);
  f.invoke(CHANNELS.setWorkspaceLayout, { fileMaximized: false });
  assert.equal(f.controller.layout.fileBounds.width, width);
  assert.equal(f.settings.get().workspaceLayout.fileWidth, width);
});

it('平台切换仅替换活动官网，缩放和文件区全屏继续使用统一布局', async () => {
  const f = await fixture(); const deepseek = f.views.web; const saved = f.settings.get();
  const chatgpt = { bounds: null as any, visible: false,
    setBounds(bounds: any) { this.bounds = bounds; }, setVisible(visible: boolean) { this.visible = visible; } };
  f.controller.setWebView(chatgpt);
  assert.equal(deepseek.visible, false);
  assert.deepEqual(chatgpt.bounds, f.controller.layout.webBounds);
  assert.equal(chatgpt.visible, true);
  f.resize(1400, 850);
  assert.deepEqual(chatgpt.bounds, f.controller.layout.webBounds);
  f.invoke(CHANNELS.setWorkspaceLayout, { fileMaximized: true });
  assert.equal(chatgpt.visible, false);
  f.controller.setWebView(deepseek);
  assert.equal(chatgpt.visible, false);
  assert.equal(deepseek.visible, false);
  f.invoke(CHANNELS.setWorkspaceLayout, { fileMaximized: false });
  assert.equal(deepseek.visible, true);
  assert.deepEqual(f.settings.get(), saved, '切换平台和临时全屏不改用户布局偏好');
});
