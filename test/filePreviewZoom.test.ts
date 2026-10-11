import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { it } from 'node:test';
import type { WebContents } from 'electron';
import { registerFilePreviewZoom } from '../src/main/filePreviewZoom';
import { CHANNELS } from '../src/shared/contract';

it('滚轮原生通知仅交给编辑器主 frame，按当前窗口位置和 UI 比例换算鼠标坐标', () => {
  const sent: unknown[][] = []; let factor = 1.5; let dead = false;
  const editor = Object.assign(new EventEmitter(), { mainFrame: { send: (...args: unknown[]) => sent.push(args) },
    getZoomFactor: () => factor, isDestroyed: () => dead });
  let area = { x: -1000, y: 120, width: 600, height: 500 }; let pointer = { x: -700, y: 420 };
  registerFilePreviewZoom(editor as unknown as WebContents, () => area, () => pointer);
  editor.emit('input-event', {}, { type: 'mouseWheel' }); assert.equal(sent.length, 0);
  editor.emit('zoom-changed', {}, 'in');
  assert.deepEqual(sent.pop(), [CHANNELS.filePreviewZoom, { direction: 'in', x: 200, y: 200 }]);
  area = { ...area, x: 200 }; pointer = { x: 350, y: 195 }; factor = 0.75;
  editor.emit('zoom-changed', {}, 'out');
  assert.deepEqual(sent.pop(), [CHANNELS.filePreviewZoom, { direction: 'out', x: 200, y: 100 }]);
  pointer.x = 800; editor.emit('zoom-changed', {}, 'in'); assert.equal(sent.length, 0);
  pointer.x = 350; editor.emit('zoom-changed', {}, 'unknown'); assert.equal(sent.length, 0);
  factor = 0; editor.emit('zoom-changed', {}, 'in'); assert.equal(sent.length, 0);
  factor = 1; dead = true; editor.emit('zoom-changed', {}, 'in'); assert.equal(sent.length, 0);
});
