import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { it } from 'node:test';
import { COMPLETION_SCRIPT } from '../src/main/tools/replyObservation';

// 固定输入来自用户现场；不是从实现里的 SVG 常量生成另一套相同规则。
const fixture = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/deepseek-reply-controls.json'), 'utf8'));
const thinkingFixture = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/deepseek-thinking-reply-structure.json'), 'utf8'));
function page(thinking = false) {
  const button = (data: any) => {
    const attributes: any = { 'aria-label': data.aria, 'aria-disabled': data.ariaDisabled };
    const control: any = {
      className: data.className, textContent: '', visible: true, inCode: false, disabled: false,
      getAttribute: (key: string) => attributes[key] ?? null,
      getClientRects: () => control.visible ? [{}] : [],
      closest: () => control.inCode ? {} : null,
      querySelectorAll: () => [{ getAttribute: () => control.icon }],
      icon: data.path,
    };
    return { control, attributes };
  };
  const copy = button(fixture.copy); const regenerate = button(fixture.regenerate);
  const read = button(fixture.read); const send = button(fixture.send);
  const code = button(fixture.copy); code.control.inCode = true; code.control.textContent = '复制';
  const controls = [copy.control, regenerate.control, read.control, send.control, code.control];
  const roots: any[] = [];
  const footer = [copy.control, regenerate.control, read.control, code.control];
  const frame: any = { contains: (node: any) => node === reply || footer.includes(node), querySelectorAll: () => footer };
  const message: any = { parentElement: frame, contains: (node: any) => roots.includes(node), querySelectorAll: () => [code.control] };
  const reply: any = {
    className: 'ds-markdown ds-assistant-message-main-content', parentElement: message,
    closest: (selector: string) => selector === '.ds-message' ? message : null,
    contains: (node: any) => node === reply || node === code.control,
    querySelectorAll: () => [code.control],
  };
  roots.push(reply);
  if (thinking) {
    const thought: any = { ...reply, className: thinkingFixture.rootClasses[0], contains: (node: any) => node === thought };
    reply.className = thinkingFixture.rootClasses[1];
    roots.unshift(thought);
    const contains = frame.contains;
    frame.contains = (node: any) => node === thought || contains(node);
  }
  const document: any = { querySelectorAll: (selector: string) => selector === '.ds-assistant-message-main-content'
    ? roots.filter(node => node.className.split(/\s+/).includes('ds-assistant-message-main-content'))
    : selector.includes('markdown') ? roots : selector.includes('button') ? controls : [] };
  return { copy, regenerate, read, send, code, roots, footer, controls, reply,
    state: () => vm.runInNewContext(COMPLETION_SCRIPT, { document }),
  };
}

it('现场无标签复制/重新生成图标、朗读与发送箭头组合能确认最新回复结束', () => {
  const p = page(); assert.equal(p.state(), 'complete');
});
it('深度思考区与正式答案同框时属于同一条回复，完整结束控件应允许采集与回传', () => {
  const p = page(true);
  assert.equal(p.roots.length, thinkingFixture.candidateCount);
  assert.equal(p.state(), 'complete');
});
it('深度思考模式下生成和中断仍优先于已有完成页脚', () => {
  const p = page(true); p.send.attributes['aria-label'] = '停止生成';
  assert.equal(p.state(), 'generating');
  p.send.attributes['aria-label'] = null;
  const next = { ...p.read.control, className: 'ds-button', textContent: '继续生成', getAttribute: () => null };
  p.controls.push(next); p.footer.push(next);
  assert.equal(p.state(), 'interrupted');
});
it('深度思考区不能放宽跨回复隔离，同框两条正式答案仍不能确认结束', () => {
  const p = page(true); const other = { ...p.reply };
  p.roots.unshift(other); p.footer.push(other);
  assert.equal(p.state(), 'unknown');
});
it('回复代码框的复制和扩展复制按钮不能证明结束', () => {
  const p = page(); p.footer.splice(0, 3);
  p.footer.push({ ...p.copy.control, className: 'c2f-code-card-copy-button', textContent: '复制到Word' });
  assert.notEqual(p.state(), 'complete');
});
it('重新生成禁用、缺失或隐藏时不自动采集', () => {
  for (const thinking of [false, true]) for (const mode of ['disabled', 'hidden', 'missing']) {
    const p = page(thinking);
    if (mode === 'disabled') p.regenerate.attributes['aria-disabled'] = 'true';
    if (mode === 'hidden') p.regenerate.control.visible = false;
    if (mode === 'missing') p.footer.splice(1, 1);
    assert.equal(p.state(), 'unknown', mode);
  }
});
it('输入区图标未知时不把复制控件或旧生成状态当结束', () => {
  for (const thinking of [false, true]) {
    const p = page(thinking); p.send.control.icon = 'unrecognized stop or input mode';
    assert.equal(p.state(), 'unknown');
  }
});
it('历史回复控件不能用于最新回复，明确生成状态优先于已有完成控件', () => {
  const p = page();
  const newer: any = { ...p.reply, contains: () => false, querySelectorAll: () => [] };
  newer.closest = (selector: string) => selector === '.ds-message'
    ? { parentElement: { contains: (node: any) => node === newer, querySelectorAll: () => [] } } : null;
  p.roots.push(newer);
  assert.equal(p.state(), 'unknown');
  const active = page(); active.send.attributes['aria-label'] = '停止生成';
  assert.equal(active.state(), 'generating');
});

