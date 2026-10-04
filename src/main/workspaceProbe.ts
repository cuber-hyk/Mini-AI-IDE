/** 隔离临时目录、离线 Electron 本地界面验收；不接触官方网页或用户文件。 */
import { app, dialog, type WebContents } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkspaceController } from './workspaceController';

export function configureWorkspaceProbe(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-workspace-probe-'));
  app.setPath('userData', directory);
  return directory;
}

export async function runWorkspaceProbe(view: WebContents, web: WebContents, controller: WorkspaceController, directory: string) {
  const checks: Array<{ name: string; pass: boolean; observed?: unknown }> = [];
  const check = (name: string, pass: boolean, observed?: unknown) => checks.push({ name, pass, observed });
  const evaluate = <T = unknown>(script: string): Promise<T> => view.executeJavaScript(script.startsWith('const ') ? `(() => { ${script} })()` : script, true);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 60));
  async function waitFor(script: string) {
    for (let i = 0; i < 100; i++) { if (await evaluate(script)) return true; await pause(); }
    return false;
  }
  const a = path.join(directory, 'A'); const b = path.join(directory, 'B');
  fs.mkdirSync(a); fs.mkdirSync(b); fs.mkdirSync(path.join(a, 'sub'));
  fs.writeFileSync(path.join(a, 'a.txt'), 'A original'); fs.writeFileSync(path.join(b, 'a.txt'), 'B original');
  fs.writeFileSync(path.join(a, 'tabs.txt'), 'tab original');
  let choice = 2;
  const originalBox = dialog.showMessageBox;
  const originalOpen = dialog.showOpenDialog;
  let picked = a;
  dialog.showMessageBox = (async () => ({ response: choice, checkboxChecked: false })) as typeof dialog.showMessageBox;
  dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  try {
    check('Monaco 初始化', await waitFor('Boolean(window.__uiProbe && window.__uiProbe().ready)'));
    // 顶部按钮必须真正走持久化后的同一入口。
    await evaluate("document.getElementById('btn-open').click()");
    check('顶部打开目录并显示文件树', await waitFor("Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"a.txt\"]'))"));
    check('顶部打开目录持久化', controller.workspace.getState().root === a && fs.readFileSync(path.join(directory, 'settings.json'), 'utf8').includes(a.replace(/\\/g, '\\\\')));
    await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"a.txt\"]').click()");
    check('点击文件真实打开', await waitFor("document.getElementById('file-name').textContent === 'a.txt'"));
    await evaluate("window.__tabModelA = window.monaco.editor.getEditors()[0].getModel(); window.monaco.editor.getEditors()[0].executeEdits('workspace-probe',[{range:window.__tabModelA.getFullModelRange(),text:'tab draft A'}]); window.monaco.editor.getEditors()[0].pushUndoStop(); window.monaco.editor.getEditors()[0].setPosition({lineNumber:1,column:5})");
    await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"tabs.txt\"]').click()");
    check('两个文件各有顶部标签', await waitFor("document.querySelectorAll('#editor-tabs [role=tab]').length === 2 && document.getElementById('file-name').textContent === 'tabs.txt'"));
    await evaluate("window.monaco.editor.getEditors()[0].getModel().setValue('tab draft B'); document.querySelector('#editor-tabs [role=tab][data-path=\"a.txt\"]').click()");
    check('点击标签恢复草稿、同一模型及光标', await waitFor("document.getElementById('file-name').textContent === 'a.txt'") && await evaluate("window.monaco.editor.getEditors()[0].getModel() === window.__tabModelA && window.__tabModelA.getValue() === 'tab draft A' && window.monaco.editor.getEditors()[0].getPosition().column === 5"));
    check('各标签独立显示未保存标记', await evaluate("document.querySelectorAll('#editor-tabs .editor-tab.dirty').length === 2"));
    await evaluate("window.monaco.editor.getEditors()[0].trigger('workspace-probe','undo',null)");
    check('切换标签后撤销栈仍有效', await evaluate("window.monaco.editor.getEditors()[0].getModel().getValue() === 'A original'"));
    await evaluate("window.monaco.editor.getEditors()[0].trigger('workspace-probe','redo',null)");
    check('重做恢复当前标签草稿', await evaluate("window.monaco.editor.getEditors()[0].getModel().getValue() === 'tab draft A'"));
    await evaluate("document.querySelector('#editor-tabs [role=tab][data-path=\"a.txt\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
    check('方向键可切换标签且恢复另一草稿', await waitFor("document.getElementById('file-name').textContent === 'tabs.txt'") && await evaluate("window.monaco.editor.getEditors()[0].getModel().getValue() === 'tab draft B'"));
    choice = 2; await evaluate("document.querySelector('#editor-tabs .editor-tab-close[data-path=\"a.txt\"]').click()"); await pause();
    check('关闭非活动脏标签取消后两个草稿保留', await evaluate("document.querySelectorAll('#editor-tabs [role=tab]').length === 2 && window.monaco.editor.getEditors()[0].getModel().getValue() === 'tab draft B'"));
    choice = 0; await evaluate("document.querySelector('#editor-tabs .editor-tab-close[data-path=\"a.txt\"]').click()");
    check('关闭非活动标签保存到对应文件', await waitFor("document.querySelectorAll('#editor-tabs [role=tab]').length === 1") && fs.readFileSync(path.join(a, 'a.txt'), 'utf8') === 'tab draft A' && await evaluate("document.getElementById('file-name').textContent === 'tabs.txt'"));
    choice = 1; await evaluate("document.querySelector('#editor-tabs .editor-tab-close[data-path=\"tabs.txt\"]').click()");
    check('放弃最后一个标签回到空白页且不写盘', await waitFor("document.getElementById('file-name').textContent === '未打开文件'") && fs.readFileSync(path.join(a, 'tabs.txt'), 'utf8') === 'tab original');
    await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"a.txt\"]').click()"); await waitFor("document.getElementById('file-name').textContent === 'a.txt'");
    // 只操作本地 Monaco，不向网页派发任何事件。
    await evaluate("window.monaco.editor.getEditors()[0].getModel().setValue('draft A')"); await pause();
    // 用真实不可写目标验证保存失败不会切换目录，随后恢复样例文件。
    fs.renameSync(path.join(a, 'a.txt'), path.join(a, 'preserved.txt')); fs.mkdirSync(path.join(a, 'a.txt'));
    picked = b; choice = 0; await evaluate("document.getElementById('btn-open').click()");
    const failedSave = await waitFor("document.getElementById('info').textContent.includes('保存失败')");
    check('保存失败保留原目录和草稿', failedSave && controller.workspace.getState().root === a && await evaluate("window.monaco.editor.getEditors()[0].getModel().getValue() === 'draft A'"));
    fs.rmdirSync(path.join(a, 'a.txt')); fs.renameSync(path.join(a, 'preserved.txt'), path.join(a, 'a.txt'));
    picked = b; choice = 2; await evaluate("document.getElementById('btn-open').click()"); await pause();
    check('取消切换保留目录和草稿', controller.workspace.getState().root === a && await evaluate("window.monaco.editor.getEditors()[0].getModel().getValue() === 'draft A'"));
    choice = 0; await evaluate("document.getElementById('btn-open').click()");
    check('保存后切换目录且清空旧编辑', await waitFor(`window.editorBridge.getRoot().then(s => s.root === ${JSON.stringify(b)})`) && await evaluate("document.getElementById('file-name').textContent === '未打开文件'"));
    check('保存回执确实写入原目录', fs.readFileSync(path.join(a, 'a.txt'), 'utf8') === 'draft A' && fs.readFileSync(path.join(b, 'a.txt'), 'utf8') === 'B original');
    check('目录历史同步到最近列表', controller.workspace.getState().recentRoots[0] === b && controller.workspace.getState().recentRoots[1] === a);
    // 回到 A 并使用树内输入新建文件夹及其内部文件。
    choice = 1; await controller.openRecent(1); await waitFor("Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"sub\"]'))");
    fs.writeFileSync(path.join(a, 'keep.txt'), 'keep original');
    const fixture = path.join(directory, 'reply.html');
    fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><main class="ds-markdown"><pre><code>// a.txt\nA changed</code></pre><pre><code>// keep.txt\nkeep changed</code></pre></main>');
    // 加载自有静态测试页面；采集仍调用生产只读脚本，绝不改官方页面 DOM。
    await web.loadURL(pathToFileURL(fixture).href);
    const collected = await evaluate<{ ok: boolean; collectionId: string; blocks: Array<{ index: number; filePath: string }> }>('window.editorBridge.collectReply()');
    check('真实回程链路解析两个文件', collected.ok && collected.blocks.length === 2 && collected.blocks.some(block => block.filePath === 'a.txt') && collected.blocks.some(block => block.filePath === 'keep.txt'), collected.blocks.map((block) => block.filePath));
    const first = collected.blocks.find((block) => block.filePath === 'a.txt'); const keep = collected.blocks.find((block) => block.filePath === 'keep.txt');
    if (first && keep) {
      await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"a.txt\"]').click()");
      check('AI 目标文件已打开', await waitFor("document.getElementById('file-name').textContent === 'a.txt'")); await pause();
      await evaluate("window.monaco.editor.getEditors()[0].getModel().setValue('new local draft')"); await pause();
      await evaluate("document.getElementById('file-refresh').click()"); await waitFor("Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"keep.txt\"]'))");
      await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"keep.txt\"]').click()"); await waitFor("document.getElementById('file-name').textContent === 'keep.txt'"); await pause();
      const dirtyTarget = await evaluate<{ ok: boolean }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: collected.collectionId, index: first.index, filePath: path.join(a, 'a.txt') })})`);
      check('AI 绝对路径不能覆盖非活动标签草稿', !dirtyTarget.ok && fs.readFileSync(path.join(a, 'a.txt'), 'utf8') === 'draft A', dirtyTarget);
      await evaluate("document.querySelector('#editor-tabs [role=tab][data-path=\"a.txt\"]').click()");
      await evaluate("window.monaco.editor.getEditors()[0].getModel().setValue('draft A')"); await pause();
      const applied = await evaluate<{ ok: boolean }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: collected.collectionId, index: first.index, filePath: 'a.txt' })})`);
      check('AI 应用写入当前目录', applied.ok && fs.readFileSync(path.join(a, 'a.txt'), 'utf8') === 'A changed');
      const renamed = await evaluate<{ ok: boolean }>(`window.editorBridge.renameEntry('a.txt','moved.txt',${JSON.stringify(a)})`);
      const expired = await evaluate<{ ok: boolean }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: collected.collectionId, index: first.index, filePath: 'a.txt' })})`);
      check('改名后旧路径变更和撤销记录失效', renamed.ok && !expired.ok && !(await evaluate<{ ok: boolean }>('window.editorBridge.undoSave()')).ok);
      const kept = await evaluate<{ ok: boolean }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: collected.collectionId, index: keep.index, filePath: 'keep.txt' })})`);
      check('不受改名影响的片段仍可应用', kept.ok && fs.readFileSync(path.join(a, 'keep.txt'), 'utf8') === 'keep changed');
      await pause(); await evaluate("document.querySelector('#editor-tabs [role=tab][data-path=\"keep.txt\"]').click()");
      check('AI 写回刷新非活动已保存标签', await waitFor("document.getElementById('file-name').textContent === 'keep.txt'") && await evaluate("window.monaco.editor.getEditors()[0].getModel().getValue() === 'keep changed'"));
      choice = 0; await controller.openRecent(1);
      const stale = await evaluate<{ ok: boolean }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: collected.collectionId, index: keep.index, filePath: 'a.txt' })})`);
      const oldSave = await evaluate<{ ok: boolean }>(`window.editorBridge.writeFile('a.txt','bad old save',${JSON.stringify(a)})`);
      const oldSnippet = await evaluate<{ ok: boolean }>(`window.editorBridge.copyNumberedSnippet(${JSON.stringify({ root: a, relPath: 'a.txt', text: 'old snippet', startLine: 1 })})`);
      check('延迟旧片段不能污染新目录基线', !oldSnippet.ok);
      check('切换目录拒绝旧批次、撤销及延迟保存', !stale.ok && !oldSave.ok && !(await evaluate<{ ok: boolean }>('window.editorBridge.undoSave()')).ok && fs.readFileSync(path.join(b, 'a.txt'), 'utf8') === 'B original');
      await controller.openRecent(1); await waitFor("Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"sub\"]'))");
    }
    await evaluate("document.getElementById('folder-new').click()");
    check('新建名称输入框可用', await waitFor("Boolean(document.querySelector('.tree-name-input'))"));
    await evaluate("const input=document.querySelector('.tree-name-input'); input.value='notes'; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
    check('新建目录自动展开', await waitFor("Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"notes\"][aria-expanded=\"true\"]'))"));
    await evaluate("document.getElementById('file-new').click()"); await waitFor("Boolean(document.querySelector('.tree-name-input'))");
    await evaluate("const input=document.querySelector('.tree-name-input'); input.value='note.md'; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
    check('选中文件夹下新建文件并打开', await waitFor("document.getElementById('file-name').textContent === 'notes/note.md'") && fs.existsSync(path.join(a, 'notes/note.md')));
    await evaluate("window.monaco.editor.getEditors()[0].getModel().setValue('unsaved note')"); await pause();
    await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"notes/note.md\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'F2',bubbles:true}))");
    await waitFor("Boolean(document.querySelector('.tree-name-input'))");
    await evaluate("const input=document.querySelector('.tree-name-input'); input.value='renamed.md'; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
    check('F2 改名更新路径并保留未保存缓冲', await waitFor("document.getElementById('file-name').textContent === 'notes/renamed.md'") && await evaluate("window.monaco.editor.getEditors()[0].getModel().getValue() === 'unsaved note'"));
    check('文件树操作按钮有名称且处于可见范围', await evaluate(`['file-new','folder-new','file-refresh'].every(id => {
      const button = document.getElementById(id); const r = button.getBoundingClientRect();
      return Boolean(button.getAttribute('aria-label')) && r.width > 0 && r.left >= 0 && r.right <= innerWidth;
    })`));
    await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"notes/renamed.md\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'F2',bubbles:true}))");
    await waitFor("Boolean(document.querySelector('.tree-name-input'))");
    await evaluate("document.querySelector('.tree-name-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    check('Esc 取消改名不改变文件与草稿', fs.existsSync(path.join(a, 'notes/renamed.md')) && await evaluate("!document.querySelector('.tree-name-input') && window.monaco.editor.getEditors()[0].getModel().getValue() === 'unsaved note'"));
    await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"notes/renamed.md\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))");
    check('键盘可打开文件右键菜单', await waitFor("document.querySelectorAll('.file-menu [role=menuitem]').length === 4"));
    await evaluate("document.querySelector('.file-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await evaluate("document.getElementById('file-new').click()"); await waitFor("Boolean(document.querySelector('.tree-name-input'))");
    await evaluate("const input=document.querySelector('.tree-name-input'); input.value='renamed.md'; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
    check('树内重名错误可见且不覆盖文件', await waitFor("Boolean(document.querySelector('.tree-name-error').textContent)") && fs.readFileSync(path.join(a, 'notes/renamed.md'), 'utf8') === '');
    await evaluate("document.querySelector('.tree-name-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    const renamedFolder = await evaluate<{ ok: boolean }>(`window.editorBridge.renameEntry('notes','renamed-notes',${JSON.stringify(a)})`);
    check('文件夹改名更新内部文件路径并保留草稿', renamedFolder.ok && await waitFor("document.getElementById('file-name').textContent === 'renamed-notes/renamed.md'") && await evaluate("window.monaco.editor.getEditors()[0].getModel().getValue() === 'unsaved note'"));
    await evaluate("document.getElementById('tree').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:40,clientY:250}))");
    check('树空白右键显示根目录三项菜单', await waitFor("document.querySelectorAll('.file-menu [role=menuitem]').length === 3"));
    await evaluate("document.querySelector('.file-menu [role=menuitem]').click()"); await waitFor("Boolean(document.querySelector('.tree-name-input'))");
    await evaluate("const input=document.querySelector('.tree-name-input'); input.value='root-file.txt'; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
    check('空白菜单新建到根目录而非此前选中文件夹', await waitFor("document.getElementById('file-name').textContent === 'root-file.txt'") && fs.existsSync(path.join(a, 'root-file.txt')) && !fs.existsSync(path.join(a, 'renamed-notes/root-file.txt')));
    picked = b; choice = 2; await evaluate("document.getElementById('btn-open').click()"); await pause();
    check('当前标签干净时切换目录仍检查后台草稿', controller.workspace.getState().root === a && await evaluate("document.querySelectorAll('#editor-tabs [role=tab]').length === 2"));
    await evaluate("document.getElementById('sidebar').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:40,clientY:350})); document.querySelectorAll('.file-menu [role=menuitem]')[1].click()"); await waitFor("Boolean(document.querySelector('.tree-name-input'))");
    await evaluate("const input=document.querySelector('.tree-name-input'); input.value='root-folder'; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
    check('侧栏空白菜单支持根目录新建文件夹', await waitFor("Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"root-folder\"]'))") && fs.statSync(path.join(a, 'root-folder')).isDirectory());
    await evaluate("document.querySelector('#editor-tabs [role=tab][data-path=\"renamed-notes/renamed.md\"]').click()"); choice = 1;
    // 保存再验证真实回收站，不删除任何用户文件。
    const leave = await evaluate<{ ok: boolean }>('window.editorBridge.confirmLeave()');
    check('放弃确认不提前清空缓冲', leave.ok && await evaluate("window.monaco.editor.getEditors()[0].getModel().getValue() === 'unsaved note'"));
    choice = 0;
    const savedRenamed = await evaluate<{ ok: boolean }>('window.editorBridge.confirmLeave()');
    check('改名后保存确实写向新路径', savedRenamed.ok && fs.readFileSync(path.join(a, 'renamed-notes/renamed.md'), 'utf8') === 'unsaved note' && !fs.existsSync(path.join(a, 'notes')));
    const deleted = await evaluate<{ ok: boolean }>(`window.editorBridge.trashEntry('renamed-notes/renamed.md', ${JSON.stringify(a)})`);
    check('删除只关闭受影响标签并切回剩余文件', deleted.ok && !fs.existsSync(path.join(a, 'renamed-notes/renamed.md')) && await waitFor("document.getElementById('file-name').textContent === 'root-file.txt' && document.querySelectorAll('#editor-tabs [role=tab]').length === 1"));
    const closed = await controller.closeRoot();
    check('关闭目录保留历史并清除恢复记录', closed.ok === true && controller.workspace.getState().root === null && controller.workspace.getState().recentRoots.length === 2);
    check('空白区有打开入口和最近目录', await waitFor("!document.getElementById('workspace-welcome').hidden && document.querySelectorAll('.recent-folders button').length===2"));
  } catch (error) { check('探针执行无异常', false, error instanceof Error ? error.stack : String(error)); }
  finally { dialog.showMessageBox = originalBox; dialog.showOpenDialog = originalOpen; }
  return { checks, pass: checks.every((item) => item.pass), temporaryDirectory: directory };
}
