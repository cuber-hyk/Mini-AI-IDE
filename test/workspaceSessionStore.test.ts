import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceSessionStore } from '../src/main/workspaceSessionStore';
import { sameWorkspaceConversation, workspaceConversation, workspaceConversationUrl } from '../src/shared/workspaceSessions';
import type { WorkspaceConversation } from '../src/shared/workspaceSessions';

const deepseek: WorkspaceConversation = { platform: 'deepseek', accountId: 'default', conversationId: '23f71e4f-1760-4afc-850d-0ab995fa9ab3' };
const chatgpt: WorkspaceConversation = { platform: 'chatgpt', accountId: 'default', conversationId: '68fd9b4a-85f8-8007-a21c-997abff0682c' };

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-workspace-sessions-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'sessions.json');
  const root = path.join(directory, 'project');
  return { directory, file, root, store: new WorkspaceSessionStore(file) };
}

test('仅普通正式会话可绑定，身份只保留平台、账号和 ID', () => {
  for (const identity of [deepseek, chatgpt, { ...deepseek, accountId: 'account-2' }]) {
    const url = workspaceConversationUrl(identity);
    assert.deepEqual(workspaceConversation(identity.platform, identity.accountId, `${url}?private=value#token`), identity);
    assert.equal(workspaceConversationUrl(identity), url);
  }
  for (const url of [
    'https://chatgpt.com/', 'https://chatgpt.com/c/', 'https://chatgpt.com/c/one/more',
    'https://chatgpt.com/g/custom/c/one', 'https://chatgpt.com/project/one',
    'https://chatgpt.com/c/local-chatgpt%3A12345678-1234-1234-1234-123456789abc',
    'https://chatgpt.com/c/local-chatgpt:12345678-1234-1234-1234-123456789abc',
    'https://user:pass@chatgpt.com/c/one', 'http://chatgpt.com/c/one',
    'https://chatgpt.com:444/c/one', 'https://chatgpt.com.evil.test/c/one',
    'https://chatgpt.com/c/one%2ftwo', 'https://chatgpt.com/c/one/',
    'https://chatgpt.com/c/' + 'x'.repeat(129), 'https://chatgpt.com/c/o\nne',
    '', 'not-a-url',
  ]) assert.equal(workspaceConversation('chatgpt', 'default', url), null, url);
  for (const url of ['https://chat.deepseek.com/', 'https://chat.deepseek.com/a/chat/temporary', 'https://chat.deepseek.com/a/chat/s/', 'https://chat.deepseek.com/a/chat/s/one/more']) {
    assert.equal(workspaceConversation('deepseek', 'default', url), null);
  }
  assert.equal(workspaceConversation('chatgpt', 'default', workspaceConversationUrl(deepseek)), null);
  assert.equal(workspaceConversation('deepseek', 'default', workspaceConversationUrl(chatgpt)), null);
});

test('账号规范和导航构造共用校验，不能跨账号或注入任意地址', () => {
  for (const accountId of ['account-0', 'account-01', 'account-9007199254740992', '../default', 'persist:postcheck', '', 'account-1\n']) {
    assert.equal(workspaceConversation('deepseek', accountId, workspaceConversationUrl(deepseek)), null);
    assert.throws(() => workspaceConversationUrl({ ...deepseek, accountId }));
  }
  assert.equal(workspaceConversation('chatgpt', 'account-1', workspaceConversationUrl(chatgpt)), null);
  for (const conversationId of ['', '../one', 'https://evil.test', 'one?query=value', 'one#hash', 'one%2ftwo']) {
    assert.throws(() => workspaceConversationUrl({ ...chatgpt, conversationId }));
  }
  assert.throws(() => workspaceConversationUrl({ ...chatgpt, platform: 'other' as 'chatgpt' }));
  assert.equal(sameWorkspaceConversation(null, null), false);
  assert.equal(sameWorkspaceConversation(deepseek, null), false);
  assert.equal(sameWorkspaceConversation(deepseek, { ...deepseek }), true);
  assert.equal(sameWorkspaceConversation(deepseek, { ...deepseek, accountId: 'account-1' }), false);
  assert.equal(sameWorkspaceConversation(deepseek, { ...deepseek, platform: 'chatgpt' }), false);
});

