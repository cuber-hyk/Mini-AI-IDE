/** 本地编辑器、官方网页、变更列表的几何；不持有 Electron 或文件能力。 */
export const EDITOR_MIN_WIDTH = 360;
export const WEB_MIN_WIDTH = 420;
export const PREVIEW_MIN_WIDTH = 260;
export const PREVIEW_DEFAULT_WIDTH = 300;
export const WEB_BAR_HEIGHT = 40;
export const HANDLE_BAR_WIDTH = 28;

interface Bounds { x: number; y: number; width: number; height: number }
export interface Layout {
  editorBounds: Bounds;
  webBounds: Bounds;
  webBarBounds: Bounds;
  previewBounds: Bounds;
  dividerX: number;
  webVisible: boolean;
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

export function computeLayout(
  width: number, height: number, editorWidth: number,
  previewWidth = PREVIEW_DEFAULT_WIDTH, webVisible = true,
): Layout {
  const w = Math.max(0, Math.round(width));
  const h = Math.max(0, Math.round(height));
  const previewVisible = previewWidth > 0;
  // 系统最小窗宽保障常规尺寸；测试或外部缩到更小时仍保持所有 bounds 在视口内。
  const minimum = EDITOR_MIN_WIDTH + (webVisible ? WEB_MIN_WIDTH : HANDLE_BAR_WIDTH) +
    (previewVisible ? PREVIEW_MIN_WIDTH : 0);
  const scale = Math.min(1, w / minimum);
  const minEditor = Math.floor(EDITOR_MIN_WIDTH * scale);
  const minWeb = webVisible ? Math.floor(WEB_MIN_WIDTH * scale) : Math.min(HANDLE_BAR_WIDTH, w);
  const minPreview = Math.floor(PREVIEW_MIN_WIDTH * scale);
  const pw = previewVisible ? clamp(Math.round(previewWidth), minPreview, Math.max(0, w - minEditor - minWeb)) : 0;
  const ew = webVisible ? clamp(Math.round(editorWidth), minEditor, Math.max(minEditor, w - minWeb - pw)) : Math.max(0, w - pw - minWeb);
  const ww = Math.max(0, w - ew - pw);
  const barH = Math.min(WEB_BAR_HEIGHT, h);
  return {
    editorBounds: { x: 0, y: 0, width: ew, height: h },
    webBarBounds: { x: ew, y: 0, width: ww, height: webVisible ? barH : h },
    webBounds: { x: ew, y: barH, width: webVisible ? ww : 0, height: webVisible ? h - barH : 0 },
    previewBounds: { x: ew + ww, y: 0, width: pw, height: pw > 0 ? h : 0 },
    dividerX: ew,
    webVisible,
  };
}
