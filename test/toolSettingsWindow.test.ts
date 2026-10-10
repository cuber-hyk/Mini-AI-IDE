import assert from 'node:assert/strict';
import { it } from 'node:test';
import { toolSettingsBounds } from '../src/main/toolSettingsWindow';

it('原生设置靠近齿轮向上展开，保持在主窗口与显示器可见范围', () => {
  const bounds = toolSettingsBounds({ x: 1100, y: 750, width: 30, height: 30 }, { x: 100, y: 100, width: 1200, height: 800 }, { x: 0, y: 0, width: 1920, height: 1040 });
  assert.deepEqual(bounds, { x: 760, y: 142, width: 370, height: 600 });
});
it('较矮主窗口与负坐标副屏钳制浮层尺寸，不能把主界面撑大', () => {
  const parent = { x: -1800, y: 100, width: 1100, height: 420 }, area = { x: -1920, y: 0, width: 1920, height: 1040 };
  const bounds = toolSettingsBounds({ x: -800, y: 500, width: 30, height: 30 }, parent, area);
  assert.equal(bounds.height, 396); assert.equal(bounds.width, 370);
  assert.ok(bounds.x >= parent.x + 12 && bounds.x + bounds.width <= parent.x + parent.width - 12);
  assert.ok(bounds.y >= parent.y + 12 && bounds.y + bounds.height <= parent.y + parent.height - 12);
});
