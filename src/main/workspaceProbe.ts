/** 隔离临时目录、离线 Electron 本地界面验收；不接触官方网页或用户文件。 */
import { app, clipboard, dialog, BrowserWindow, type WebContents } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEEPSEEK_SEND_ICON } from './tools/replyObservation';
import { parseModelReply } from '../shared/returnPath';
import type { ReturnPreview } from '../shared/contract';
import type { ToolRequest, ToolState } from '../shared/toolProtocol';
import type { ChangeReviewState } from './tools/changeReview';
import type { WorkspaceController } from './workspaceController';

export function configureWorkspaceProbe(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-workspace-probe-'));
  app.setPath('userData', directory);
  return directory;
}

export async function runWorkspaceProbe(view: WebContents, web: WebContents, preview: WebContents, controller: WorkspaceController, directory: string, webbar: WebContents, toolSettings: () => WebContents | null) {
  const checks: Array<{ name: string; pass: boolean; observed?: unknown }> = [];
  const screenshotErrors: Array<{ file: string; error: string }> = [];
  async function capture(contents: WebContents, file: string) {
    try { fs.writeFileSync(path.join(directory, file), (await contents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); }
    catch (error) { screenshotErrors.push({ file, error: String(error) }); }
  }
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
  const globalSkillRoot = path.join(directory, 'global-skills', 'audit');
  const projectSkillRoot = path.join(a, '.mini-ide', 'skills', 'audit');
  fs.mkdirSync(globalSkillRoot, { recursive: true }); fs.mkdirSync(projectSkillRoot, { recursive: true });
  fs.writeFileSync(path.join(globalSkillRoot, 'SKILL.md'), '---\nname: audit\ndescription: 全局审阅\n---\nGLOBAL-SKILL');
  fs.writeFileSync(path.join(projectSkillRoot, 'SKILL.md'), '---\nname: audit\ndescription: 项目审阅\n---\nPROJECT-SKILL');
  for (let i = 0; i < 9; i++) {
    const bundle = path.join(directory, 'global-skills', 'sample-' + i); fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, 'SKILL.md'), '---\nname: sample-' + i + '\ndescription: Create a structured, evidence-based review for a bounded scope. Inspect correctness and explain findings with concrete source evidence.\n---\nSample instruction');
  }

  let choice = 2;
  const originalBox = dialog.showMessageBox;
  const originalOpen = dialog.showOpenDialog;
  let picked = a;
  dialog.showMessageBox = (async () => ({ response: choice, checkboxChecked: false })) as typeof dialog.showMessageBox;
  dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  try {
    check('Monaco 初始化', await waitFor('Boolean(window.__uiProbe && window.__uiProbe().ready)'));
    let initialWebUrl = web.getURL();
    const originalFileWidth = await evaluate<number>("document.querySelector('.toolbar').getBoundingClientRect().width");
    await evaluate("document.getElementById('file-maximize').click()");
    check('文件区全屏按钮扩展空间并隐藏中间协作区', await waitFor("document.getElementById('file-maximize').getAttribute('aria-pressed') === 'true'") && await evaluate<number>("document.querySelector('.toolbar').getBoundingClientRect().width") > originalFileWidth && await evaluate("document.getElementById('collaboration-dock').hidden"));
    await evaluate("document.getElementById('file-maximize').click()");
    check('退出全屏还原文件区宽度且官网不导航', await waitFor("document.getElementById('file-maximize').getAttribute('aria-pressed') === 'false'") && Math.abs(await evaluate<number>("document.querySelector('.toolbar').getBoundingClientRect().width") - originalFileWidth) < 1 && web.getURL() === initialWebUrl);

    await evaluate("document.getElementById('file-collapse').click()");
    check('文件区收起不再保留独立恢复窄条', await waitFor("document.querySelector('.editor-wrap').hidden") && await evaluate("document.getElementById('file-restore') === null"));
    check('恢复按钮融入官网顶栏且可见', await webbar.executeJavaScript("document.getElementById('btn-file-restore').getBoundingClientRect().width > 0"));
    await webbar.executeJavaScript("document.getElementById('btn-file-restore').click()", true);
    check('官网顶栏恢复入口真正展开文件区并收起恢复按钮', await waitFor("!document.querySelector('.editor-wrap').hidden") && await webbar.executeJavaScript("document.getElementById('btn-file-restore').getBoundingClientRect().width === 0"));
    // 顶部按钮必须真正走持久化后的同一入口。
    await evaluate("document.getElementById('workspace-add').click()");
    check('左侧加入项目并显示文件树', await waitFor("Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"a.txt\"]'))"));
    check('左侧加入项目持久化', controller.workspace.getState().root === a && fs.readFileSync(path.join(directory, 'settings.json'), 'utf8').includes(a.replace(/\\/g, '\\\\')));
    check('本地初始化默认勾选且发送按钮可见', await waitFor("document.getElementById('prompt-initialization').checked && !document.getElementById('btn-send-prompt').hidden"));
    await evaluate("document.getElementById('requirement-panel').open = true; document.getElementById('requirement').value='/'; document.getElementById('requirement').setSelectionRange(1,1); document.getElementById('requirement').dispatchEvent(new Event('input',{bubbles:true}))");
    await waitFor("document.querySelectorAll('#skill-menu .skill-option').length === 10");
    await pause(); await pause();
    check('技能菜单紧凑单行，长描述省略且有完整悬停说明', await evaluate(`(() => {
      const menu=document.getElementById('skill-menu'), row=menu.querySelector('.skill-option:nth-child(2)'), desc=row.querySelector('.skill-option-description');
      return row.getBoundingClientRect().height===34 && menu.getBoundingClientRect().height<=225 && getComputedStyle(desc).textOverflow==='ellipsis' && desc.scrollWidth>desc.clientWidth && row.title.includes('concrete source evidence') && row.querySelector('.skill-option-source').textContent==='全局';
    })()`));
    await capture(view, 'skills-menu.png');
    check('正斜杠菜单读取项目覆盖后的真实技能目录', await waitFor("!document.getElementById('skill-menu').hidden && document.querySelector('.skill-option').textContent.includes('项目审阅')"));
    await evaluate("document.getElementById('requirement').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); document.querySelector('.skill-chip').click()");
    check('选择技能只读展示项目说明', await waitFor("document.getElementById('skill-preview').textContent.includes('PROJECT-SKILL') && document.querySelector('.skill-chip').textContent.includes('项目')"));
    check('技能说明在本地dock内受限滚动且输入选项可到达', await evaluate(`(() => {
      const dock=document.getElementById('collaboration-dock'), preview=document.getElementById('skill-preview'), option=document.getElementById('prompt-initialization');
      option.scrollIntoView({block:'nearest'}); const d=dock.getBoundingClientRect(), p=preview.getBoundingClientRect(), o=option.getBoundingClientRect();
      return p.height<=141 && dock.scrollWidth<=dock.clientWidth+1 && o.top>=d.top && o.bottom<=Math.min(d.bottom,innerHeight)+1;
    })()`));
    await capture(view, 'skills-local-prompt.png');
    await evaluate("document.getElementById('prompt-initialization').click()");
    await waitFor("window.editorBridge.getLocalPromptOptions().then(value=>!value.includeInitialization)");

    check('左侧常驻工作区列表显示当前项目，文件树位于编辑正文右侧', await waitFor("document.querySelectorAll('#workspace-list .workspace-project').length === 1 && Boolean(document.querySelector('#workspace-list .workspace-project[aria-current=true]'))") && await evaluate(`(() => {
      const nav = document.getElementById('workspace-navigation').getBoundingClientRect();
      const content = document.querySelector('.editor-wrap').getBoundingClientRect();
      const tree = document.getElementById('sidebar').getBoundingClientRect();
      return nav.left === 0 && nav.right < content.left && Math.abs(content.right - tree.left) <= 1 && tree.right <= innerWidth;
    })()`));

    const composerFixture = path.join(directory, 'local-prompt-composer.html');
    fs.writeFileSync(composerFixture, `<!doctype html><style>textarea{width:400px;height:100px}.ds-button{width:40px;height:40px}</style><section><textarea></textarea><div class="ds-button ds-button--primary ds-button--filled ds-button--circle"><svg><path d="${DEEPSEEK_SEND_ICON}"/></svg></div></section><script>window.sent=[];document.querySelector('.ds-button').addEventListener('click',()=>{const input=document.querySelector('textarea');window.sent.push(input.value);input.value='';});</script>`);
    await web.loadURL(pathToFileURL(composerFixture).href);
    await evaluate("document.getElementById('requirement').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true}))"); await pause();
    check('Shift Enter不发送官网内容', await web.executeJavaScript('window.sent.length===0'));
    await evaluate("document.getElementById('requirement').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    for(let i=0;i<100 && !await web.executeJavaScript('window.sent.length===1');i++) await pause();
    const delivered = await web.executeJavaScript('window.sent[0]') as string;
    check('本地Enter提交用户需求与完整技能，初始化关闭且选择保持', delivered.includes('/audit') && delivered.includes('PROJECT-SKILL') && !delivered.includes('唯一执行协议') && !delivered.includes('GLOBAL-SKILL') && await evaluate<boolean>("!document.getElementById('prompt-initialization').checked"));
    await web.executeJavaScript("document.querySelector('textarea').value='官网用户草稿'");
    await evaluate("document.getElementById('requirement').value='新的需求'; document.getElementById('requirement').dispatchEvent(new Event('input')); document.getElementById('btn-send-prompt').click()"); await pause(); await pause();
    check('本地需求发送不覆盖官网草稿也不重复点击', await web.executeJavaScript("window.sent.length===1 && document.querySelector('textarea').value==='官网用户草稿'"));
    await evaluate("document.getElementById('skill-preview-close').click(); document.getElementById('requirement').value=''; document.getElementById('requirement').dispatchEvent(new Event('input')); document.getElementById('requirement-panel').open=false");
    if (!initialWebUrl) {
      const emptyFixture = path.join(directory, 'idle-web.html');
      fs.writeFileSync(emptyFixture, '<!doctype html><body style="background:#141414"></body>');
      initialWebUrl = pathToFileURL(emptyFixture).href;
    }
    await web.loadURL(initialWebUrl);
    initialWebUrl = web.getURL();
    await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"a.txt\"]').click()");
    check('点击文件真实打开', await waitFor("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === 'a.txt'"));
    const selectionProbe = await evaluate<{ok: boolean; visible: boolean}>("window.__uiSelectionProbe()");
    check('选区右上角浮动复制按钮在真实文件中可见', selectionProbe.ok && selectionProbe.visible, selectionProbe);
    await evaluate("window.__tabModelA = window.monaco.editor.getEditors()[0].getModel(); window.monaco.editor.getEditors()[0].executeEdits('workspace-probe',[{range:window.__tabModelA.getFullModelRange(),text:'tab draft A'}]); window.monaco.editor.getEditors()[0].pushUndoStop(); window.monaco.editor.getEditors()[0].setPosition({lineNumber:1,column:5})");
    await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"tabs.txt\"]').click()");
    check('两个文件各有顶部标签', await waitFor("document.querySelectorAll('#editor-tabs [data-kind=file]').length === 2 && (document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === 'tabs.txt'"));
    await evaluate("window.monaco.editor.getEditors()[0].getModel().setValue('tab draft B'); document.querySelector('#editor-tabs [role=tab][data-path=\"a.txt\"]').click()");
    check('点击标签恢复草稿、同一模型及光标', await waitFor("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === 'a.txt'") && await evaluate("window.monaco.editor.getEditors()[0].getModel() === window.__tabModelA && window.__tabModelA.getValue() === 'tab draft A' && window.monaco.editor.getEditors()[0].getPosition().column === 5"));
    check('各标签独立显示未保存标记', await evaluate("document.querySelectorAll('#editor-tabs .editor-tab.dirty').length === 2"));
    await evaluate("window.monaco.editor.getEditors()[0].trigger('workspace-probe','undo',null)");
    check('切换标签后撤销栈仍有效', await evaluate("window.monaco.editor.getEditors()[0].getModel().getValue() === 'A original'"));
    await evaluate("window.monaco.editor.getEditors()[0].trigger('workspace-probe','redo',null)");
    check('重做恢复当前标签草稿', await evaluate("window.monaco.editor.getEditors()[0].getModel().getValue() === 'tab draft A'"));
    const dockHeightBeforeTools = await evaluate<number>("document.getElementById('collaboration-dock').getBoundingClientRect().height");
    const toolsBeforeClose = await evaluate<string>('window.editorBridge.getToolState().then(state=>JSON.stringify(state))');
    await webbar.executeJavaScript("document.getElementById('btn-tool-workspace').click()", true);
    check('官网顶部查看工具打开右侧标签，保留文件模型和草稿且不挤占官网高度', await waitFor("document.querySelector('#editor-tabs [data-kind=tools][aria-selected=true]') !== null && !document.getElementById('tool-workspace').hidden") && await evaluate<boolean>("window.monaco.editor.getEditors()[0].getModel() === window.__tabModelA && window.__tabModelA.getValue() === 'tab draft A'") && await evaluate<number>("document.getElementById('collaboration-dock').getBoundingClientRect().height") === dockHeightBeforeTools);
    await evaluate("document.querySelector('#editor-tabs [data-kind=tools]').parentElement.querySelector('.editor-tab-close').click()");
    check('工具标签可关闭并恢复当前文件，草稿与工具 owner 状态仍保留', await waitFor("document.querySelector('#editor-tabs [data-kind=tools]') === null && document.getElementById('tool-workspace').hidden") && await evaluate<boolean>("window.monaco.editor.getEditors()[0].getModel() === window.__tabModelA && window.__tabModelA.getValue() === 'tab draft A'") && toolsBeforeClose === await evaluate<string>('window.editorBridge.getToolState().then(state=>JSON.stringify(state))'));
    await webbar.executeJavaScript("document.getElementById('btn-tool-workspace').click()", true);
    await waitFor("document.querySelector('#editor-tabs [data-kind=tools][aria-selected=true]') !== null");
    await evaluate("window.__workspacePositionA = window.monaco.editor.getEditors()[0].getPosition(); document.getElementById('tool-view-changes').click()");
    check('切到本批 Diff 保留同一文件草稿与光标，目录仍在最右', await waitFor("document.querySelector('#editor-tabs [data-kind=review][aria-selected=true]') !== null") && await evaluate("window.monaco.editor.getEditors()[0].getModel() === window.__tabModelA && window.__tabModelA.getValue() === 'tab draft A' && window.monaco.editor.getEditors()[0].getPosition().equals(window.__workspacePositionA) && !document.getElementById('sidebar').hidden"));
    await evaluate("document.querySelector('#editor-tabs [data-kind=tools]').parentElement.querySelector('.editor-tab-close').click()");
    check('关闭非活动工具标签不抢走当前 Diff', await waitFor("document.querySelector('#editor-tabs [data-kind=tools]') === null && document.querySelector('#editor-tabs [data-kind=review][aria-selected=true]') !== null"));
    await evaluate("document.querySelector('#editor-tabs [data-kind=file][data-path=\"a.txt\"]').click()");
    check('返回编辑保持原文件模型和草稿', await waitFor("!document.body.classList.contains('file-diff-visible')") && await evaluate<boolean>("window.monaco.editor.getEditors()[0].getModel() === window.__tabModelA && window.__tabModelA.getValue() === 'tab draft A'"));
    check('切回文件保留改动标签，关闭改动不影响草稿', await evaluate("document.querySelector('#editor-tabs [data-kind=review]') !== null"));
    await evaluate("document.querySelector('#editor-tabs [data-kind=review]').parentElement.querySelector('.editor-tab-close').click()");
    check('改动标签可关闭且保持当前文件', await waitFor("document.querySelector('#editor-tabs [data-kind=review]') === null") && await evaluate<boolean>("window.monaco.editor.getEditors()[0].getModel() === window.__tabModelA && window.__tabModelA.getValue() === 'tab draft A'"));
    await evaluate("document.querySelector('#editor-tabs [role=tab][data-path=\"a.txt\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
    check('方向键可切换标签且恢复另一草稿', await waitFor("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === 'tabs.txt'") && await evaluate("window.monaco.editor.getEditors()[0].getModel().getValue() === 'tab draft B'"));
    choice = 2; await evaluate("document.querySelector('#editor-tabs .editor-tab-close[data-path=\"a.txt\"]').click()"); await pause();
    check('关闭非活动脏标签取消后两个草稿保留', await evaluate("document.querySelectorAll('#editor-tabs [data-kind=file]').length === 2 && window.monaco.editor.getEditors()[0].getModel().getValue() === 'tab draft B'"));
    choice = 0; await evaluate("document.querySelector('#editor-tabs .editor-tab-close[data-path=\"a.txt\"]').click()");
    check('关闭非活动标签保存到对应文件', await waitFor("document.querySelectorAll('#editor-tabs [data-kind=file]').length === 1") && fs.readFileSync(path.join(a, 'a.txt'), 'utf8') === 'tab draft A' && await evaluate("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === 'tabs.txt'"));
    choice = 1; await evaluate("document.querySelector('#editor-tabs .editor-tab-close[data-path=\"tabs.txt\"]').click()");
    check('放弃最后一个标签回到空白页且不写盘', await waitFor("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === '未打开文件'") && fs.readFileSync(path.join(a, 'tabs.txt'), 'utf8') === 'tab original');
    await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"a.txt\"]').click()"); await waitFor("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === 'a.txt'");
    // 只操作本地 Monaco，不向网页派发任何事件。
    await evaluate("window.monaco.editor.getEditors()[0].getModel().setValue('draft A')"); await pause();
    // 用真实不可写目标验证保存失败不会切换目录，随后恢复样例文件。
    fs.renameSync(path.join(a, 'a.txt'), path.join(a, 'preserved.txt')); fs.mkdirSync(path.join(a, 'a.txt'));
    picked = b; choice = 0; await evaluate("document.getElementById('workspace-add').click()");
    const failedSave = await waitFor("document.getElementById('info').textContent.includes('保存失败')");
    check('保存失败保留原目录和草稿', failedSave && controller.workspace.getState().root === a && await evaluate("window.monaco.editor.getEditors()[0].getModel().getValue() === 'draft A'"));
    fs.rmdirSync(path.join(a, 'a.txt')); fs.renameSync(path.join(a, 'preserved.txt'), path.join(a, 'a.txt'));
    picked = b; choice = 2; await evaluate("document.getElementById('workspace-add').click()"); await pause();
    check('取消切换保留目录和草稿', controller.workspace.getState().root === a && await evaluate("window.monaco.editor.getEditors()[0].getModel().getValue() === 'draft A'"));
    choice = 0; await evaluate("document.getElementById('workspace-add').click()");
    check('保存后切换目录且清空旧编辑', await waitFor(`window.editorBridge.getRoot().then(s => s.root === ${JSON.stringify(b)})`) && await evaluate("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === '未打开文件'"));
    check('保存回执确实写入原目录', fs.readFileSync(path.join(a, 'a.txt'), 'utf8') === 'draft A' && fs.readFileSync(path.join(b, 'a.txt'), 'utf8') === 'B original');
    check('目录历史同步到最近列表', controller.workspace.getState().recentRoots[0] === b && controller.workspace.getState().recentRoots[1] === a);
    check('工作区列表保持加入顺序且切项目不导航官网', JSON.stringify(controller.workspace.getState().workspaceRoots) === JSON.stringify([a, b]) && web.getURL() === initialWebUrl && await waitFor("document.querySelectorAll('#workspace-list .workspace-project').length === 2"));
    // 回到 A 并使用树内输入新建文件夹及其内部文件。
    choice = 1; await controller.openRecent(1); await waitFor("Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"sub\"]'))");
    await evaluate("document.getElementById('folder-new').click()");
    check('新建名称输入框可用', await waitFor("Boolean(document.querySelector('.tree-name-input'))"));
    await evaluate("const input=document.querySelector('.tree-name-input'); input.value='notes'; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
    check('新建目录自动展开', await waitFor("Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"notes\"][aria-expanded=\"true\"][aria-selected=\"true\"]'))"));
    await evaluate("document.getElementById('file-new').click()"); await waitFor("Boolean(document.querySelector('.tree-name-input'))");
    await evaluate("const input=document.querySelector('.tree-name-input'); input.value='note.md'; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
    check('选中文件夹下新建文件并打开', await waitFor("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === 'notes/note.md'") && fs.existsSync(path.join(a, 'notes/note.md')));
    await evaluate("window.monaco.editor.getEditors()[0].getModel().setValue('unsaved note')"); await pause();
    await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"notes/note.md\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'F2',bubbles:true}))");
    await waitFor("Boolean(document.querySelector('.tree-name-input'))");
    await evaluate("const input=document.querySelector('.tree-name-input'); input.value='renamed.md'; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
    check('F2 改名更新路径并保留未保存缓冲', await waitFor("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === 'notes/renamed.md'") && await evaluate("window.monaco.editor.getEditors()[0].getModel().getValue() === 'unsaved note'"));
    check('文件树操作按钮有名称且处于可见范围', await evaluate(`['file-new','folder-new','file-refresh'].every(id => {
      const button = document.getElementById(id); const r = button.getBoundingClientRect();
      return Boolean(button.getAttribute('aria-label')) && r.width > 0 && r.left >= 0 && r.right <= innerWidth;
    })`));
    await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"notes/renamed.md\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'F2',bubbles:true}))");
    await waitFor("Boolean(document.querySelector('.tree-name-input'))");
    await evaluate("document.querySelector('.tree-name-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    check('Esc 取消改名不改变文件与草稿', fs.existsSync(path.join(a, 'notes/renamed.md')) && await evaluate("!document.querySelector('.tree-name-input') && window.monaco.editor.getEditors()[0].getModel().getValue() === 'unsaved note'"));
    await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"notes/renamed.md\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))");
    check('键盘可打开文件右键菜单', await waitFor("Array.from(document.querySelectorAll('.file-menu [role=menuitem]')).some(button => button.textContent === '永久删除…')"));
    await evaluate("document.querySelector('.file-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await evaluate("document.getElementById('file-new').click()"); await waitFor("Boolean(document.querySelector('.tree-name-input'))");
    await evaluate("const input=document.querySelector('.tree-name-input'); input.value='renamed.md'; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
    check('树内重名错误可见且不覆盖文件', await waitFor("Boolean(document.querySelector('.tree-name-error').textContent)") && fs.readFileSync(path.join(a, 'notes/renamed.md'), 'utf8') === '');
    await evaluate("document.querySelector('.tree-name-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    const renamedFolder = await evaluate<{ ok: boolean }>(`window.editorBridge.renameEntry('notes','renamed-notes',${JSON.stringify(a)})`);
    check('文件夹改名更新内部文件路径并保留草稿', renamedFolder.ok && await waitFor("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === 'renamed-notes/renamed.md'") && await evaluate("window.monaco.editor.getEditors()[0].getModel().getValue() === 'unsaved note'"));
    await evaluate("document.getElementById('tree').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:40,clientY:250}))");
    check('树空白右键提供新建与路径操作', await waitFor("document.querySelectorAll('.file-menu [role=menuitem]').length >= 6"));
    await evaluate("document.querySelector('.file-menu [role=menuitem]').click()"); await waitFor("Boolean(document.querySelector('.tree-name-input'))");
    await evaluate("const input=document.querySelector('.tree-name-input'); input.value='root-file.txt'; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
    check('空白菜单新建到根目录而非此前选中文件夹', await waitFor("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === 'root-file.txt'") && fs.existsSync(path.join(a, 'root-file.txt')) && !fs.existsSync(path.join(a, 'renamed-notes/root-file.txt')));
    picked = b; choice = 2; await evaluate("document.getElementById('workspace-add').click()"); await pause();
    check('当前标签干净时切换目录仍检查后台草稿', controller.workspace.getState().root === a && await evaluate("document.querySelectorAll('#editor-tabs [data-kind=file]').length === 2"));
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
    check('删除只关闭受影响标签并切回剩余文件', deleted.ok && !fs.existsSync(path.join(a, 'renamed-notes/renamed.md')) && await waitFor("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === 'root-file.txt' && document.querySelectorAll('#editor-tabs [data-kind=file]').length === 1"));
    // 所有工具修改从自有静态回复经过真实采集/权限/执行；右侧仅查看实际快照。
    await evaluate("window.editorBridge.setToolConfig({permission:'full',automatic:false,dirtyPolicy:'stop',autoCopyResults:false,sendIntervalSeconds:3})");
    const settingsEvaluate = <T = unknown>(script: string): Promise<T> => {
      const contents = toolSettings(); if (!contents || contents.isDestroyed()) throw new Error('原生工具设置窗口尚未加载');
      return contents.executeJavaScript(script, true);
    };
    async function waitForSettings(script: string) {
      for (let i = 0; i < 100; i++) {
        const contents = toolSettings();
        if (contents && BrowserWindow.fromWebContents(contents)?.isVisible() && await settingsEvaluate(script)) return true;
        await pause();
      }
      return false;
    }
    await evaluate("document.getElementById('requirement-panel').open=true"); await pause(); await pause();
    const dockBefore = await evaluate<string>('window.editorBridge.setWorkspaceLayout({}).then(state => JSON.stringify([state.layout.dockBounds, state.layout.webBounds]))');
    await evaluate("document.getElementById('tool-settings-toggle').scrollIntoView({block:'nearest'}); document.getElementById('tool-settings-toggle').click()");
    await waitForSettings("document.getElementById('tool-send-interval')?.value === '3' && !document.getElementById('tool-interval-up').disabled");
    const settingsWindow = BrowserWindow.fromWebContents(toolSettings()!)!;
    check('设置是关联主窗口的独立非模态原生窗口', Boolean(settingsWindow?.isVisible() && settingsWindow.getParentWindow() && settingsWindow.webContents !== view));
    const settingsSize = await settingsEvaluate<{ content: number; viewport: number }>("(() => { const panel = document.getElementById('tool-settings-panel'); return { content: panel.scrollHeight, viewport: panel.clientHeight }; })()");
    check('正常高度完整显示工具设置，无需滚动', settingsSize.content <= settingsSize.viewport, settingsSize);
    const shortSettings = await settingsEvaluate<{ content: number; viewport: number; scrollTop: number; hintTop: number; hintBottom: number; panelBottom: number }>("(() => { const panel = document.getElementById('tool-settings-panel'); const height = panel.style.height; try { panel.style.height = '260px'; panel.scrollTop = panel.scrollHeight; const hint = document.getElementById('tool-permission-hint').getBoundingClientRect(); return { content: panel.scrollHeight, viewport: panel.clientHeight, scrollTop: panel.scrollTop, hintTop: hint.top, hintBottom: hint.bottom, panelBottom: panel.getBoundingClientRect().bottom }; } finally { panel.style.height = height; panel.scrollTop = 0; } })()");
    check('内容区域高度不足时可滚动访问底部说明', shortSettings.content > shortSettings.viewport && shortSettings.scrollTop > 0 && shortSettings.hintTop >= 0 && shortSettings.hintBottom <= shortSettings.panelBottom, shortSettings);
    await settingsEvaluate("document.getElementById('tool-clear-rules').click()");
    check('常规操作反馈出现后设置仍无需滚动', await waitForSettings("(() => { const panel = document.getElementById('tool-settings-panel'); return document.getElementById('tool-settings-notice').textContent.includes('已清除本项目') && panel.scrollHeight <= panel.clientHeight; })()"));
    check('打开设置不改变官网和 dock 高度', dockBefore === await evaluate<string>('window.editorBridge.setWorkspaceLayout({}).then(state => JSON.stringify([state.layout.dockBounds, state.layout.webBounds]))'));
    check('专用设置桥没有文件、工具执行和官网发送能力', await settingsEvaluate<boolean>("typeof window.editorBridge === 'undefined' && !('readFile' in window.toolSettingsBridge) && !('setToolConfig' in window.toolSettingsBridge) && !('sendPrompt' in window.toolSettingsBridge)"));
    await settingsEvaluate("document.getElementById('tool-interval-up').click()");
    check('原生浮层增加按钮保存间隔并同步主工具 owner', await waitForSettings("document.getElementById('tool-send-interval').value === '4'") && await evaluate<boolean>('window.editorBridge.getToolState().then(state => state.config.sendIntervalSeconds === 4)'));
    await settingsEvaluate("document.getElementById('tool-interval-down').click()");
    check('原生浮层减少按钮按一秒调整', await waitForSettings("document.getElementById('tool-send-interval').value === '3'"));
    await evaluate('window.editorBridge.setToolConfig({sendIntervalSeconds:0})');
    check('间隔下界禁用减少，不能降到负数', await waitForSettings("document.getElementById('tool-interval-down').disabled"));
    await evaluate('window.editorBridge.setToolConfig({sendIntervalSeconds:300})');
    check('间隔上界禁用增加', await waitForSettings("document.getElementById('tool-interval-up').disabled"));
    await evaluate('window.editorBridge.setToolConfig({sendIntervalSeconds:3})');
    await waitForSettings("document.getElementById('tool-send-interval').value === '3'");
    await capture(toolSettings()!, 'tool-settings-window.png');
    settingsWindow.getParentWindow()!.focus(); await pause();
    check('设置失焦收起，不抢回网页焦点', !settingsWindow.isVisible());
    await evaluate("document.getElementById('tool-settings-toggle').click()");
    await waitForSettings("document.getElementById('tool-send-interval').value === '3'");
    await settingsEvaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))");
    check('设置 Escape 收起并恢复齿轮焦点', await waitFor("document.activeElement?.id === 'tool-settings-toggle'") && !settingsWindow.isVisible());
    check('关闭设置不改变官网和 dock 高度', dockBefore === await evaluate<string>('window.editorBridge.setWorkspaceLayout({}).then(state => JSON.stringify([state.layout.dockBounds, state.layout.webBounds]))'));
    await evaluate("document.getElementById('tool-settings-toggle').click()");
    await waitForSettings("document.getElementById('tool-send-interval').value === '3'");
    await settingsEvaluate("document.getElementById('tool-settings-close').click()");
    check('设置关闭按钮收起并恢复齿轮焦点', await waitFor("document.activeElement?.id === 'tool-settings-toggle'") && !settingsWindow.isVisible());
    await evaluate("document.getElementById('tool-settings-toggle').click()");
    await waitForSettings("document.getElementById('tool-send-interval').value === '3'");
    check('工具设置浮层不再包含提示词编辑入口', await settingsEvaluate("document.getElementById('btn-settings') === null && document.getElementById('tool-settings-prompt') === null && !('openPrompt' in window.toolSettingsBridge)"));
    await settingsEvaluate("document.getElementById('tool-settings-close').click()");
    await evaluate('window.editorBridge.openPromptPanel()');
    await pause();
    const prompt = settingsWindow.getParentWindow()!.contentView.children.find(child => 'webContents' in child && (child.webContents as WebContents).getURL().endsWith('/prompt.html'));
    check('应用提示词入口仍打开现有编辑面板', !settingsWindow.isVisible() && Boolean(prompt?.getVisible()));
    if (prompt && 'webContents' in prompt) await (prompt.webContents as WebContents).executeJavaScript('window.promptBridge.close()', true);
    let batchSeq = 0;
    const fixture = path.join(directory, 'tool-reply.html');
    const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const loadReply = async (text: string) => {
      fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><main class="ds-markdown"><pre><code class="language-mini-ai-tools">' + escapeHtml(text) + '</code></pre></main>');
      await web.loadURL(pathToFileURL(fixture).href);
      choice = 0;
      return evaluate<ReturnPreview>('window.editorBridge.collectReply()');
    };
    const collect = async (requests: ToolRequest[]) => {
      const batchId = 'workspace-' + (++batchSeq);
      const collected = await loadReply(JSON.stringify({ protocol_version: 1, batch_id: batchId, requests }));
      if (!collected.ok || collected.blocks.length) throw new Error('工具采集未走统一入口：' + JSON.stringify(collected));
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await evaluate<ToolState>('window.editorBridge.getToolState()');
        if (!state.busy && state.results.length === requests.length && state.results.every(result => result.batch_id === batchId)) { await pause(); return state; }
        if (state.batchError) throw new Error(state.batchError.error);
        await pause();
      }
      throw new Error('工具批次未结束：' + batchId);
    };
    const reviewState = () => previewEvaluate<ChangeReviewState>('window.previewBridge.getReviewState()');
    const apply = (id: string, changes: unknown[]): ToolRequest => ({ id, tool: 'apply_changes', args: { changes } });
    const undo = () => previewEvaluate<{ ok: boolean; error?: string }>('window.previewBridge.undoToolChange()');
    check('旧人工应用桥已移除，右侧只有查看与工具撤销', await evaluate<boolean>("['applyChange','undoSave','showDiffInEditor','stepDiff','onDiffData'].every(name => !(name in window.editorBridge))") && await previewEvaluate<boolean>("!('applyChange' in window.previewBridge) && typeof window.previewBridge.getReviewState === 'function'"));
    fs.writeFileSync(path.join(a, 'keep.txt'), 'keep original');
    const writeRequests = [apply('write', [{ path: 'a.txt', operation: 'overwrite', content: 'A changed' }, { path: 'keep.txt', operation: 'overwrite', content: 'keep changed' }])];
    const changed = await collect(writeRequests);
    const written = await reviewState();
    check('真实工具采集直接修改两文件，无需人工应用', changed.results[0]?.status === 'done' && fs.readFileSync(path.join(a, 'a.txt'), 'utf8') === 'A changed' && fs.readFileSync(path.join(a, 'keep.txt'), 'utf8') === 'keep changed');
    check('右侧记录实际执行前后快照与增删统计', written.records.length === 2 && written.records.every(record => record.status === 'applied' && typeof record.before === 'string' && typeof record.after === 'string' && record.diff) && written.records[0]?.before === 'draft A' && written.records[0]?.after === 'A changed', written.records);
    check('新工具批次自动打开工具页并保留文件模型', await evaluate("!document.body.classList.contains('file-diff-visible') && document.querySelector('#editor-tabs [data-kind=tools][aria-selected=true]') !== null && Boolean(window.monaco.editor.getEditors()[0].getModel())"));
    await evaluate("document.querySelector('#editor-tabs [data-kind=tools]').parentElement.querySelector('.editor-tab-close').click()");
    await waitFor("document.querySelector('#editor-tabs [data-kind=tools]') === null");
    await loadReply(JSON.stringify({ protocol_version: 1, batch_id: 'workspace-' + batchSeq, requests: writeRequests }));
    await pause();
    check('关闭后重复采集不重开工具，结果与撤销能力保留', await evaluate<boolean>("window.editorBridge.getToolState().then(state => !state.busy && state.canUndo && state.results.length === 1 && document.querySelector('#editor-tabs [data-kind=tools]') === null)") && fs.readFileSync(path.join(a, 'a.txt'), 'utf8') === 'A changed');
    await evaluate("document.getElementById('tool-view-changes').click()");
    await waitFor("document.querySelector('#editor-tabs [data-kind=review][aria-selected=true]') !== null");
    await evaluate("window.editorBridge.setWorkspaceLayout({fileVisible:false})");
    await evaluate("document.getElementById('tool-view-changes').click()");
    check('文件区收起后查看改动可恢复区域与审阅标签', await waitFor("!document.querySelector('.editor-wrap').hidden && document.querySelector('#editor-tabs [data-kind=review][aria-selected=true]') !== null"));
    const beforeView = await evaluate('window.monaco.editor.getEditors()[0].getModel()?.uri.toString()');
    check('右侧默认连续显示本批文件，差异正文占满高度且导航收起', await previewEvaluate("document.querySelectorAll('article[data-record-id]').length === 2 && document.getElementById('pv-navigation').hidden && document.getElementById('pv-detail').getBoundingClientRect().height > innerHeight * .8"));
    await previewEvaluate("document.getElementById('pv-navigate').click(); document.querySelector('.pv-select').click()");
    check('查看差异不抢走编辑焦点文件，无重复应用按钮', await evaluate('window.monaco.editor.getEditors()[0].getModel()?.uri.toString()') === beforeView && await previewEvaluate("Boolean(document.querySelector('.pv-diff')) && !Array.from(document.querySelectorAll('button')).some(button => /应用|创建文件/.test(button.textContent))"));
    check('文件树类型图标实际可见，文件夹开合图标独立于展开箭头', await evaluate("Boolean(document.querySelector('.tree-icon svg')) && Boolean(document.querySelector('.tree-icon-folder, .tree-icon-folder-open'))"));
    await capture(preview, 'review.png');
    const ordinaryWidth = await previewEvaluate<number>('innerWidth');
    const persistedLayout = JSON.stringify(JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8')).workspaceLayout);
    await previewEvaluate("document.getElementById('pv-expand').click()");
    for (let i = 0; i < 100 && await previewEvaluate<number>('innerWidth') <= ordinaryWidth; i++) await pause();
    check('主动展开变更阅读扩大空间，完整布局偏好不被临时宽度覆盖', await previewEvaluate<number>('innerWidth') > ordinaryWidth && JSON.stringify(JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8')).workspaceLayout) === persistedLayout);
    await capture(preview, 'review-expanded.png');
    await previewEvaluate("document.getElementById('pv-expand').click()");
    for (let i = 0; i < 100 && await previewEvaluate<number>('innerWidth') !== ordinaryWidth; i++) await pause();
    check('恢复阅读后回到原内容宽度且目录保持最右', await previewEvaluate<number>('innerWidth') === ordinaryWidth && await evaluate("Math.abs(document.querySelector('.editor-wrap').getBoundingClientRect().right - document.getElementById('sidebar').getBoundingClientRect().left) <= 1"));
    await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"root-file.txt\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))");
    await waitFor("Boolean(document.querySelector('.file-menu'))");
    await capture(view, 'file-menu.png');
    await evaluate("document.querySelector('.file-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    const copiedPath = await evaluate<{ ok: boolean }>(`window.editorBridge.copyEntryPath('root-file.txt',true,${JSON.stringify(a)})`);
    check('路径复制来自真实受限桥', copiedPath.ok && await clipboard.readText() === 'root-file.txt');
    fs.writeFileSync(path.join(a, 'delete-test.txt'), 'only temporary fixture');
    const permanent = await evaluate<{ ok: boolean }>(`window.editorBridge.deleteEntry('delete-test.txt',${JSON.stringify(a)})`);
    check('额外永久删除通过真实确认桥删除临时文件', permanent.ok && !fs.existsSync(path.join(a, 'delete-test.txt')));
    fs.writeFileSync(path.join(a, 'a.txt'), 'external content');
    const frozen = await reviewState();
    check('用户继续编辑磁盘不改写执行时快照', frozen.records[0]?.before === 'draft A' && frozen.records[0]?.after === 'A changed');
    fs.writeFileSync(path.join(a, 'a.txt'), 'A changed');
    check('右侧撤销沿用工具 owner，并逐项恢复原文', (await undo()).ok && (await undo()).ok && fs.readFileSync(path.join(a, 'a.txt'), 'utf8') === 'draft A' && fs.readFileSync(path.join(a, 'keep.txt'), 'utf8') === 'keep original' && (await reviewState()).records.every(record => record.status === 'undone'));

    await evaluate("document.getElementById('file-refresh').click()");
    await waitFor("Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"a.txt\"]'))");
    await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"a.txt\"]').click()");
    await waitFor("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === 'a.txt'");
    await evaluate("window.monaco.editor.getEditors()[0].getModel().setValue('new local draft')"); await pause();
    await evaluate("document.querySelector('#editor-tabs [role=tab][data-path=\"root-file.txt\"]').click()");
    const dirty = await collect([apply('dirty-stop', [{ path: path.join(a, 'a.txt'), operation: 'overwrite', content: 'AI C' }])]);
    check('工具绝对路径同样尊重非活动标签草稿的停止策略', dirty.results[0]?.status === 'failed' && fs.readFileSync(path.join(a, 'a.txt'), 'utf8') === 'draft A');
    await evaluate("document.querySelector('#editor-tabs [role=tab][data-path=\"a.txt\"]').click()");
    check('停止修改保留未保存内容 B', await waitFor("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === 'a.txt'") && await evaluate("window.monaco.editor.getEditors()[0].getModel().getValue() === 'new local draft'"));
    await evaluate("window.editorBridge.setToolConfig({dirtyPolicy:'continue'})");
    const continued = await collect([apply('dirty-continue', [{ path: 'a.txt', operation: 'overwrite', content: 'AI C' }])]);
    check('继续策略用 AI 的 C 替换磁盘 A 与草稿 B，编辑器同步干净内容', continued.results[0]?.status === 'done' && fs.readFileSync(path.join(a, 'a.txt'), 'utf8') === 'AI C' && await waitFor("window.monaco.editor.getEditors()[0].getModel().getValue() === 'AI C' && !document.getElementById('dirty-flag').textContent"));
    const renamed = await evaluate<{ ok: boolean }>(`window.editorBridge.renameEntry('a.txt','moved.txt',${JSON.stringify(a)})`);
    check('改名后旧路径撤销失效，不重建旧文件', renamed.ok && !(await undo()).ok && !fs.existsSync(path.join(a, 'a.txt')) && fs.readFileSync(path.join(a, 'moved.txt'), 'utf8') === 'AI C');
    choice = 0; await controller.openRecent(1);
    const oldSave = await evaluate<{ ok: boolean }>(`window.editorBridge.writeFile('a.txt','bad old save',${JSON.stringify(a)})`);
    const oldSnippet = await evaluate<{ ok: boolean }>(`window.editorBridge.copyNumberedSnippet(${JSON.stringify({ root: a, relPath: 'a.txt', text: 'old snippet', startLine: 1 })})`);
    check('切换项目清理变更与撤销，旧保存和片段不能污染新根', !oldSave.ok && !oldSnippet.ok && !(await undo()).ok && (await reviewState()).records.length === 0 && fs.readFileSync(path.join(b, 'a.txt'), 'utf8') === 'B original');
    await controller.openRecent(1); await waitFor("Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"root-file.txt\"]'))");
    await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"root-file.txt\"]').click()"); await waitFor("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === 'root-file.txt'");

    const createdText = 'const created = 1;\nconst second = 2;';
    const created = await collect([apply('create', [{ path: 'generated/deep/new.ts', operation: 'create', content: createdText }])]);
    const creationReview = await reviewState();
    check('工具新建直接创建多级目录，右侧为空原文到完整新文', created.results[0]?.status === 'done' && fs.readFileSync(path.join(a, 'generated/deep/new.ts'), 'utf8') === createdText && creationReview.records[0]?.before === '' && creationReview.records[0]?.after === createdText);
    await waitFor("document.querySelector('#editor-tabs [data-kind=file][data-path=\"generated/deep/new.ts\"]') !== null");
    await evaluate("document.querySelector('#editor-tabs [data-kind=file][data-path=\"generated/deep/new.ts\"]').click()");
    check('新建后的编辑器为真实可编辑模型，目录树同步刷新', await waitFor("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === 'generated/deep/new.ts' && window.monaco.editor.getEditors()[0].getOption(window.monaco.editor.EditorOption.readOnly) === false && Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"generated\"]'))"));
    check('撤销新增删除本次文件和空目录并关闭对应标签', (await undo()).ok && !fs.existsSync(path.join(a, 'generated')) && await waitFor("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === 'root-file.txt' && !document.querySelector('#tree .tree-row[data-rel-path=\"generated\"]')"));
    const empty = await collect([apply('empty', [{ path: 'empty-created.txt', operation: 'create', content: '' }])]);
    check('工具可创建真正空文件并撤销为不存在', empty.results[0]?.status === 'done' && fs.readFileSync(path.join(a, 'empty-created.txt'), 'utf8') === '' && (await undo()).ok && !fs.existsSync(path.join(a, 'empty-created.txt')));
    fs.writeFileSync(path.join(a, 'race.txt'), 'external content');
    const conflict = await collect([apply('race', [{ path: 'race.txt', operation: 'create', content: 'wrong' }])]);
    check('新建遇到同名外部文件拒绝覆盖，右侧明确失败且没有虚构差异', conflict.results[0]?.status === 'failed' && fs.readFileSync(path.join(a, 'race.txt'), 'utf8') === 'external content' && (await reviewState()).records.every(record => record.status !== 'applied' && record.before === undefined));

    const protocolFile = path.join(a, 'protocol.txt');
    const protocolBefore = 'head\nfirst();\nmid\nsecond();\ntail\n';
    fs.writeFileSync(protocolFile, protocolBefore);
    await evaluate("document.getElementById('file-refresh').click()"); await waitFor("Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"protocol.txt\"]'))");
    await evaluate("document.querySelector('#tree .tree-row[data-rel-path=\"protocol.txt\"]').click()"); await waitFor("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === 'protocol.txt'");
    const copiedText = '\n\tunsaved text  \n\n';
    await evaluate(`window.monaco.editor.getEditors()[0].getModel().setValue(${JSON.stringify(copiedText)})`); await pause();
    const copiedSelection = await evaluate<{ ok: boolean }>(`window.editorBridge.copyNumberedSnippet(${JSON.stringify({ root: a, relPath: 'protocol.txt', text: copiedText, startLine: 1 })})`);
    check('选区复制保留原文且不暴露全文复制接口', copiedSelection.ok && parseModelReply(await clipboard.readText()).blocks[0]?.code === copiedText && await evaluate<boolean>("!('copyWholeFile' in window.editorBridge)") && fs.readFileSync(protocolFile, 'utf8') === protocolBefore);
    await evaluate(`window.monaco.editor.getEditors()[0].getModel().setValue(${JSON.stringify(protocolBefore)})`); await pause();
    const replaced = await collect([apply('replace', [{ path: 'protocol.txt', operation: 'replace', edits: [{ old_string: 'first();', new_string: 'first();\ninserted();' }, { old_string: 'second();', new_string: 'secondDone();' }] }])]);
    check('同一请求多对唯一原文替换保留全文和末尾换行', replaced.results[0]?.status === 'done' && fs.readFileSync(protocolFile, 'utf8') === 'head\nfirst();\ninserted();\nmid\nsecondDone();\ntail\n');
    check('工具撤销准确恢复多对修改前的完整原文', (await undo()).ok && fs.readFileSync(protocolFile, 'utf8') === protocolBefore);
    fs.writeFileSync(path.join(a, 'repeated.txt'), 'same\nsame\n');
    const mismatches = await collect([apply('zero', [{ path: 'protocol.txt', operation: 'replace', edits: [{ old_string: 'missing original', new_string: 'wrong' }] }]), apply('many', [{ path: 'repeated.txt', operation: 'replace', edits: [{ old_string: 'same', new_string: 'wrong' }] }]), apply('valid', [{ path: 'valid/new.ts', operation: 'create', content: 'const valid = 1;' }])]);
    const mixedReview = await reviewState();
    check('零次及多次匹配分别失败，同批独立有效修改仍执行', mismatches.results.map(result => result.status).join(',') === 'failed,failed,done' && mixedReview.records.map(record => record.status).join(',') === 'failed,failed,applied' && fs.readFileSync(protocolFile, 'utf8') === protocolBefore && fs.readFileSync(path.join(a, 'repeated.txt'), 'utf8') === 'same\nsame\n', mixedReview.records);
    fs.renameSync(path.join(a, 'valid/new.ts'), path.join(a, 'valid/original.ts')); fs.writeFileSync(path.join(a, 'valid/new.ts'), 'const valid = 1;');
    check('新增撤销核对文件对象身份，同名同内容外部重建不能删除', !(await undo()).ok && fs.existsSync(path.join(a, 'valid/new.ts')));
    fs.unlinkSync(path.join(a, 'valid/new.ts')); fs.renameSync(path.join(a, 'valid/original.ts'), path.join(a, 'valid/new.ts'));
    check('移回本次创建对象后可重试撤销', (await undo()).ok && !fs.existsSync(path.join(a, 'valid')));
    const read = await collect([{ id: 'read', tool: 'read_file', args: { path: 'protocol.txt' } }]);
    check('新读取批次仍自动打开工具标签', await evaluate("document.querySelector('#editor-tabs [data-kind=tools][aria-selected=true]') !== null"));
    check('查询批次清空上批差异，工具结果仍正常', read.results[0]?.status === 'done' && (await reviewState()).records.length === 0 && await previewEvaluate("document.getElementById('pv-meta').textContent === '0 文件'"));
    const invalid = await loadReply('{"protocol_version":1,"batch_id":"broken","requests":[');
    check('无效 JSON 由工具结果给出明确批次错误，不写盘', invalid.ok && await waitFor("window.editorBridge.getToolState().then(state => Boolean(state.batchError && state.batchError.error.includes('JSON')))") && fs.readFileSync(protocolFile, 'utf8') === protocolBefore);
    // 正式入口拒绝旧文件块，不能借历史上下文触发第二条人工写盘路径。
    fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><main class="ds-markdown"><h3>文件：protocol.txt</h3><h3>操作：覆盖全文</h3><pre><code>legacy content</code></pre></main>');
    await web.loadURL(pathToFileURL(fixture).href); await evaluate('window.editorBridge.collectReply()');
    check('旧文件修改格式明确拒绝且磁盘保留', await waitFor("window.editorBridge.getToolState().then(state => Boolean(state.batchError && state.batchError.error.includes('不再支持')))") && fs.readFileSync(protocolFile, 'utf8') === protocolBefore);
    // 用户实际反馈为长 Markdown：验证真实 Chromium 换行，不用短代码行代替。
    const longReport = '## 实验报告\n\n' + '输入大小、经典配置与实际实验的差异。'.repeat(40) + '\n\n' + 'a_very_long_identifier_'.repeat(35) + '\n';
    fs.writeFileSync(path.join(a, 'report.md'), '旧报告\n');
    await collect([apply('report', [{ path: 'report.md', operation: 'overwrite', content: longReport }])]);
    await evaluate("document.getElementById('tool-view-changes').click()");
    await waitFor("document.querySelector('#editor-tabs [data-kind=review][aria-selected=true]') !== null");
    check('长 Markdown 默认换行且差异不横向溢出', await previewEvaluate("document.getElementById('pv-detail').classList.contains('wrap') && document.getElementById('pv-detail').scrollWidth <= document.getElementById('pv-detail').clientWidth + 1 && document.querySelector('.pv-line-text').getBoundingClientRect().width > 0"));
    await previewEvaluate("document.getElementById('pv-wrap').click()");
    check('关闭自动换行后长代码可横向查看', await previewEvaluate("!document.getElementById('pv-detail').classList.contains('wrap') && Array.from(document.querySelectorAll('.pv-diff')).some(box => box.scrollWidth > box.clientWidth)"));
    await previewEvaluate("document.getElementById('pv-wrap').click(); document.getElementById('pv-expand').click()"); await pause();
    await capture(preview, 'report-expanded.png');
    await previewEvaluate("document.getElementById('pv-expand').click()"); await pause();
    // 多标签仅来自隔离目录，以真实 Chromium 滚动与 CSS 伪元素验证标签条。
    const tabPaths = Array.from({ length: 10 }, (_, i) => 'scroll-tab-' + i + '.txt');
    for (const relative of tabPaths) fs.writeFileSync(path.join(a, relative), relative);
    await evaluate("document.getElementById('file-refresh').click()");
    await waitFor("Boolean(document.querySelector('#tree .tree-row[data-rel-path=\"scroll-tab-9.txt\"]'))");
    for (const relative of tabPaths) {
      await evaluate(`document.querySelector('#tree .tree-row[data-rel-path="${relative}"]').click()`);
      await waitFor(`(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === '${relative}'`);
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
    await waitFor("(document.querySelector('#editor-tabs [data-kind=file][aria-selected=true]')?.getAttribute('data-path') ?? '未打开文件') === 'scroll-tab-0.txt'");
    check('远端标签切回首项仍可见', await evaluate(`(() => {
      const host=document.getElementById('editor-tabs'), active=host.querySelector('[aria-selected="true"]');
      const h=host.getBoundingClientRect(), r=active.getBoundingClientRect();return r.left>=h.left-1 && r.right<=h.right+1;
    })()`));
    const closed = await controller.closeRoot();
    check('关闭目录保留历史并清除恢复记录', closed.ok === true && controller.workspace.getState().root === null && controller.workspace.getState().recentRoots.length === 2);
    check('目录选择仅在左侧工作区，右侧空白不再显示最近目录', await waitFor("document.querySelectorAll('.recent-folders button').length===0 && document.getElementById('workspace-welcome').hidden && document.getElementById('workspace-add')!==null"));
  } catch (error) { check('探针执行无异常', false, error instanceof Error ? error.stack : String(error)); }
  finally { dialog.showMessageBox = originalBox; dialog.showOpenDialog = originalOpen; }
  return { checks, pass: checks.every((item) => item.pass), temporaryDirectory: directory, screenshotErrors };
}
