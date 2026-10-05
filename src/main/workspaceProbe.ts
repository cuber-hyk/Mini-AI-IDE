/** 隔离临时目录、离线 Electron 本地界面验收；不接触官方网页或用户文件。 */
import { app, clipboard, dialog, type WebContents } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseModelReply, splitFences } from '../shared/returnPath';
import type { ReturnPreview } from '../shared/contract';
import type { WorkspaceController } from './workspaceController';

export function configureWorkspaceProbe(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-workspace-probe-'));
  app.setPath('userData', directory);
  return directory;
}

export async function runWorkspaceProbe(view: WebContents, web: WebContents, preview: WebContents, controller: WorkspaceController, directory: string) {
  const checks: Array<{ name: string; pass: boolean; observed?: unknown }> = [];
  const check = (name: string, pass: boolean, observed?: unknown) => checks.push({ name, pass, observed });
  const evaluate = <T = unknown>(script: string): Promise<T> => view.executeJavaScript(script.startsWith('const ') ? `(() => { ${script} })()` : script, true);
  const previewEvaluate = <T = unknown>(script: string): Promise<T> => preview.executeJavaScript(script, true);
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
    fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><main class="ds-markdown"><h3>文件：a.txt</h3><h3>操作：覆盖全文</h3><pre><code>A changed</code></pre><h3>文件：keep.txt</h3><h3>操作：覆盖全文</h3><pre><code>keep changed</code></pre></main>');
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
    check('新建目录自动展开', await waitFor("Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"notes\"][aria-expanded=\"true\"][aria-selected=\"true\"]'))"));
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
    const creationFixture = path.join(directory, 'creation-reply.html');
    fs.writeFileSync(creationFixture, '<!doctype html><meta charset="utf-8"><main class="ds-markdown"><h3>文件：generated/deep/new.ts</h3>\n<h3>操作：新建</h3>\n<pre><code>const created = 1;\nconst second = 2;</code></pre><h3>文件：race.txt</h3>\n<h3>操作：新建</h3>\n<pre><code>AI creation</code></pre></main>');
    await web.loadURL(pathToFileURL(creationFixture).href);
    const creation = await evaluate<{ ok: boolean; collectionId: string; blocks: Array<{ index: number; filePath: string; applicable: boolean; fileExists: boolean; diff: { added: number; removed: number } }> }>('window.editorBridge.collectReply()');
    const fresh = creation.blocks.find(block => block.filePath === 'generated/deep/new.ts');
    const race = creation.blocks.find(block => block.filePath === 'race.txt');
    check('缺失文件采集可应用且标为新增', creation.ok && Boolean(fresh && fresh.applicable && !fresh.fileExists), creation.blocks);
    if (fresh && race) {
      check('新增预览打开虚拟标签和只读模型', await waitFor("document.getElementById('file-name').textContent === 'generated/deep/new.ts'") && await evaluate("window.monaco.editor.getEditors()[0].getModel().getValue() === '' && window.monaco.editor.getEditors()[0].getRawOptions().readOnly === true && document.querySelectorAll('#editor-tabs [role=tab]').length === 2"));
      check('新增预览纯绿色且按钮为创建文件', await waitFor("document.querySelectorAll('.inline-added').length === 2 && document.getElementById('btn-diff-apply').textContent === '创建文件'") && await evaluate("document.querySelectorAll('.inline-deleted').length === 0"));
      check('采集及虚拟预览不提前创建目录', !fs.existsSync(path.join(a, 'generated')) && !fs.existsSync(path.join(a, 'race.txt')));
      await evaluate("document.getElementById('btn-diff-close').click()");
      check('退出新增预览释放标签且保留原文件', await waitFor("document.getElementById('file-name').textContent === 'root-file.txt' && document.querySelectorAll('#editor-tabs [role=tab]').length === 1") && !fs.existsSync(path.join(a, 'generated')));
      await evaluate(`window.editorBridge.showDiffInEditor(${JSON.stringify(creation.collectionId)},${fresh.index})`);
      await waitFor("document.getElementById('file-name').textContent === 'generated/deep/new.ts'");
      await evaluate("document.getElementById('btn-diff-apply').click()");
      check('创建按钮实际写入文件及多级目录', await waitFor("window.monaco.editor.getEditors()[0].getModel().getValue() === 'const created = 1;\\nconst second = 2;'") && fs.readFileSync(path.join(a, fresh.filePath), 'utf8') === 'const created = 1;\nconst second = 2;');
      check('创建后虚拟标签转为真实可编辑标签', await evaluate("window.monaco.editor.getEditors()[0].getRawOptions().readOnly === false && document.querySelectorAll('#editor-tabs [role=tab]').length === 2"));
      check('创建后目录树自动刷新', await waitFor("Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"generated\"]'))"));
      const undone = await evaluate<{ ok: boolean; deleted?: boolean; index?: number }>('window.editorBridge.undoSave()');
      check('撤销新增删除文件及本次空目录', undone.ok && undone.deleted === true && undone.index === fresh.index && !fs.existsSync(path.join(a, 'generated')));
      check('撤销只关闭新增标签并刷新树', await waitFor("document.getElementById('file-name').textContent === 'root-file.txt' && document.querySelectorAll('#editor-tabs [role=tab]').length === 1 && !document.querySelector('#tree .tree-row[data-rel-path=\"generated\"]')"));
      const reapplied = await evaluate<{ ok: boolean; created?: boolean }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: creation.collectionId, index: fresh.index, filePath: fresh.filePath })})`);
      check('撤销后同一片段可重新创建', reapplied.ok && reapplied.created === true);
      await waitFor("document.getElementById('file-name').textContent === 'generated/deep/new.ts'");
      await evaluate('window.editorBridge.undoSave()');
      await waitFor("document.getElementById('file-name').textContent === 'root-file.txt'");
      const retargeted = await evaluate<{ ok: boolean; reason?: string }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: creation.collectionId, index: race.index, filePath: 'root-file.txt' })})`);
      check('新增改路径不能变成覆盖已有文件', !retargeted.ok && retargeted.reason === 'target-exists' && fs.readFileSync(path.join(a, 'root-file.txt'), 'utf8') === '');
      fs.writeFileSync(path.join(a, race.filePath), 'external content');
      const conflict = await evaluate<{ ok: boolean; reason?: string }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: creation.collectionId, index: race.index, filePath: race.filePath })})`);
      check('预览后出现同名文件拒绝覆盖', !conflict.ok && conflict.reason === 'target-changed' && fs.readFileSync(path.join(a, race.filePath), 'utf8') === 'external content');
    }
    // 从历史用户样本保留全文生成的新建协议样本按 Markdown 的语义 DOM 渲染，覆盖采集→关联→完整创建→撤销。
    const backendReply = fs.readFileSync(path.join(app.getAppPath(), 'test/fixtures/backend-foundation-explicit-reply.md'), 'utf8');
    const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const markup: string[] = []; let offset = 0;
    const appendProse = (text: string) => {
      for (const line of text.split(/\r\n|\r|\n/)) {
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        markup.push(heading ? `<h${heading[1]!.length}>${escapeHtml(heading[2]!)}</h${heading[1]!.length}>`
          : /^---$/.test(line) ? '<hr>' : `<p>${escapeHtml(line)}</p>`);
      }
    };
    for (const fence of splitFences(backendReply)) {
      appendProse(backendReply.slice(offset, fence.start));
      markup.push(`<pre><code class="language-${fence.info}">${escapeHtml(fence.body)}</code></pre>`); offset = fence.end;
    }
    appendProse(backendReply.slice(offset));
    const backendFixture = path.join(directory, 'backend-reply.html');
    fs.writeFileSync(backendFixture, '<!doctype html><meta charset="utf-8"><main class="ds-markdown">' + markup.join('\n') + '</main>');
    await web.loadURL(pathToFileURL(backendFixture).href);
    const backend = await evaluate<ReturnPreview>('window.editorBridge.collectReply()');
    const expected = parseModelReply(backendReply).blocks;
    check('真实回复五文件与命令逐块关联', backend.ok && backend.blocks.length === 6 &&
      backend.blocks.every((block, index) => block.filePath === expected[index]!.filePath && block.operation === expected[index]!.operation), backend.blocks.map(block => ({ file: block.filePath, operation: block.operation, lines: block.codeLines, kind: block.kind })));
    check('操作全文实际行数保留，不使用 AI 定位行号', JSON.stringify(backend.blocks.map(block => block.codeLines)) === '[35,18,4,109,84,5]');
    check('五个新文件可应用，命令只读', backend.blocks.filter(block => block.applicable).length === 5 && backend.blocks[5]?.kind === 'other' && !backend.blocks[5].applicable);
    await pause();
    check('预览统计只计文件与其他内容', await previewEvaluate("document.getElementById('pv-meta').textContent === '5 文件 · 1 段其他内容'"));
    check('采集诊断默认关闭且无常驻状态区', await previewEvaluate("!document.getElementById('pv-diagnostics').open && document.getElementById('pv-status').hidden && document.getElementById('pv-diagnostics').getBoundingClientRect().height <= document.querySelector('#pv-diagnostics > summary').getBoundingClientRect().height + 2"));
    await previewEvaluate("document.querySelector('#pv-diagnostics > summary').click()"); await pause();
    check('诊断入口可展开查看采集信息', await previewEvaluate("document.getElementById('pv-diagnostics').open && document.getElementById('pv-notes').textContent.includes('采集：策略') && document.getElementById('pv-notes').getBoundingClientRect().height > 0"));
    await previewEvaluate("document.querySelector('#pv-diagnostics > summary').click()");
    check('其他内容默认折叠', await previewEvaluate("Boolean(document.querySelector('.pv-other')) && !document.querySelector('.pv-other').open && !document.getElementById('pv-list').textContent.includes('未指定文件')"));
    await previewEvaluate("document.querySelector('.pv-other > summary').click()"); await pause();
    await previewEvaluate("document.querySelector('.pv-other .pv-select').click()"); await pause();
    check('展开其他内容可查看完整五行命令，无应用或改路径入口', await previewEvaluate("document.querySelector('.pv-other').open && document.querySelector('.pv-content').textContent.split('\\n').length === 5 && document.querySelector('.pv-content').textContent.includes('npm run seed') && !document.querySelector('#pv-detail button')"));
    check('多文件采集预览不创建目录', !fs.existsSync(path.join(a, 'ecommerce-demo')));
    const shellAttempt = await evaluate<{ ok: boolean; reason?: string }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: backend.collectionId, index: 5, filePath: 'commands.sh' })})`);
    check('只读命令不能通过应用接口创建文件', !shellAttempt.ok && shellAttempt.reason === 'read-only-content' && !fs.existsSync(path.join(a, 'commands.sh')));
    let createdFiles = 0; let correctFiles = 0;
    for (const block of backend.blocks.filter(block => block.applicable)) {
      const result = await evaluate<{ ok: boolean }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: backend.collectionId, index: block.index, filePath: block.filePath })})`);
      if (result.ok) {
        createdFiles++;
        if (fs.readFileSync(path.join(a, block.filePath!), 'utf8') === expected[block.index]!.code.replace(/\r\n|\r/g, '\n')) correctFiles++;
      }
    }
    check('五文件各写入完整且正确的内容', createdFiles === 5 && correctFiles === 5, { createdFiles, correctFiles });
    for (let i = 0; i < createdFiles; i++) await evaluate('window.editorBridge.undoSave()');
    check('批次新建撤销恢复目录不存在', !fs.existsSync(path.join(a, 'ecommerce-demo')));
    await waitFor("document.getElementById('file-name').textContent === 'root-file.txt'");
    // 复制过片段也不能为后续缺失元数据的块兜底。
    await evaluate("document.getElementById('file-refresh').click()");
    await waitFor("Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"keep.txt\"]'))");
    await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"keep.txt\"]').click()");
    await waitFor("document.getElementById('file-name').textContent === 'keep.txt'");
    await evaluate(`window.editorBridge.copyNumberedSnippet(${JSON.stringify({ root: a, relPath: 'keep.txt', text: 'keep changed', startLine: 1 })})`);
    const incompleteFixture = path.join(directory, 'incomplete-reply.html');
    fs.writeFileSync(incompleteFixture, '<!doctype html><meta charset="utf-8"><main class="ds-markdown"><h3>文件：keep.txt</h3><pre><code class="language-text">wrong overwrite</code></pre><hr><h3>范围：1-1</h3><pre><code class="language-ts">const unknown = 1;</code></pre><hr><h3>文件：valid/new.ts</h3><h3>操作：新建</h3><pre><code class="language-ts">const valid = 1;</code></pre></main>');
    await web.loadURL(pathToFileURL(incompleteFixture).href);
    const incomplete = await evaluate<ReturnPreview>('window.editorBridge.collectReply()');
    check('复制上下文不回填缺失操作或路径，旧范围明确拒绝', incomplete.blocks.length === 3 && !incomplete.blocks[0]!.applicable && incomplete.blocks[0]!.range === null && incomplete.blocks[1]!.filePath === null && !incomplete.blocks[1]!.applicable && incomplete.blocks[2]!.applicable, incomplete.blocks.map(block => ({ file: block.filePath, range: block.range, applicable: block.applicable })));
    check('编辑器导航跳过缺失元数据条目', await waitFor("document.getElementById('file-name').textContent === 'valid/new.ts' && document.getElementById('btn-diff-prev').disabled && document.getElementById('btn-diff-next').disabled"));
    for (const index of [0, 1]) {
      const result = await evaluate<{ ok: boolean }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: incomplete.collectionId, index, filePath: 'keep.txt' })})`);
      check('缺失元数据应用入口拒绝块' + index, !result.ok && fs.readFileSync(path.join(a, 'keep.txt'), 'utf8') === 'keep changed');
    }
    const valid = await evaluate<{ ok: boolean }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: incomplete.collectionId, index: 2, filePath: 'valid/new.ts' })})`);
    check('缺失元数据不阻塞同批次有效文件', valid.ok && fs.readFileSync(path.join(a, 'valid/new.ts'), 'utf8') === 'const valid = 1;');
    if (valid.ok) {
      fs.renameSync(path.join(a, 'valid/new.ts'), path.join(a, 'valid/original.ts'));
      fs.writeFileSync(path.join(a, 'valid/new.ts'), 'const valid = 1;');
      const identityUndo = await evaluate<{ ok: boolean }>('window.editorBridge.undoSave()');
      check('新建撤销拒绝外部替换的同名同内容文件', !identityUndo.ok && fs.readFileSync(path.join(a, 'valid/new.ts'), 'utf8') === 'const valid = 1;');
      fs.unlinkSync(path.join(a, 'valid/new.ts')); fs.renameSync(path.join(a, 'valid/original.ts'), path.join(a, 'valid/new.ts'));
      const restoredUndo = await evaluate<{ ok: boolean; deleted?: boolean }>('window.editorBridge.undoSave()');
      check('移回本次创建对象后撤销记录可重试', restoredUndo.ok && restoredUndo.deleted === true && !fs.existsSync(path.join(a, 'valid')));
    }
    // 新协议定位、已展示基线和自己的成功写入推进，用自有静态网页走真实 IPC。
    const protocolFile = path.join(a, 'protocol.txt');
    const protocolBefore = 'head\nfirst();\nmid\nsecond();\ntail\n';
    fs.writeFileSync(protocolFile, protocolBefore);
    await evaluate("document.getElementById('file-refresh').click()");
    await waitFor("Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"protocol.txt\"]'))");
    await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"protocol.txt\"]').click()");
    await waitFor("document.getElementById('file-name').textContent === 'protocol.txt'");
    const copiedText = '\n\tunsaved text  \n\n';
    await evaluate(`window.monaco.editor.getEditors()[0].getModel().setValue(${JSON.stringify(copiedText)})`); await pause();
    const copiedWhole = await evaluate<{ ok: boolean; snippet: string }>(`window.editorBridge.copyWholeFile(${JSON.stringify({ root: a, relPath: 'protocol.txt', text: copiedText })})`);
    check('全文复制来自 Monaco 草稿而非磁盘，保留所有空白且只读', copiedWhole.ok && parseModelReply(await clipboard.readText()).blocks[0]?.code === copiedText && parseModelReply(copiedWhole.snippet).blocks[0]?.kind === 'other' && fs.readFileSync(protocolFile, 'utf8') === protocolBefore);
    await evaluate(`window.monaco.editor.getEditors()[0].getModel().setValue(${JSON.stringify(protocolBefore)})`); await pause();
    const editHtml = (file: string, oldText: string, newText: string) =>
      '<h3>文件：' + escapeHtml(file) + '</h3><p>操作：替换</p><pre><code>' + escapeHtml(['<<<<<<< SEARCH', oldText, '=======', newText, '>>>>>>> REPLACE'].join('\n')) + '</code></pre>';
    const protocolFixture = path.join(directory, 'protocol-reply.html');
    const loadProtocolReply = async (html: string) => {
      fs.writeFileSync(protocolFixture, '<!doctype html><meta charset="utf-8"><main class="ds-markdown">' + html + '</main>');
      await web.loadURL(pathToFileURL(protocolFixture).href);
      return evaluate<ReturnPreview>('window.editorBridge.collectReply()');
    };
    await previewEvaluate('window.__protocolPreview = null; window.previewBridge.onPreviewData(data => { window.__protocolPreview = data; })');
    const twoEdits = await loadProtocolReply(editHtml('protocol.txt', 'first();', 'first();\ninserted();') + editHtml('protocol.txt', 'second();', 'secondDone();'));
    check('同文件两段 SEARCH 根据同一原文独立唯一定位', twoEdits.blocks.length === 2 && twoEdits.blocks.every(block => block.applicable && block.operation === 'replace') && twoEdits.blocks[0]?.locations?.[0]?.oldRange?.start === 2 && twoEdits.blocks[1]?.locations?.[0]?.oldRange?.start === 4, twoEdits.blocks);
    const upper = await evaluate<{ ok: boolean }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: twoEdits.collectionId, index: 0, filePath: 'protocol.txt' })})`);
    await pause();
    check('上方插入成功后下方预览真实范围重算为第五行', upper.ok && await previewEvaluate("window.__protocolPreview && window.__protocolPreview.blocks[1].locations[0].oldRange.start === 5"));
    const lower = await evaluate<{ ok: boolean }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: twoEdits.collectionId, index: 1, filePath: 'protocol.txt' })})`);
    check('下方继续应用保留上方插入与未修改的末尾换行', lower.ok && fs.readFileSync(protocolFile, 'utf8') === 'head\nfirst();\ninserted();\nmid\nsecondDone();\ntail\n');
    const undoLower = await evaluate<{ ok: boolean }>('window.editorBridge.undoSave()');
    const undoUpper = await evaluate<{ ok: boolean }>('window.editorBridge.undoSave()');
    check('同文件两操作按顺序撤销，准确恢复完整原文', undoLower.ok && undoUpper.ok && fs.readFileSync(protocolFile, 'utf8') === protocolBefore);
    const stale = await loadProtocolReply(editHtml('protocol.txt', 'first();', 'stale replacement();'));
    const externalText = protocolBefore + 'external change\n'; fs.writeFileSync(protocolFile, externalText);
    const staleApply = await evaluate<{ ok: boolean; reason?: string }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: stale.collectionId, index: 0, filePath: 'protocol.txt' })})`);
    check('预览后外部改动拒绝写入，不重建基线覆盖外部内容', !staleApply.ok && staleApply.reason === 'target-changed' && fs.readFileSync(protocolFile, 'utf8') === externalText, staleApply);
    fs.writeFileSync(path.join(a, 'repeated.txt'), 'same\nsame\n');
    const mismatches = await loadProtocolReply(editHtml('protocol.txt', 'missing original', 'wrong') + editHtml('repeated.txt', 'same', 'wrong'));
    check('原文零次和多次匹配均显示具体阻塞，两个文件保持不变', mismatches.blocks.length === 2 && mismatches.blocks.every(block => !block.applicable) && mismatches.blocks[0]?.blockedReason?.includes('不匹配') === true && mismatches.blocks[1]?.blockedReason?.includes('多次') === true && fs.readFileSync(protocolFile, 'utf8') === externalText && fs.readFileSync(path.join(a, 'repeated.txt'), 'utf8') === 'same\nsame\n', mismatches.blocks);
    const legacy = await loadProtocolReply('<h3>文件：protocol.txt</h3><h3>范围：1-1</h3><pre><code>legacy content</code></pre>');
    const legacyApply = await evaluate<{ ok: boolean }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: legacy.collectionId, index: 0, filePath: 'protocol.txt' })})`);
    check('旧行号回复有可见新版格式诊断且应用入口拒绝', legacy.blocks.length === 1 && !legacy.blocks[0]!.applicable && Boolean(legacy.blocks[0]!.blockedReason) && !legacyApply.ok && fs.readFileSync(protocolFile, 'utf8') === externalText, legacy.blocks);
    const empty = await loadProtocolReply('<h3>文件：empty-created.txt</h3><p>操作：新建</p><pre><code></code></pre>');
    const emptyApply = await evaluate<{ ok: boolean; created?: boolean }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: empty.collectionId, index: 0, filePath: 'empty-created.txt' })})`);
    check('明确空代码框可预览并创建真正空文件', empty.blocks[0]?.applicable === true && empty.blocks[0]?.codeChars === 0 && emptyApply.ok && emptyApply.created === true && fs.readFileSync(path.join(a, 'empty-created.txt'), 'utf8') === '', empty.blocks);
    const emptyUndo = await evaluate<{ ok: boolean; deleted?: boolean }>('window.editorBridge.undoSave()');
    check('空文件创建可撤销且仅删除本次对象', emptyUndo.ok && emptyUndo.deleted === true && !fs.existsSync(path.join(a, 'empty-created.txt')));
    const retarget = await loadProtocolReply('<h3>文件：retarget-a.txt</h3><p>操作：新建</p><pre><code>retarget content</code></pre>');
    const movedPreview = await evaluate<{ ok: boolean }>(`window.editorBridge.showDiffInEditor('${retarget.collectionId}', 0, 'retarget-b.txt')`);
    const movedApply = await evaluate<{ ok: boolean }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: retarget.collectionId, index: 0, filePath: 'retarget-b.txt' })})`);
    const movedUndo = await evaluate<{ ok: boolean }>('window.editorBridge.undoSave()');
    const nextPreview = await evaluate<{ ok: boolean }>(`window.editorBridge.showDiffInEditor('${retarget.collectionId}', 0, 'retarget-c.txt')`);
    check('撤销后重新改目标，右列预览采用新路径而不是历史应用路径', movedPreview.ok && movedApply.ok && movedUndo.ok && nextPreview.ok && await previewEvaluate("window.__protocolPreview.blocks[0].filePath === 'retarget-c.txt'"));
    const nextApply = await evaluate<{ ok: boolean }>(`window.editorBridge.applyChange(${JSON.stringify({ collectionId: retarget.collectionId, index: 0, filePath: 'retarget-c.txt' })})`);
    check('再次修改目标的实际写入与预览一致，撤销恢复不存在', nextApply.ok && fs.readFileSync(path.join(a, 'retarget-c.txt'), 'utf8') === 'retarget content' && !fs.existsSync(path.join(a, 'retarget-b.txt')) && (await evaluate<{ ok: boolean }>('window.editorBridge.undoSave()')).ok);
    const missingCode = await loadProtocolReply('<h3>文件：missing-code.txt</h3><p>操作：新建</p>');
    check('最新回复只有头部不会借用历史空文件代码，缺失围栏明确阻塞', missingCode.blocks.length === 1 && !missingCode.blocks[0]!.applicable && !fs.existsSync(path.join(a, 'missing-code.txt')), missingCode.blocks);
    // 多标签仅来自隔离目录，以真实 Chromium 滚动与 CSS 伪元素验证标签条。
    const tabPaths = Array.from({ length: 10 }, (_, i) => 'scroll-tab-' + i + '.txt');
    for (const relative of tabPaths) fs.writeFileSync(path.join(a, relative), relative);
    await evaluate("document.getElementById('file-refresh').click()");
    await waitFor("Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"scroll-tab-9.txt\"]'))");
    for (const relative of tabPaths) {
      await evaluate(`document.querySelector('#tree .tree-row[data-rel-path="${relative}"]').click()`);
      await waitFor(`document.getElementById('file-name').textContent === '${relative}'`);
    }
    check('切换活动标签自动滚入可见区域', await evaluate(`(() => {
      const host=document.getElementById('editor-tabs'), active=host.querySelector('[aria-selected="true"]');
      const h=host.getBoundingClientRect(), r=active.getBoundingClientRect();
      return host.scrollWidth>host.clientWidth && r.left>=h.left-1 && r.right<=h.right+1;
    })()`));
    const wheel = await evaluate<{ moved: boolean; prevented: boolean; zoomUnchanged: boolean }>(`(() => {
      const host=document.getElementById('editor-tabs'); host.scrollLeft=0;
      const event=new WheelEvent('wheel',{deltaY:90,cancelable:true}); host.dispatchEvent(event);
      const moved=host.scrollLeft>0, beforeZoom=host.scrollLeft;
      const zoom=new WheelEvent('wheel',{deltaY:90,ctrlKey:true,cancelable:true}); host.dispatchEvent(zoom);
      return {moved,prevented:event.defaultPrevented,zoomUnchanged:host.scrollLeft===beforeZoom && !zoom.defaultPrevented};
    })()`);
    check('标签滚轮横滚且不拦截Ctrl缩放', wheel.moved && wheel.prevented && wheel.zoomUnchanged, wheel);
    check('标签滚动条细轨透明且无箭头', await evaluate(`(() => {
      const host=document.getElementById('editor-tabs');
      const bar=getComputedStyle(host,'::-webkit-scrollbar'), track=getComputedStyle(host,'::-webkit-scrollbar-track'), button=getComputedStyle(host,'::-webkit-scrollbar-button');
      return bar.height==='5px' && track.backgroundColor==='rgba(0, 0, 0, 0)' && button.display==='none';
    })()`));
    await evaluate("document.querySelector('#editor-tabs [role=tab][data-path=\"scroll-tab-0.txt\"]').click()");
    await waitFor("document.getElementById('file-name').textContent === 'scroll-tab-0.txt'");
    check('远端标签切回首项仍可见', await evaluate(`(() => {
      const host=document.getElementById('editor-tabs'), active=host.querySelector('[aria-selected="true"]');
      const h=host.getBoundingClientRect(), r=active.getBoundingClientRect();return r.left>=h.left-1 && r.right<=h.right+1;
    })()`));
    const closed = await controller.closeRoot();
    check('关闭目录保留历史并清除恢复记录', closed.ok === true && controller.workspace.getState().root === null && controller.workspace.getState().recentRoots.length === 2);
    check('空白区有打开入口和最近目录', await waitFor("!document.getElementById('workspace-welcome').hidden && document.querySelectorAll('.recent-folders button').length===2"));
  } catch (error) { check('探针执行无异常', false, error instanceof Error ? error.stack : String(error)); }
  finally { dialog.showMessageBox = originalBox; dialog.showOpenDialog = originalOpen; }
  return { checks, pass: checks.every((item) => item.pass), temporaryDirectory: directory };
}
