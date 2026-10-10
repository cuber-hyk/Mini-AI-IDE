/** 三列本地 UI 的运行时验收；仅在 --ui-probe 调用，不访问官方网页 DOM。 */
import type { BaseWindow, WebContentsView } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Layout } from './windowLayout';

export async function runLayoutProbe(input: {
  win: BaseWindow;
  editor: WebContentsView;
  webbar: WebContentsView;
  preview: WebContentsView;
  configure: (previewVisible: boolean, maximized?: boolean) => void;
  getLayout: () => Layout;
  captureDirectory?: string;
}): Promise<{ ok: boolean; cases: unknown[] }> {
  const originalSize = input.win.getSize();
  const originalZoom = input.editor.webContents.getZoomFactor();
  const originalRequirementOpen = await input.editor.webContents.executeJavaScript("document.getElementById('requirement-panel').open");
  const cases: unknown[] = [];
  let ok = true;
  try {
    for (const [width, height, previewVisible, zoom, maximized, toolsVisible] of [[1600, 960, true, 1, false, false], [1080, 600, true, 1, false, false], [1080, 600, false, 1, false, false], [1600, 960, true, 1.25, false, false], [1600, 960, true, 1.5, false, false], [1600, 960, true, 1, true, false], [1080, 600, false, 1, true, false], [1600, 960, false, 1, false, true], [1080, 600, false, 1, false, true], [1600, 960, false, 1.5, true, true]] as const) {
      input.win.setSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 150));
      input.win.moveTop();
      input.win.focus();
      input.editor.webContents.focus();
      input.editor.webContents.setZoomFactor(zoom);
      input.configure(previewVisible, maximized);
      await input.editor.webContents.executeJavaScript(`window.editorBridge.setWorkspaceLayout({ toolsVisible: ${toolsVisible} })`);
      await new Promise(resolve => setTimeout(resolve, 150));
      // 原生尺寸与 renderer resize 通知异步到达，等待 CSS 视口真正采用本轮尺寸和缩放。
      let viewportReady = false;
      let viewport: number[] = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        const native = input.win.getContentSize();
        viewport = await input.editor.webContents.executeJavaScript('[innerWidth, innerHeight]') as number[];
        viewportReady = Math.abs(viewport[0]! * zoom - native[0]!) <= zoom * 2 && Math.abs(viewport[1]! * zoom - native[1]!) <= zoom * 2;
        if (viewportReady) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const [w, h] = input.win.getContentSize();
      const editor = input.editor.getBounds();
      const bar = input.webbar.getBounds();
      const preview = input.preview.getBounds();
      const expected = input.getLayout();
      const same = (a: Electron.Rectangle, b: Electron.Rectangle) => ['x','y','width','height'].every(key => a[key as keyof Electron.Rectangle] === b[key as keyof Electron.Rectangle]);
      const geometry = same(editor, expected.editorBounds) && same(bar, expected.webBarBounds) &&
        same(preview, expected.previewBounds) && editor.width === w && editor.height === h &&
        expected.workspaceBounds.x + expected.workspaceBounds.width === bar.x &&
        expected.contentBounds.x + expected.contentBounds.width === expected.treeBounds.x &&
        expected.treeBounds.x + expected.treeBounds.width === w &&
        input.webbar.getVisible() === !maximized && input.preview.getVisible() === expected.previewVisible;
      const controls = await input.editor.webContents.executeJavaScript(`(() => {
        const ids = ['workspace-add', 'file-new', 'folder-new', 'file-refresh', 'file-maximize', 'file-collapse', 'tree-collapse'];
        const inView = id => { const node = document.getElementById(id); if (!node) return false; const r = node.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; };
        const tree = document.getElementById('sidebar').getBoundingClientRect();
        const body = document.querySelector(${JSON.stringify(toolsVisible ? '#tool-workspace' : '.editor-wrap')}).getBoundingClientRect();
        const toolbar = document.querySelector('.toolbar').getBoundingClientRect();
        const scale = innerWidth / ${expected.editorBounds.width};
        return ids.every(inView) && body.left < tree.left && Math.abs(body.right-tree.left) <= 1 && tree.right <= innerWidth + 1 && Math.abs(tree.top) <= 1 &&
          Math.abs(body.top-toolbar.bottom) <= 1 && Math.abs(body.top-${expected.contentBounds.y}*scale) <= 1 &&
          Math.abs(document.getElementById('tree').getBoundingClientRect().top-${expected.treeBounds.y}*scale) <= 2 &&
          !document.querySelector('.editor-head') && document.getElementById('btn-sidebar').hidden &&
          document.getElementById('tool-workspace').hidden === ${!toolsVisible} &&
          (!${toolsVisible} || (() => { const r=document.getElementById('tool-panel-body').getBoundingClientRect(); return r.height>0 && r.top>=body.top && r.bottom<=body.bottom+1; })());
      })()`);
      const controlDiagnostics = controls ? undefined : await input.editor.webContents.executeJavaScript(`(() => {
        const ids=['workspace-add','file-new','folder-new','file-refresh','file-maximize','tree-collapse','tool-permission','tool-automatic','tool-workspace','tool-panel-body'];
        return {width:innerWidth,height:innerHeight, controls:ids.map(id=>({id,rect:document.getElementById(id).getBoundingClientRect().toJSON()})), tree:document.getElementById('tree').getBoundingClientRect().toJSON(), monaco:document.getElementById('monaco').getBoundingClientRect().toJSON()};
      })()`);
      const previewControls = !previewVisible || await input.preview.webContents.executeJavaScript(`(() => {
        return ['pv-undo','pv-collapse'].every(id => {
          const r = document.getElementById(id).getBoundingClientRect();
          return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        });
      })()`);
      const webbarControls = maximized || await input.webbar.webContents.executeJavaScript(`(() => {
        return ['btn-collect', 'btn-tool-workspace'].every(id => {
          const r = document.getElementById(id).getBoundingClientRect();
          return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        });
      })()`);
      const promptCases: unknown[] = [];
      if (!maximized) {
        for (const open of [true, false]) {
          await input.editor.webContents.executeJavaScript(`document.getElementById('requirement-panel').open = ${open}`);
          await new Promise(resolve => setTimeout(resolve, 150));
          const prompt = await input.editor.webContents.executeJavaScript(`(() => {
            const dock=document.getElementById('collaboration-dock'), panel=document.getElementById('requirement-panel'), footer=document.getElementById('prompt-actions');
            const d=dock.getBoundingClientRect(), p=panel.getBoundingClientRect(), f=footer.getBoundingClientRect();
            const ids=['btn-add-prompt-attachment','prompt-initialization','tool-permission','tool-automatic','tool-settings-toggle','btn-send-prompt'];
            const inside=ids.every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.width>0 && r.left>=d.left && r.right<=d.right+1 && r.bottom<=Math.min(d.bottom,innerHeight)+1;});
            return { open: panel.open, dockHeight:d.height, footerHeight:f.height,
              pass: d.right<=innerWidth+1 && d.bottom<=innerHeight+1 && dock.scrollWidth<=dock.clientWidth+1 &&
                panel.contains(footer) && footer.contains(document.getElementById('local-prompt-options')) && !document.getElementById('variant-switch') &&
                (${open} ? inside && footer.checkVisibility() : !footer.checkVisibility() && p.height<40) };
          })()`);
          promptCases.push(prompt);
        }
      }
      const pass = viewportReady && geometry && controls === true && previewControls === true && webbarControls === true && promptCases.every(value => (value as { pass: boolean }).pass);
      ok = ok && pass;
      let screenshot: string | undefined;
      let screenshotError: string | undefined;
      if (input.captureDirectory) {
        await fs.mkdir(input.captureDirectory, { recursive: true });
        screenshot = path.join(input.captureDirectory, `${width}-${height}-${previewVisible}-${zoom}-${maximized}-${toolsVisible}.png`);
        try { await fs.writeFile(screenshot, (await input.editor.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); }
        catch (error) { screenshot = undefined; screenshotError = String(error); }
      }
      cases.push({ width, height, zoom, actualZoom: input.editor.webContents.getZoomFactor(), maximized, previewVisible, toolsVisible, editor, bar, preview, viewportReady, viewport, geometry, controls, previewControls, webbarControls, promptCases, pass, ...(controlDiagnostics ? { controlDiagnostics } : {}), ...(screenshot ? { screenshot } : {}), ...(screenshotError ? { screenshotError } : {}) });
    }
  } finally {
    input.editor.webContents.setZoomFactor(originalZoom);
    input.win.setSize(originalSize[0]!, originalSize[1]!);
    await input.editor.webContents.executeJavaScript(`document.getElementById('requirement-panel').open = ${originalRequirementOpen}; window.editorBridge.setWorkspaceLayout({ toolsVisible: false })`);
    input.configure(true);
  }
  return { ok, cases };
}