test('启动不创建绑定，同会话只归属一个项目且重复绑定不改标题或写盘', t => {
  const { root, store, file } = fixture(t);
  assert.deepEqual(store.sessions, []);
  assert.equal(fs.existsSync(file), false);
  const added = store.bind(root, deepseek, '  修复保存问题  ');
  assert.equal(added.title, '修复保存问题');
  const raw = fs.readFileSync(file, 'utf8');
  assert.deepEqual(store.bind(root.toUpperCase(), deepseek, '改写标题'), added);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  assert.throws(() => store.bind(root + '-other', deepseek, '另一个项目'), /已绑定其他项目/);
  const anotherAccount = store.bind(root, { ...deepseek, accountId: 'account-1' }, '另一个账号');
  const anotherPlatform = store.bind(root, { ...chatgpt, conversationId: deepseek.conversationId }, '另一个平台');
  assert.notEqual(anotherAccount.id, added.id);
  assert.notEqual(anotherPlatform.id, added.id);
  assert.deepEqual(new WorkspaceSessionStore(file).sessions, store.sessions);
});

test('绑定副本不暴露内存，解除仅删除选中本地记录且重启保持结果', t => {
  const { root, store, file } = fixture(t);
  const first = store.bind(root, deepseek, '<script>纯文本标题</script>');
  const original = { ...first };
  const second = store.bind(root, chatgpt, '第二个会话');
  first.title = '外部改写';
  const sessions = store.sessions;
  sessions[0]!.root = '外部改写'; sessions.length = 0;
  assert.deepEqual(store.sessions[0], original);
  store.unbind(original.id);
  assert.deepEqual(store.sessions, [second]);
  assert.deepEqual(new WorkspaceSessionStore(file).sessions, [second]);
  assert.throws(() => store.unbind(original.id), /不存在/);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(parsed).sort(), ['sessions', 'version']);
  assert.deepEqual(Object.keys(parsed.sessions[0]).sort(), ['accountId', 'conversationId', 'id', 'platform', 'root', 'title']);
});

test('无效名称、相对路径和身份均不能创建记录', t => {
  const { root, store, file } = fixture(t);
  for (const title of ['', '  ', 'x'.repeat(161), 'a\nb', 'a\tb', 'a\u0000b', 'a\u0085b']) assert.throws(() => store.bind(root, deepseek, title));
  for (const invalidRoot of ['', '.', 'relative/project', root + '\u0000']) assert.throws(() => store.bind(invalidRoot, deepseek, '会话'));
  assert.throws(() => store.bind(root, { ...deepseek, accountId: 'account-01' }, '会话'));
  assert.deepEqual(store.sessions, []);
  assert.equal(fs.existsSync(file), false);
});

test('损坏、未知 schema 或重复记录明确失败，原文件逐字保留', t => {
  const { root, store, file } = fixture(t);
  const good = store.bind(root, deepseek, '有效会话');
  const document = (sessions: unknown[]) => JSON.stringify({ version: 1, sessions });
  for (const raw of [
    '{broken', 'null', '[]', '{}', '{"version":2,"sessions":[]}',
    JSON.stringify({ version: 1, sessions: [], token: 'secret' }),
    document([good, good]), document([good, { ...good, id: '00000000-0000-0000-0000-000000000000', root: root + '-other' }]),
    document([{ ...good, title: ' 无效空格 ' }]), document([{ ...good, title: '换\n行' }]),
    document([{ ...good, root: 'relative' }]), document([{ ...good, id: 'invalid-id' }]),
    document([{ ...good, accountId: 'account-0' }]), document([{ ...good, platform: 'other' }]),
    document([{ ...good, conversationId: 'local-chatgpt%3Atemporary' }]),
    document([{ ...good, body: '不得保留正文' }]), document([null]),
  ]) {
    fs.writeFileSync(file, raw);
    assert.throws(() => new WorkspaceSessionStore(file), /原文件保留/);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
});

test('原子保存失败不污染绑定或解除结果，也不留下临时文件', t => {
  const { directory, root, store, file } = fixture(t);
  const first = store.bind(root, deepseek, '第一个');
  const preserved = path.join(directory, 'preserved.json');
  fs.renameSync(file, preserved);
  fs.mkdirSync(file);
  fs.writeFileSync(path.join(file, 'keep'), '原目录内容');
  assert.throws(() => store.bind(root, chatgpt, '第二个'), /保存失败/);
  assert.throws(() => store.unbind(first.id), /保存失败/);
  assert.deepEqual(store.sessions, [first]);
  assert.equal(fs.readFileSync(path.join(file, 'keep'), 'utf8'), '原目录内容');
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')), []);
  fs.renameSync(file, path.join(directory, 'blocker'));
  fs.renameSync(preserved, file);
  const second = store.bind(root, chatgpt, '第二个');
  assert.deepEqual(new WorkspaceSessionStore(file).sessions, [first, second]);
  store.unbind(first.id);
  assert.deepEqual(new WorkspaceSessionStore(file).sessions, [second]);
});
