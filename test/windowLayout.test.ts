import assert from 'node:assert/strict';
import { it } from 'node:test';
import { computeLayout, EDITOR_MIN_WIDTH, WEB_MIN_WIDTH, WEB_BAR_HEIGHT, FILE_HEADER_HEIGHT, TREE_HEADER_HEIGHT } from '../src/main/windowLayout';

it('工作区在左、AI 在中，编辑正文与 Diff 在目录树左侧', () => {
  const layout = computeLayout(1600, 900, { previewVisible: true });
  assert.deepEqual(layout.editorBounds, { x: 0, y: 0, width: 1600, height: 900 });
  assert.equal(layout.workspaceBounds.x, 0);
  assert.equal(layout.webBounds.x, layout.workspaceBounds.width);
  assert.equal(layout.fileBounds.x, layout.webBounds.x + layout.webBounds.width);
  assert.equal(layout.contentBounds.x + layout.contentBounds.width, layout.treeBounds.x);
  assert.equal(layout.treeBounds.x + layout.treeBounds.width, 1600);
  assert.deepEqual(layout.previewBounds, layout.contentBounds);
  assert.equal(layout.treePaneBounds.y, 0);
  assert.equal(layout.contentBounds.y, FILE_HEADER_HEIGHT);
  assert.equal(layout.treeBounds.y, TREE_HEADER_HEIGHT);
  assert.equal(layout.treePaneBounds.x, layout.treeBounds.x);
  assert.equal(layout.webBounds.y, WEB_BAR_HEIGHT);
  assert.equal(layout.webBounds.y + layout.webBounds.height, layout.dockBounds.y);
  assert.equal(layout.dockBounds.y + layout.dockBounds.height, 900);
});

it('辅助栏极端拖宽时仍保护 AI 和文件正文的阅读空间', () => {
  for (const workspaceWidth of [-500, 240, 4000]) {
    for (const fileWidth of [-500, 700, 4000]) {
      const layout = computeLayout(1200, 700, { workspaceWidth, fileWidth, treeWidth: 4000 });
      assert.ok(layout.webBounds.width >= WEB_MIN_WIDTH);
      assert.ok(layout.fileBounds.width >= EDITOR_MIN_WIDTH);
      assert.ok(layout.contentBounds.width >= 240);
    }
  }
});

it('官网区域始终保留可用高度，工具区展开也不挤走官网', () => {
  for (const dockHeight of [0, 300, 10000]) {
    const layout = computeLayout(1400, 800, { dockHeight });
    assert.ok(layout.webBounds.width >= WEB_MIN_WIDTH);
    assert.ok(layout.webBounds.height >= 120);
    assert.equal(layout.webBounds.y + layout.webBounds.height, layout.dockBounds.y);
    assert.equal(layout.dockBounds.y + layout.dockBounds.height, 800);
  }
});

it('隐藏侧栏保留恢复入口，隐藏目录或 Diff 将空间还给文件正文', () => {
  const all = computeLayout(1600, 900);
  const hidden = computeLayout(1600, 900, { workspaceVisible: false, fileVisible: false, previewVisible: true });
  assert.equal(hidden.workspaceBounds.width, 0);
  assert.equal(hidden.fileBounds.width, 0);
  assert.equal(hidden.treeVisible, false);
  assert.equal(hidden.previewVisible, false);
  assert.equal(hidden.toolsVisible, false);
  assert.equal(hidden.contentBounds.width, 0);
  assert.ok(hidden.webBounds.width > all.webBounds.width);
  const noTree = computeLayout(1600, 900, { treeVisible: false });
  assert.equal(noTree.treeBounds.width, 0);
  assert.ok(noTree.contentBounds.width > all.contentBounds.width);
  assert.equal(noTree.previewBounds.width, 0);
});

it('文件正文直接接标签栏，目录路径和操作只占目录区高度', () => {
  const layout = computeLayout(1600, 900);
  assert.equal(layout.contentBounds.y, 36);
  assert.equal(layout.contentBounds.height, 864);
  assert.equal(layout.treeBounds.y, 108);
  assert.equal(layout.treeBounds.height, 792);
});

it('工具标签复用文件正文空间并阻止原生 Diff 覆盖，官网高度不受影响', () => {
  const normal = computeLayout(1600, 900, { dockHeight: 180 });
  const tools = computeLayout(1600, 900, { dockHeight: 180, toolsVisible: true, previewVisible: true });
  assert.equal(tools.toolsVisible, true);
  assert.equal(tools.previewVisible, false);
  assert.equal(tools.previewBounds.width, 0);
  assert.equal(tools.previewBounds.height, 0);
  assert.deepEqual(tools.contentBounds, normal.contentBounds);
  assert.deepEqual(tools.webBounds, normal.webBounds);
  assert.equal(computeLayout(1600, 900, { toolsVisible: true, fileVisible: false }).toolsVisible, false);
});

it('小窗口与异常尺寸下所有区域都保持在视口内', () => {
  for (const width of [0, 1, 20, 200, 700, 1040]) {
    for (const height of [0, 1, 20, 500]) {
      for (const visible of [true, false]) {
        const layout = computeLayout(width, height, {
          workspaceWidth: 4000, fileWidth: -100, treeWidth: 4000, dockHeight: 4000,
          workspaceVisible: visible, fileVisible: visible, previewVisible: true,
        });
        for (const bounds of [layout.editorBounds, layout.workspaceBounds, layout.webBounds, layout.webBarBounds,
          layout.dockBounds, layout.fileBounds, layout.contentBounds, layout.treeBounds, layout.previewBounds]) {
          assert.ok(bounds.x >= 0 && bounds.y >= 0);
          assert.ok(bounds.width >= 0 && bounds.height >= 0);
          assert.ok(bounds.x + bounds.width <= width);
          assert.ok(bounds.y + bounds.height <= height);
        }
      }
    }
  }
  const invalid = computeLayout(Number.NaN, Number.POSITIVE_INFINITY, { fileWidth: Number.NaN });
  assert.equal(invalid.editorBounds.width, 0);
  assert.equal(invalid.editorBounds.height, 0);
});


it('文件区全屏临时隐藏官网和工具区，退出恢复原几何', () => {
  const options = { workspaceWidth: 220, fileWidth: 680, dockHeight: 180, treeVisible: false };
  const normal = computeLayout(1600, 900, options);
  const full = computeLayout(1600, 900, { ...options, fileMaximized: true });
  assert.equal(full.fileBounds.x, full.workspaceBounds.width);
  assert.equal(full.fileBounds.width + full.workspaceBounds.width, 1600);
  assert.equal(full.webBounds.width, 0); assert.equal(full.webBarBounds.width, 0); assert.equal(full.dockBounds.width, 0);
  assert.equal(full.webBounds.height, 0); assert.equal(full.dockBounds.height, 0);
  assert.deepEqual(computeLayout(1600, 900, { ...options, fileMaximized: false }), normal);
});
