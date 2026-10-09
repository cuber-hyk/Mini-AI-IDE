import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { it } from 'node:test';
import type { ToolName, ToolResult } from '../src/shared/toolProtocol';

const window = {} as { describeToolResult: (result: unknown) => { label: string; target: string; detail: string } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/toolResultPresentation.js'), 'utf8'), { window });
const describe = (tool: ToolName, data?: unknown, extra: Partial<ToolResult> = {}) => window.describeToolResult({ batch_id: 'b', request_id: 'r', tool, status: 'done', data, ...extra });

it('附件工具展示真实名称和字节数，暂存结果不能声称已上传', () => {
  const summary = describe('attach_file', { id: 'private-id', name: '论文图1.png', size: 1024, mediaType: 'image/png' });
  assert.equal(summary.label, '暂存附件'); assert.equal(summary.target, '论文图1.png');
  assert.equal(summary.detail, '已暂存，待发送 · 1024 字节'); assert.doesNotMatch(summary.detail, /已上传/);
  const failed = describe('attach_file', { name: '论文.pdf', size: 100 }, { status: 'failed', error: '文件已变化' });
  assert.equal(failed.detail, '文件已变化');
  assert.equal(describe('attach_file', { size: -1 }).detail, '已暂存，待发送');
  assert.equal(describe('attach_file', { name: 'a.pdf', size: 200 }, { status: 'permission_denied' }).detail, '');
});

it('加载技能展示真实技能名而非技能正文或资源目录', () => {
  const summary = describe('load_skill', { name: 'review', content: '私有说明', resourceRoot: 'C:\\private' });
  assert.equal(summary.label, '加载技能'); assert.equal(summary.target, 'review'); assert.equal(summary.detail, '');
  const failed = describe('load_skill', undefined, { status: 'failed', error: '技能未找到' });
  assert.equal(failed.label, '加载技能'); assert.equal(failed.target, ''); assert.match(failed.detail, /技能未找到/);
});

it('全部查询工具以真实路径和返回数量展示，不把截断与跳过隐藏成完整结果', () => {
  const cases: Array<[ToolName, unknown, string, string, string]> = [
    ['get_project_info', { root: 'C:\\project', entries: [{ path: 'src' }], truncated: true, skipped: [{ path: '.git' }] }, '项目概况', 'C:\\project', '1 项 · 结果已截断 · 跳过 1 项'],
    ['list_directory', { path: 'C:\\project\\src', entries: [] }, '查看目录', 'C:\\project\\src', '0 项'],
    ['search_files', { path: 'C:\\project', files: ['a.ts', 'b.ts'], truncated: true }, '查找文件', 'C:\\project', '2 个匹配文件 · 结果已截断'],
    ['search_text', { path: 'C:\\project', query: 'hello', matches: [{ line: 1 }] }, '搜索文本', 'C:\\project', '1 处匹配'],
    ['read_file', { path: '中文 空格.txt', start_line: 3, end_line: 6, total_lines: 20, truncated: true }, '读取文件', '中文 空格.txt', '第 3–6 行 · 共 20 行 · 结果已截断'],
  ];
  for (const [tool, data, label, target, detail] of cases) {
    const summary = describe(tool, data);
    assert.equal(summary.label, label); assert.equal(summary.target, target); assert.equal(summary.detail, detail);
  }
});

it('空文件范围与超出文件尾部的读取不能显示不存在的行范围', () => {
  assert.equal(describe('read_file', { start_line: 40, end_line: 39, total_lines: 3 }).detail, '未返回行 · 共 3 行');
  assert.equal(describe('read_file', { content: '' }).detail, '');
});

it('修改只计算真实已应用的结果，局部失败明确保留已写入事实', () => {
  const ok = describe('apply_changes', { status: 'done', outcomes: [{ path: 'a.ts', ok: true, created: true }] });
  assert.equal(ok.label, '修改文件'); assert.equal(ok.target, 'a.ts'); assert.equal(ok.detail, '已修改 1 项');
  const partial = describe('apply_changes', { status: 'failed', outcomes: [{ path: 'a.ts', ok: true }, { path: 'b.ts', ok: false }], error: '磁盘写入失败' }, { status: 'failed' });
  assert.equal(partial.target, '2 个目标'); assert.equal(partial.detail, '磁盘写入失败 · 已修改 1 项 · 1 项失败');
});

it('后台启动和进程输出查询的工具完成不能被描述为进程已经结束', () => {
  const started = describe('run_command', { process_id: 'proc-1', status: 'running', exit_code: null, timed_out: false });
  assert.equal(started.label, '运行命令'); assert.equal(started.target, 'proc-1'); assert.equal(started.detail, '进程仍在运行');
  const output = describe('get_process_output', { process_id: 'proc-1', status: 'running', has_more: true, truncated: true });
  assert.equal(output.label, '读取进程输出'); assert.equal(output.detail, '进程仍在运行 · 还有输出可读取 · 结果已截断');
});

it('命令的非零退出、超时和停止均保留真实状态', () => {
  const failed = describe('run_command', { process_id: 'proc-1', status: 'failed', exit_code: 1 }, { status: 'failed' });
  assert.equal(failed.detail, '进程执行失败 · 退出码 1');
  const timeout = describe('run_command', { status: 'running', timed_out: true, error: '停止失败，进程可能仍在运行' }, { status: 'failed' });
  assert.equal(timeout.detail, '停止失败，进程可能仍在运行 · 进程仍在运行 · 已超时');
  const stopped = describe('stop_process', { process_id: 'proc-1', status: 'stopped', exit_code: null, signal: 'SIGKILL' });
  assert.equal(stopped.label, '停止进程'); assert.equal(stopped.detail, '进程已停止 · 信号 SIGKILL');
  assert.equal(describe('stop_process', { status: 'done', exit_code: 0 }).detail, '进程已结束 · 退出码 0');
});

it('权限、依赖、取消和未知状态不显示残留 data 的成功数量', () => {
  for (const [status, detail] of [['permission_denied', '权限拒绝'], ['pending_permission', '等待授权'], ['running', '执行中'], ['cancelled', '已取消'], ['skipped_dependency', '依赖未成功，已跳过'], ['unknown', '执行结果未知']] as const) {
    const summary = describe('apply_changes', { outcomes: [{ path: 'a.ts', ok: true }] }, { status, error: '真实原因' });
    assert.equal(summary.detail, '真实原因', '状态由专门的状态栏显示，摘要不能再重复一遍');
    assert.doesNotMatch(summary.detail, /已修改/);
  }
});

it('缺少命令或路径时不从请求 ID、输出正文或错误猜测目标', () => {
  const summary = describe('run_command', { stdout: 'pnpm build', stderr: 'C:\\project\\a.ts' });
  assert.equal(summary.target, ''); assert.equal(summary.detail, '');
  assert.equal(describe('read_file', undefined, { status: 'permission_denied', error: '不能读取 package.json' }).target, '');
});

it('不可信资料只返回纯文本，不修改原始结果并把长报错缩成单行', () => {
  const data = { path: '<img onerror=alert(1)>', content: 'raw', error: 'first\nsecond ' + 'x'.repeat(150) };
  const before = JSON.stringify(data);
  const summary = describe('read_file', data, { status: 'failed' });
  assert.equal(summary.target, data.path);
  assert.match(summary.detail, /^first second /);
  assert.match(summary.detail, /…$/); assert.doesNotMatch(summary.detail, /\n/);
  assert.equal(JSON.stringify(data), before);
  assert.equal(window.describeToolResult({ tool: 'toString' }).label, '工具调用');
  assert.equal(window.describeToolResult(null).detail, '');
});