it('输入区外原生继续生成按钮表示中断，已有页脚不能把半条回复判为完成', () => {
  const p = page();
  const next = { ...p.read.control, className: 'ds-button', textContent: '继续生成', getAttribute: () => null };
  next.getClientRects = () => next.visible ? [{}] : [];
  p.controls.push(next);
  assert.equal(p.state(), 'interrupted');
  next.visible = false; assert.equal(p.state(), 'complete');
  next.visible = true; next.disabled = true; assert.equal(p.state(), 'complete');
  next.disabled = false; next.closest = () => ({}); assert.equal(p.state(), 'complete', '回复/代码里的同名按钮不能作为原生状态');
});

it('历史回复父级页脚外置的继续生成控件不能把当前回复判为中断', () => {
  const p = page();
  const old = { ...p.read.control, textContent: '继续生成', getAttribute: () => null };
  const history: any = { ...p.reply };
  history.closest = (selector: string) => selector === '.ds-message'
    ? { parentElement: { contains: (node: unknown) => node === old || node === history } } : null;
  p.roots.unshift(history);
  p.controls.push(old); assert.equal(p.state(), 'complete');
});

it('最新回复正文外的页脚继续生成按钮表示中断，历史页脚与正文同名控件不影响当前状态', () => {
  const p = page();
  const next = { ...p.read.control, className: 'ds-button', textContent: '继续生成', getAttribute: () => null };
  p.controls.push(next); p.footer.push(next);
  assert.equal(p.state(), 'interrupted', '真实按钮在最新回复父级内，而不是独立输入区控件');
  next.closest = () => ({});
  assert.equal(p.state(), 'complete', '正文中的同名按钮不能作为原生状态');
});

it('最新页脚的继续控件须可见可用且标签精确，正文和跨回复容器不能赋予中断状态', () => {
  for (const mode of ['hidden', 'disabled', 'ariaDisabled', 'classDisabled', 'text', 'body', 'sharedFrame']) {
    const p = page();
    const next = { ...p.read.control, className: 'ds-button', textContent: '继续生成', getAttribute: (key: string) => key === 'aria-disabled' && mode === 'ariaDisabled' ? 'true' : null,
      classList: { contains: (name: string) => mode === 'classDisabled' && name === 'ds-button--disabled' } };
    next.getClientRects = () => mode === 'hidden' ? [] : [{}];
    next.disabled = mode === 'disabled';
    if (mode === 'text') next.textContent = '继续生成示例';
    if (mode === 'body') p.reply.contains = (node: unknown) => node === next;
    if (mode === 'sharedFrame') {
      p.roots.unshift({ ...p.reply });
      p.footer.push(p.roots[0]);
    }
    p.controls.push(next); p.footer.push(next);
    assert.notEqual(p.state(), 'interrupted', mode);
  }
});
