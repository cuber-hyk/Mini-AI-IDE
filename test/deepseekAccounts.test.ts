import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeepSeekAccountStore } from '../src/main/deepseekAccounts';
import { DEFAULT_DEEPSEEK_ACCOUNT_ID, deepseekAccountPartition } from '../src/shared/deepseekAccounts';

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-deepseek-accounts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'accounts.json');
  return { directory, file, store: new DeepSeekAccountStore(file) };
}

test('默认账号沿用原分区，重开后复用账号编号而不触碰认证资料', t => {
  const { file, store } = fixture(t);
  assert.equal(DEFAULT_DEEPSEEK_ACCOUNT_ID, 'default');
  assert.deepEqual(store.accounts, [{ id: 'default', name: '默认账号' }]);
  assert.equal(deepseekAccountPartition(store.accounts[0]!.id), 'persist:postcheck');
  assert.deepEqual(store.add(' 工作账号 '), { id: 'account-1', name: '工作账号' });
  const reopened = new DeepSeekAccountStore(file);
  assert.deepEqual(reopened.accounts, store.accounts);
  assert.equal(deepseekAccountPartition(reopened.accounts[1]!.id), 'persist:postcheck-ds-1');
  assert.equal(reopened.add('个人账号').id, 'account-2');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['accounts', 'nextId']);
});

test('备注保持纯文本，返回值修改不影响持久化 owner', t => {
  const { file, store } = fixture(t);
  const added = store.add('<script>备注</script>');
  added.name = '外部改写';
  const accounts = store.accounts;
  accounts[0]!.id = '外部改写';
  accounts.length = 0;
  assert.equal(store.accounts[0]!.id, 'default');
  assert.equal(store.accounts[1]!.name, '<script>备注</script>');
  assert.equal(new DeepSeekAccountStore(file).accounts[1]!.name, '<script>备注</script>');
});

test('空备注、超长、控制字符和重名不能创建账号或占用编号', t => {
  const { store } = fixture(t);
  for (const value of [null, undefined, 1, {}, '', '  ', '名'.repeat(33), 'a\nb', '\t名字', '名字\u007f', '名字\u0085', ' 默认账号 ']) {
    assert.throws(() => store.add(value));
  }
  assert.equal(store.add('有效').id, 'account-1');
  assert.throws(() => store.add(' 有效 '), /已存在/);
  assert.equal(store.add('名'.repeat(32)).id, 'account-2');
});

test('既有损坏文件明确失败并逐字保留，不能重置账号映射', t => {
  const { file } = fixture(t);
  const defaults = { id: 'default', name: '默认账号' };
  for (const raw of [
    '{broken', 'null', '[]', '{}',
    JSON.stringify({ nextId: 1, accounts: [] }),
    JSON.stringify({ nextId: 2, accounts: [defaults, defaults] }),
    JSON.stringify({ nextId: 2, accounts: [defaults, { id: 'account-1', name: '默认账号' }] }),
    JSON.stringify({ nextId: 1, accounts: [defaults, { id: 'account-1', name: '工作' }] }),
    JSON.stringify({ nextId: 2, accounts: [defaults, { id: 'persist:other', name: '工作' }] }),
    JSON.stringify({ nextId: 2, accounts: [defaults, { id: 'account-1', name: ' 工作 ' }] }),
    JSON.stringify({ nextId: Number.MAX_SAFE_INTEGER + 1, accounts: [defaults] }),
  ]) {
    fs.writeFileSync(file, raw);
    assert.throws(() => new DeepSeekAccountStore(file), /原文件保留/);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
});

test('保存失败保留内存和编号，修复磁盘后下次成功使用同一编号', t => {
  const { directory, file, store } = fixture(t);
  const blocker = path.join(directory, 'blocker');
  fs.mkdirSync(file);
  fs.writeFileSync(path.join(file, 'keep'), '原目录内容');
  assert.throws(() => store.add('工作'), /保存失败/);
  assert.deepEqual(store.accounts, [{ id: 'default', name: '默认账号' }]);
  assert.equal(fs.readFileSync(path.join(file, 'keep'), 'utf8'), '原目录内容');
  assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')).length, 0);
  fs.renameSync(file, blocker);
  assert.equal(store.add('工作').id, 'account-1');
  assert.equal(new DeepSeekAccountStore(file).add('个人').id, 'account-2');
});

test('分区入口仅接受固定默认账号或规范安全整数编号', () => {
  assert.equal(deepseekAccountPartition('account-9007199254740991'), 'persist:postcheck-ds-9007199254740991');
  for (const value of ['account-0', 'account-01', 'account--1', 'account-1.1', 'account-1e3', 'account-9007199254740992', '../default', 'persist:postcheck', 'account-1\n', '', null, undefined, 1]) {
    assert.throws(() => deepseekAccountPartition(value as string), /编号无效/);
  }
});

test('磁盘已有更高的下一编号时不复用历史空缺编号', t => {
  const { file } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ nextId: 9, accounts: [{ id: 'default', name: '默认账号' }, { id: 'account-3', name: '旧账号' }] }));
  const reopened = new DeepSeekAccountStore(file);
  assert.equal(reopened.add('新账号').id, 'account-9');
  assert.equal(new DeepSeekAccountStore(file).add('另一个').id, 'account-10');
});
