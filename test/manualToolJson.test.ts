import assert from 'node:assert/strict';
import { it } from 'node:test';
import { EventEmitter } from 'node:events';
import { ManualToolJson } from '../src/main/tools/manualToolJson';
import { MAX_MANUAL_TOOL_JSON_LENGTH } from '../src/shared/manualToolJson';

const json = JSON.stringify({ protocol_version: 1, batch_id: 'manual', requests: [{ id: 'info', tool: 'get_project_info', args: {} }] });
function fixture() {
  const web: any = new EventEmitter(); let context: { project: string | null; scope: string; error?: string } = { project: 'C:/project', scope: 'one' };
  const executed: unknown[] = [];
  const owner = new ManualToolJson(web, () => context, async batch => { executed.push(batch); });
  return { web, owner, executed, context: (next: typeof context) => { context = next; } };
}

it('原始 JSON 与正式单围栏预览无执行，确认仅执行保存在主进程的原始请求一次', async () => {
  for (const text of [json, '```mini-ai-tools\n' + json + '\n```', '~~~~mini-ai-tools\n' + json + '\n~~~~']) {
    const f = fixture(); const preview = f.owner.preview(text); assert.equal(preview.ok, true); if (!preview.ok) throw new Error(preview.error);
    assert.equal(f.executed.length, 0); assert.equal(preview.project, 'C:/project'); assert.equal(preview.batch_id, 'manual');
    preview.requests[0]!.tool = 'run_command';
    assert.equal((await f.owner.run(preview.token)).ok, true); assert.equal((f.executed[0] as any).requests[0].tool, 'get_project_info');
    assert.equal((await f.owner.run(preview.token)).ok, false); assert.equal(f.executed.length, 1); f.owner.dispose();
  }
});

it('错误、普通话、回执、补丁、多批次与混杂说明均不能获得执行令牌', () => {
  const f = fixture();
  for (const text of ['请帮我执行', '{"protocol_version":', '{"tool_results":[]}', '{"repair_draft":{"draft_id":"one","version":1,"old_string":"a","new_string":"b"}}',
    json + '\n' + json, '说明\n```mini-ai-tools\n' + json + '\n```', '```mini-ai-tools\n' + json + '\n```\n说明',
    '```mini-ai-tools\n' + json + '\n```\n```mini-ai-tools\n' + json + '\n```', '```json\n' + json + '\n```', '```mini-ai-tools\n' + json,
    JSON.stringify({ protocol_version: 1, batch_id: 'x', requests: [{ id: 'run', tool: 'run_command', args: { command: 'echo x', shell: 'unsupported' } }] }), '\0', ' '.repeat(MAX_MANUAL_TOOL_JSON_LENGTH + 1)]) {
    assert.equal(f.owner.preview(text).ok, false, text.slice(0, 70));
  }
  assert.equal(f.executed.length, 0); f.owner.dispose();
});

it('重新预览、上下文变化与主 frame 导航都使此前令牌失效，导航回来也不能恢复', async () => {
  const f = fixture(); const token = () => { const p = f.owner.preview(json); assert.equal(p.ok, true); return p.ok ? p.token : ''; };
  const first = token(); f.owner.preview('broken'); assert.equal((await f.owner.run(first)).ok, false);
  const second = token(); f.context({ project: 'C:/other', scope: 'two' }); assert.equal((await f.owner.run(second)).ok, false);
  f.context({ project: 'C:/project', scope: 'one' }); const third = token();
  f.web.emit('did-navigate-in-page', {}, 'https://chatgpt.com/c/other', true); f.web.emit('did-navigate-in-page', {}, 'https://chatgpt.com/c/one', true);
  assert.equal((await f.owner.run(third)).ok, false);
  const fourth = token(); f.web.emit('did-start-navigation', { isMainFrame: true }); assert.equal((await f.owner.run(fourth)).ok, false);
  assert.equal(f.executed.length, 0); f.owner.dispose();
});

it('无项目或忙状态拒绝预览及执行，执行令牌失败也只消费一次', async () => {
  const f = fixture(); f.context({ project: null, scope: 'one' }); assert.equal(f.owner.preview(json).ok, false);
  f.context({ project: 'C:/project', scope: 'one' }); const p = f.owner.preview(json); assert.equal(p.ok, true); if (!p.ok) return;
  f.context({ project: 'C:/project', scope: 'one', error: 'busy' }); assert.deepEqual(await f.owner.run(p.token), { ok: false, error: 'busy' });
  assert.equal(f.owner.preview(json).ok, false); f.context({ project: 'C:/project', scope: 'one' }); assert.equal((await f.owner.run(p.token)).ok, false);
  assert.equal(f.executed.length, 0); f.owner.dispose();
});

it('正文中的代码围栏只是参数资料，原始 JSON 添加围栏不会截断命令或文件内容', async () => {
  const f = fixture(); const content = '\n````mini-ai-tools\n只是资料\n````\n';
  const p = f.owner.preview(JSON.stringify({ protocol_version: 1, batch_id: 'content', requests: [{ id: 'write', tool: 'apply_changes', args: { changes: [{ path: 'notes.md', operation: 'create', content }] } }] }));
  assert.equal(p.ok, true); if (!p.ok) throw new Error(p.error); await f.owner.run(p.token);
  assert.equal((f.executed[0] as any).requests[0].args.changes[0].content, content); f.owner.dispose();
});

it('预览超过五分钟必须重新确认，旧令牌不能执行', async t => {
  const f = fixture(); const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const p = f.owner.preview(json); assert.equal(p.ok, true); if (!p.ok) return;
  t.mock.method(Date, 'now', () => now + 300_001); assert.equal((await f.owner.run(p.token)).ok, false); assert.equal(f.executed.length, 0); f.owner.dispose();
});
