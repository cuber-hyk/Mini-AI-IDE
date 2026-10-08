import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { SkillService } from '../src/main/skills';
import { validateToolArgs, parseToolBatch } from '../src/shared/toolProtocol';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-skills-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'); const global = path.join(base, 'global');
  await fs.mkdir(root); await fs.mkdir(global);
  const project = path.join(root, '.mini-ide', 'skills');
  const write = async (directory: string, folder: string, content: string) => {
    const bundle = path.join(directory, folder); await fs.mkdir(bundle, { recursive: true });
    await fs.writeFile(path.join(bundle, 'SKILL.md'), content); return bundle;
  };
  return { base, root, global, project, write, service: new SkillService(global) };
}
const skill = (name: string, body: string, description = '测试技能') => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

test('全局可独立发现，项目按声明名称覆盖，load 每次读取真实当前内容', async t => {
  const f = await fixture(t);
  await f.write(f.global, 'different-folder', skill('review', 'global instruction'));
  assert.equal((await f.service.list(null)).skills[0]?.source, 'global');
  const bundle = await f.write(f.project, 'project-folder', skill('review', 'project instruction'));
  assert.deepEqual((await f.service.list(f.root)).skills, [{ name: 'review', description: '测试技能', source: 'project' }]);
  const loaded = await f.service.load(f.root, 'review'); assert.match(loaded.content, /project instruction/);
  assert.equal(loaded.instructionPath, await fs.realpath(path.join(bundle, 'SKILL.md')));
  assert.equal(loaded.resourceRoot, await fs.realpath(bundle));
  await fs.writeFile(path.join(bundle, 'SKILL.md'), skill('review', 'changed instruction'));
  assert.match((await f.service.load(f.root, 'review')).content, /changed instruction/);
  await fs.rm(bundle, { recursive: true });
  assert.equal((await f.service.load(f.root, 'review')).source, 'global');
});

test('项目无效同名说明和 YAML 解析错误不能静默退回全局', async t => {
  const f = await fixture(t); await f.write(f.global, 'review', skill('review', 'global'));
  await f.write(f.project, 'other-folder', '---\nname: review\ndescription: []\n---\ninvalid');
  assert.equal((await f.service.list(f.root)).skills.length, 0);
  await assert.rejects(f.service.load(f.root, 'review'), /不可用/);
  await f.write(f.project, 'other-folder', '---\nname: review\ndescription: [broken\n---\ninvalid');
  await assert.rejects(f.service.load(f.root, 'review'), /不可用/);
  await fs.rm(path.join(f.project, 'other-folder'), { recursive: true });
  await f.write(f.project, 'review', 'no frontmatter');
  await assert.rejects(f.service.load(f.root, 'review'), /不可用/);
});

test('同来源重复技能名禁用，超大文件与任意路径被拒绝', async t => {
  const f = await fixture(t);
  await f.write(f.global, 'a', skill('review', 'a')); await f.write(f.global, 'b', skill('review', 'b'));
  assert.equal((await f.service.list(null)).skills.length, 0);
  await assert.rejects(f.service.load(null, 'review'), /重复/);
  await f.write(f.global, 'large', skill('large', 'x'.repeat(256 * 1024)));
  await assert.rejects(f.service.load(null, 'large'), /256 KiB/);
  for (const name of ['../review', 'a/b', 'a\\b', 'C:\\review', '', 'review\0']) await assert.rejects(f.service.load(null, name), /名称无效/);
});

test('全局技能目录联接可加载共享技能，项目同名仍优先且项目越界联接拒绝', async t => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside'); await f.write(outside, 'review', skill('review', 'outside-secret'));
  await fs.symlink(path.join(outside, 'review'), path.join(f.global, 'review'), 'junction');
  assert.equal((await f.service.list(null)).skills[0]?.name, 'review');
  assert.match((await f.service.load(null, 'review')).content, /outside-secret/);
  await f.write(f.project, 'review', skill('review', 'project instruction'));
  assert.match((await f.service.load(f.root, 'review')).content, /project instruction/);
  await fs.rm(path.join(f.project, 'review'), { recursive: true });
  await fs.symlink(path.join(outside, 'review'), path.join(f.project, 'review'), 'junction');
  await assert.rejects(f.service.load(f.root, 'review'), /超出授权目录/);
  const alias = path.join(f.base, 'alias'); await fs.symlink(outside, alias, 'junction');
  assert.match((await new SkillService(alias).load(null, 'review')).content, /outside-secret/);
});

test('全局目录符号链接可发现，SKILL.md文件链接不能越出技能真实目录', async t => {
  const f = await fixture(t);
  const target = await f.write(path.join(f.base, 'shared'), 'review', skill('review', 'shared instruction'));
  await fs.symlink(target, path.join(f.global, 'review'), 'dir');
  assert.match((await f.service.load(null, 'review')).content, /shared instruction/);
  await fs.unlink(path.join(target, 'SKILL.md'));
  const other = await f.write(path.join(f.base, 'shared'), 'other', skill('review', 'unrelated instruction'));
  await fs.symlink(path.join(other, 'SKILL.md'), path.join(target, 'SKILL.md'), 'file');
  assert.equal((await f.service.list(null)).skills.length, 0);
  await assert.rejects(f.service.load(null, 'review'), /超出授权目录/);
});

test('缺失目录是空目录，存在但不能扫描的项目目录阻止全局回退', async t => {
  const f = await fixture(t); await f.write(f.global, 'review', skill('review', 'global'));
  assert.equal((await f.service.list(f.root)).skills.length, 1);
  await fs.mkdir(path.dirname(f.project), { recursive: true }); await fs.writeFile(f.project, 'not a directory');
  const catalog = await f.service.list(f.root); assert.equal(catalog.skills.length, 0); assert.ok(catalog.errors.length);
  await assert.rejects(f.service.load(f.root, 'review'), /不可用/);
});

test('正式协议 load_skill 仅接受技能名称，拒绝路径和附加参数', () => {
  assert.equal(validateToolArgs('load_skill', { name: 'review' }), null);
  assert.ok(validateToolArgs('load_skill', { name: '../review' }));
  assert.ok(validateToolArgs('load_skill', { name: 'review', path: '/outside' }));
  assert.equal(parseToolBatch('```mini-ai-tools\n' + JSON.stringify({ protocol_version: 1, batch_id: 'skills-1', requests: [{ id: 'skill-1', tool: 'load_skill', args: { name: 'review' } }] }) + '\n```').kind, 'batch');
});
