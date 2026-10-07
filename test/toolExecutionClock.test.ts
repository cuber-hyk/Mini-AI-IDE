import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { it } from 'node:test';

function fixture() {
  let now = 1000; let unload!: () => void; let tick: (() => void) | undefined;
  const window: any = { addEventListener(_event: string, fn: () => void) { unload = fn; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/toolExecutionClock.js'), 'utf8'), {
    window, Date: { now: () => now }, setInterval(fn: () => void) { tick = fn; return 1; }, clearInterval() { tick = undefined; },
  });
  const clock = window.createToolExecutionClock(); const node = { textContent: '' };
  return { clock, node, advance(ms: number) { now += ms; tick?.(); }, unload: () => unload(), get active() { return !!tick; } };
}

it('运行中只更新秒数文本；完成后冻结时长并释放计时器', () => {
  const f = fixture(); f.clock.replace([{ result: { status: 'running', started_at: 1000 }, node: f.node }]);
  assert.equal(f.node.textContent, '0.0s'); assert.equal(f.active, true);
  f.advance(2500); assert.equal(f.node.textContent, '2.5s');
  f.clock.replace([{ result: { status: 'failed', started_at: 1000, finished_at: 3200 }, node: f.node }]);
  f.advance(9000); assert.equal(f.node.textContent, '2.2s'); assert.equal(f.active, false);
});

it('后台命令计时使用真实进程生命周期，不能冻结在启动工具返回时', () => {
  const f = fixture(); f.clock.replace([{ result: { tool: 'run_command', status: 'done', started_at: 1000, finished_at: 1001, data: { status: 'running', started_at: 1000, finished_at: null } }, node: f.node }]);
  f.advance(5000); assert.equal(f.node.textContent, '5.0s'); assert.equal(f.active, true);
  f.clock.replace([{ result: { tool: 'run_command', status: 'done', data: { status: 'stopped', started_at: 1000, finished_at: 5000 } }, node: f.node }]);
  f.advance(5000); assert.equal(f.node.textContent, '4.0s'); assert.equal(f.active, false);
});

it('权限等待和重启状态没有真实启动时间时不虚构时长，切换批次或关闭页面释放计时器', () => {
  const f = fixture(); f.clock.replace([{ result: { status: 'pending_permission' }, node: f.node }]);
  assert.equal(f.node.textContent, ''); assert.equal(f.active, false);
  f.clock.replace([{ result: { status: 'running', started_at: 1000 }, node: f.node }]);
  f.clock.replace([]); assert.equal(f.active, false);
  f.clock.replace([{ result: { status: 'running', started_at: 1000 }, node: f.node }]);
  f.unload(); assert.equal(f.active, false);
});
