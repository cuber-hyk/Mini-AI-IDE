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
  const cases: unknown[] = [];
  let ok = true;
  try {
    for (const [width, height, previewVisible, zoom, maximized] of [[1600, 960, true, 1, false], [1080, 600, true, 1, false], [1080, 600, false, 1, false], [1600, 960, true, 1.25, false], [1600, 960, true, 1.5, false], [1600, 960, true, 1, true], [1080, 600, false, 1, true]] as const) {
      input.editor.webContents.setZoomFactor(zoom);
      input.win.setSize(width, height);
      input.configure(previewVisible, maximized);
      await new Promise(resolve => setTimeout(resolve, 150));
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
        input.webbar.getVisible() === !maximized && input.preview.getVisible() === previewVisible;
      const controls = await input.editor.webContents.executeJavaScript(`(() => {
        const ids = ['workspace-add', 'file-new', 'folder-new', 'file-refresh', 'file-maximize', 'tree-collapse', ...(document.getElementById('collaboration-dock').hidden ? [] : ['tool-permission', 'tool-automatic'])];
        const inView = id => { const node = document.getElementById(id); if (!node) return false; const r = node.getBoundingClientRect();
          return r.width > 0 && r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; };
        const tree = document.getElementById('sidebar').getBoundingClientRect();
        const body = document.querySelector('.editor-wrap').getBoundingClientRect();
        return ids.every(inView) && body.left < tree.left && tree.right <= innerWidth + 1 && Math.abs(tree.top) <= 1 && Math.abs(document.getElementById('tree').getBoundingClientRect().top - document.getElementById('monaco').getBoundingClientRect().top) <= 2;
      })()`);
      const previewControls = !previewVisible || await input.preview.webContents.executeJavaScript(`(() => {
        return ['pv-undo','pv-collapse'].every(id => {
          const r = document.getElementById(id).getBoundingClientRect();
          return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        });
      })()`);
      const webbarControls = maximized || await input.webbar.webContents.executeJavaScript(`(() => {
        return ['btn-collect'].every(id => {
          const r = document.getElementById(id).getBoundingClientRect();
          return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        });
      })()`);
      const pass = geometry && controls === true && previewControls === true && webbarControls === true;
      ok = ok && pass;
      let screenshot: string | undefined;
      let screenshotError: string | undefined;
      if (input.captureDirectory) {
        await fs.mkdir(input.captureDirectory, { recursive: true });
        screenshot = path.join(input.captureDirectory, `${width}-${height}-${previewVisible}-${zoom}-${maximized}.png`);
        try { await fs.writeFile(screenshot, (await input.editor.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); }
        catch (error) { screenshot = undefined; screenshotError = String(error); }
      }
      cases.push({ width, height, zoom, maximized, previewVisible, editor, bar, preview, geometry, controls, previewControls, webbarControls, pass, ...(screenshot ? { screenshot } : {}), ...(screenshotError ? { screenshotError } : {}) });
    }
  } finally {
    input.editor.webContents.setZoomFactor(originalZoom);
    input.win.setSize(originalSize[0]!, originalSize[1]!);
    input.configure(true);
  }
  return { ok, cases };
}
