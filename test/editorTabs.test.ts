import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { it } from 'node:test';

class Element {
  children: Element[] = []; dataset: Record<string, string> = {}; attrs: Record<string, string> = {};
  events: Record<string, (event: any) => void> = {}; hidden = false; tabIndex = 0; className = ''; title = ''; type = '';
  private text = '';
  classList = { toggle() {} };
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent() { return this.text; }
  addEventListener(type: string, fn: (event: any) => void) { this.events[type] = fn; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  appendChild(child: Element) { this.children.push(child); }
  contains() { return false; }
  querySelectorAll() { return this.children.flatMap(child => child.children).filter(child => child.attrs.role === 'tab'); }
  focus() {} scrollIntoView() {}
}

it('改动按需与文件共用标签栏，切回文件保留改动标签，关闭改动不关闭草稿文件', async () => {
  const host = new Element(); const calls: string[] = [];
  const context: any = { window: {}, document: { activeElement: null, createElement() { return new Element(); } } };
  vm.runInNewContext(fs.readFileSync('src/renderer/editorTabs.js', 'utf8'), context);
  const owner = context.window.createEditorTabs(host, {
    async open(path: string) { calls.push('file:' + path); }, close(path: string) { calls.push('close:' + path); },
    async openReview() { calls.push('review'); }, closeReview() { calls.push('close-review'); },
  });
  const files = [{ path: 'draft.ts', dirty: true }, { path: 'other.ts', dirty: false }];
  owner.render(files, 'draft.ts');
  assert.equal(host.querySelectorAll().length, 2, '未打开改动时不占标签');
  owner.setReview(true, true);
  let tabs = host.querySelectorAll();
  assert.equal(tabs.length, 3);
  assert.equal(tabs[2].dataset.kind, 'review');
  assert.equal(tabs[2].attrs['aria-selected'], 'true');
  assert.equal(tabs[0].attrs['aria-selected'], 'false');
  assert.match(tabs[0].attrs['aria-label'], /未保存/);
  tabs[0].events.click({});
  assert.deepEqual(calls, ['file:draft.ts']);
  owner.setReview(true, false);
  tabs = host.querySelectorAll();
  assert.equal(tabs.length, 3);
  assert.equal(tabs[0].attrs['aria-selected'], 'true');
  tabs[0].events.keydown({ key: 'End', preventDefault() {} });
  await Promise.resolve();
  assert.equal(calls.at(-1), 'review', '文件与改动标签共享键盘导航');
  host.children[2].children[1].events.click({});
  assert.equal(calls.at(-1), 'close-review');
  owner.setReview(false, false);
  assert.equal(host.querySelectorAll().length, 2);
  assert.equal(files[0].dirty, true, '关闭改动不会改变文件草稿');
  owner.render([], null); owner.setReview(true, false);
  assert.equal(host.querySelectorAll()[0].attrs['aria-selected'], 'false', '无文件时退出预览也不能误选改动标签');
});
