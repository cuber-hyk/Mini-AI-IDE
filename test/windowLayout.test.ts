import assert from 'node:assert/strict';
import { it } from 'node:test';
import { computeLayout, EDITOR_MIN_WIDTH, WEB_MIN_WIDTH, PREVIEW_MIN_WIDTH, WEB_BAR_HEIGHT } from '../src/main/windowLayout';

it('三列并排占满内容区，网页与变更列表各自使用完整纵向空间', () => {
  const layout = computeLayout(1600, 900, 800, 300);
  assert.deepEqual(layout.editorBounds, { x: 0, y: 0, width: 800, height: 900 });
  assert.deepEqual(layout.webBounds, { x: 800, y: WEB_BAR_HEIGHT, width: 500, height: 900 - WEB_BAR_HEIGHT });
  assert.deepEqual(layout.previewBounds, { x: 1300, y: 0, width: 300, height: 900 });
});

it('拖动任意分隔条或窗口缩小后仍为编辑器、网页、列表保留最小可用宽度', () => {
  for (const desiredEditor of [-500, 400, 800, 4000]) {
    for (const desiredPreview of [1, 300, 1200, 4000]) {
      const layout = computeLayout(1200, 700, desiredEditor, desiredPreview);
      assert.ok(layout.editorBounds.width >= EDITOR_MIN_WIDTH);
      assert.ok(layout.webBounds.width >= WEB_MIN_WIDTH);
      assert.ok(layout.previewBounds.width >= PREVIEW_MIN_WIDTH);
      assert.equal(layout.previewBounds.x + layout.previewBounds.width, 1200);
    }
  }
});

it('网页隐藏后变更列仍可用，恢复把手保留在编辑器与变更列之间', () => {
  const layout = computeLayout(1400, 800, 600, 300, false);
  assert.equal(layout.previewBounds.width, 300);
  assert.equal(layout.previewBounds.x, 1100);
  assert.equal(layout.webBounds.width, 0);
  assert.equal(layout.webBarBounds.width, 28);
  assert.equal(layout.editorBounds.width, 1072);
});

it('变更列表隐藏后空间归还编辑器与网页，两列都隐藏仍有网页恢复入口', () => {
  const two = computeLayout(1400, 800, 600, 0, true);
  assert.equal(two.webBounds.width, 800);
  assert.equal(two.previewBounds.width, 0);
  const one = computeLayout(1400, 800, 600, 0, false);
  assert.equal(one.editorBounds.width, 1372);
  assert.equal(one.webBarBounds.width, 28);
});

it('异常小的内容区不产生越界或负尺寸，极低窗口不让顶栏压出视口', () => {
  for (const width of [0, 20, 200, 700, 1040]) {
    for (const height of [0, 20, 500]) {
      for (const visible of [true, false]) {
        const layout = computeLayout(width, height, 1000, 300, visible);
        for (const bounds of [layout.editorBounds, layout.webBounds, layout.webBarBounds, layout.previewBounds]) {
          assert.ok(bounds.width >= 0 && bounds.height >= 0);
          assert.ok(bounds.x + bounds.width <= width);
          assert.ok(bounds.y + bounds.height <= height);
        }
      }
    }
  }
});
