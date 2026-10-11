import type { Point, Rectangle, WebContents } from 'electron';
import { CHANNELS } from '../shared/contract';

/** 原生滚轮缩放只通知编辑器主 frame，不向文档 iframe 注入脚本或桥。 */
export function registerFilePreviewZoom(editor: WebContents, bounds: () => Rectangle, cursor: () => Point): void {
  editor.on('zoom-changed', (_event, direction) => {
    if (editor.isDestroyed() || (direction !== 'in' && direction !== 'out')) return;
    const area = bounds(); const point = cursor(); const factor = editor.getZoomFactor();
    if (!Number.isFinite(factor) || factor <= 0 || point.x < area.x || point.y < area.y ||
      point.x >= area.x + area.width || point.y >= area.y + area.height) return;
    editor.mainFrame.send(CHANNELS.filePreviewZoom, { direction, x: (point.x - area.x) / factor, y: (point.y - area.y) / factor });
  });
}
