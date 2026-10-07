/** 三列本地 UI 的运行时验收；仅在 --ui-probe 调用，不访问官方网页 DOM。 */
import type { BaseWindow, WebContentsView } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function runLayoutProbe(input: {
  win: BaseWindow;
  editor: WebContentsView;
  webbar: WebContentsView;
  preview: WebContentsView;
  configure: (webVisible: boolean, previewVisible: boolean) => void;
  captureDirectory?: string;
}): Promise<{ ok: boolean; cases: unknown[] }> {
  const originalSize = input.win.getSize();
  const cases: unknown[] = [];
  let ok = true;
  try {
    for (const [width, webVisible, previewVisible] of [[1600, true, true], [1080, true, true], [1080, true, false], [1080, false, true], [1080, false, false]] as const) {
      input.win.setSize(width, 800);
      input.configure(webVisible, previewVisible);
      await new Promise(resolve => setTimeout(resolve, 150));
      const [w, h] = input.win.getContentSize();
      const editor = input.editor.getBounds();
      const bar = input.webbar.getBounds();
      const preview = input.preview.getBounds();
      const geometry = editor.x === 0 && editor.height === h && editor.x + editor.width === bar.x &&
        bar.x + bar.width === preview.x && preview.x + preview.width === w &&
        input.webbar.getVisible() && input.preview.getVisible() === previewVisible;
      const controls = await input.editor.webContents.executeJavaScript(`(() => {
        const ids = ['btn-open', 'btn-copy-context', 'btn-copy-prompt', 'file-new', 'folder-new', 'file-refresh', 'tool-permission', 'tool-automatic'];
        const inView = id => { const r = document.getElementById(id).getBoundingClientRect();
          return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; };
        return ids.every(inView);
      })()`);
      const previewControls = !previewVisible || await input.preview.webContents.executeJavaScript(`(() => {
        return ['pv-apply-all','pv-undo','pv-collapse'].every(id => {
          const r = document.getElementById(id).getBoundingClientRect();
          return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        });
      })()`);
      const webbarControls = !webVisible || await input.webbar.webContents.executeJavaScript(`(() => {
        return ['btn-collect','btn-web','btn-preview-toggle'].every(id => {
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
        screenshot = path.join(input.captureDirectory, `${width}-${webVisible}-${previewVisible}.png`);
        try { await fs.writeFile(screenshot, (await input.editor.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); }
        catch (error) { screenshot = undefined; screenshotError = String(error); }
      }
      cases.push({ width, webVisible, previewVisible, editor, bar, preview, geometry, controls, previewControls, webbarControls, pass, ...(screenshot ? { screenshot } : {}), ...(screenshotError ? { screenshotError } : {}) });
    }
  } finally {
    input.win.setSize(originalSize[0]!, originalSize[1]!);
    input.configure(true, true);
  }
  return { ok, cases };
}
