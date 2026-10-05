/** 在隔离 DOM/Monaco 中运行真实预览函数，验证新增行的实际 view zone 位置。 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { it } from 'node:test';

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
const previewCode = source.slice(source.indexOf('function lineMap('), source.indexOf('async function enterDiff('));

it('覆盖全文预览被拒绝后仍保留明确操作按钮，用户可核对并重试', async () => {
  let applyClick: (() => Promise<void>) | undefined;
  const enterCode = source.slice(source.indexOf('async function enterDiff('), source.indexOf('function exitDiff('));
  const applyCode = source.slice(source.indexOf("el.btnDiffApply.addEventListener('click'"), source.indexOf('/* ---------------- 目录树与编辑器之间的拖拽'));
  const button = { disabled: false, textContent: '', addEventListener(_name: string, fn: () => Promise<void>) { applyClick = fn; } };
  const info: string[] = [];
  const sandbox = { state: { diffNav: null, diffTarget: null }, workspaceRevision: 1,
    editorWorkspace: { reload: async () => true }, el: { btnDiffApply: button },
    renderInlineDiff: () => { button.textContent = '覆盖全文'; }, clearInlineDiff: () => {},
    setInfo: (message: string) => info.push(message),
    bridge: { applyChange: async () => ({ ok: false, error: '目标文件有未保存的修改' }) } };
  vm.createContext(sandbox);
  vm.runInContext(enterCode + '\n' + applyCode, sandbox);
  await vm.runInContext('enterDiff({collectionId:"batch", index:0, filePath:"a.ts", operation:"overwrite", workspaceRevision:1})', sandbox);
  assert.equal(button.textContent, '覆盖全文'); assert.ok(applyClick); await applyClick();
  assert.equal(button.textContent, '覆盖全文'); assert.equal(button.disabled, false);
  assert.match(info.at(-1)!, /应用失败.*未保存/);
});

function render(original: string, modified: string, newFile = false) {
  const zones: Array<{ afterLineNumber: number }> = [];
  const editor = {
    getModel: () => ({ getValue: () => original, getLineCount: () => original.split('\n').length }),
    changeViewZones: (callback: (accessor: unknown) => void) => callback({
      addZone: (zone: { afterLineNumber: number }) => { zones.push(zone); return String(zones.length); },
      removeZone: () => {},
    }),
    createDecorationsCollection: (decorations: unknown[]) => {
      if (newFile) assert.equal(decorations.length, 0, '不存在的原文不能出现删除标记');
      return { clear: () => {} };
    },
    updateOptions: () => {},
    revealLineInCenter: () => {},
  };
  const sandbox = {
    state: { editor, diffZoneIds: [], diffDecorations: null },
    el: { diffActions: { hidden: true }, diffLabel: { textContent: '' }, btnDiffApply: { textContent: '' } },
    window: { monaco: { Range: class {} } },
    document: { createElement: () => ({ appendChild: () => {} }) },
    setInfo: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(previewCode + '\nrenderInlineDiff(' + JSON.stringify({ original, modified, newFile }) + ');', sandbox);
  return zones.map((zone) => zone.afterLineNumber);
}

it('替换 10-10 时保留第十行并增加九行：预览须插在第十行后', () => {
  const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
  const modified = [...lines.slice(0, 10), ...Array.from({ length: 9 }, (_, i) => `new ${i}`), ...lines.slice(10)];
  assert.deepEqual(render(lines.join('\n'), modified.join('\n')), [10]);
});

it('新增文件不把空模型虚构成删除一行，全部内容从第零行展示', () => {
  assert.deepEqual(render('', 'first\nsecond', true), [0]);
});

it('同一预览的两个新增区间须分别跟随相应原文位置', () => {
  assert.deepEqual(render('a\nb\nc\nd', 'a\nx\nb\nc\ny\nd'), [1, 3]);
});

it('首行前新增内容须用第零行锚点，不能挂到末尾', () => {
  assert.deepEqual(render('a\nb', 'new\na\nb'), [0]);
});

it('替换与文件末尾追加仍在正确位置预览', () => {
  assert.deepEqual(render('a\nb\nc', 'a\nnew b\nc'), [2]);
  assert.deepEqual(render('a\nb', 'a\nb\nnew'), [2]);
});
