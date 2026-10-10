import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SettingsStore } from '../src/main/settings';
import { getFormatSpec, resolveFormatSpec } from '../src/shared/formatSpec';

function fixture(t: { after(fn: () => void): void }, legacy: object) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-settings-migration-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'test.json'); const raw = JSON.stringify(legacy, null, 2) + '\n';
  fs.writeFileSync(file, raw);
  return { home, file, raw, backup: file + '.prompt-upgrade-backup.json', load: () => new SettingsStore('test.json', home) };
}
for (const variant of ['short', 'full']) {
  test(`迁移 ${variant} 当前自定义逐字保留，另一份原文件备份且重启不重复`, t => {
    const short = '\n 简洁自定义 \n'; const full = '\n 完整自定义 \n';
    const f = fixture(t, { formatSpecVariant: variant, customFormatSpecShort: short, customFormatSpecFull: full });
    const settings = f.load();
    assert.equal(settings.get().customFormatSpec, variant === 'full' ? full : short);
    assert.equal(fs.readFileSync(f.backup, 'utf8'), f.raw);
    const disk = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    assert.equal(disk.formatSpecMigrationVersion, 1);
    for (const key of ['formatSpecVariant', 'customFormatSpecShort', 'customFormatSpecFull']) assert.equal(key in disk, false);
    const mtime = fs.statSync(f.backup).mtimeMs;
    settings.update({ customFormatSpec: '\n新的唯一设置\n' });
    assert.equal(f.load().get().customFormatSpec, '\n新的唯一设置\n');
    assert.equal(fs.statSync(f.backup).mtimeMs, mtime);
    assert.equal(fs.readFileSync(f.backup, 'utf8'), f.raw);
  });
}
test('当前版没有自定义采用完整默认，未选中内容仅留备份不合并', t => {
  const f = fixture(t, { formatSpecVariant: 'short', customFormatSpecShort: ' ', customFormatSpecFull: '另一份重要内容' });
  assert.equal(resolveFormatSpec(f.load().get().customFormatSpec), getFormatSpec());
  assert.equal(fs.readFileSync(f.backup, 'utf8'), f.raw);
});
test('最早单字段自定义保留；已有迁移标记不会再次生成备份', t => {
  const f = fixture(t, { customFormatSpec: '\n早期原文\n' });
  assert.equal(f.load().get().customFormatSpec, '\n早期原文\n');
  fs.unlinkSync(f.backup);
  assert.equal(f.load().get().customFormatSpec, '\n早期原文\n');
  assert.equal(fs.existsSync(f.backup), false);
});
test('升级不截断历史自定义，备份保留未识别设置字段', t => {
  const custom = 'x'.repeat(12000);
  const f = fixture(t, { formatSpecVariant: 'full', customFormatSpecFull: custom, unrelated: { value: 17 } });
  assert.equal(f.load().get().customFormatSpec, custom);
  assert.equal(JSON.parse(fs.readFileSync(f.backup, 'utf8')).unrelated.value, 17);
});
test('备份失败阻止迁移并明确报错，原配置不变', t => {
  const f = fixture(t, { formatSpecVariant: 'full', customFormatSpecFull: '用户内容' });
  fs.mkdirSync(f.backup);
  assert.throws(f.load, /提示词设置升级失败/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.raw);
});
test('迁移落盘失败保留原设置与备份，同一原文件可重试且重启幂等', t => {
  const f = fixture(t, { formatSpecVariant: 'full', customFormatSpecFull: '用户内容' });
  const original = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error('无法替换配置'); };
    assert.throws(f.load, /提示词设置升级失败.*设置保存失败/);
  } finally { fs.renameSync = original; }
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.raw);
  assert.equal(fs.readFileSync(f.backup, 'utf8'), f.raw);
  assert.equal(f.load().get().customFormatSpec, '用户内容');
  assert.equal(f.load().get().customFormatSpec, '用户内容');
});
test('不同旧备份不能静默覆盖，迁移明确停止', t => {
  const f = fixture(t, { formatSpecVariant: 'short', customFormatSpecShort: '重要内容' });
  fs.writeFileSync(f.backup, '另一次升级备份');
  assert.throws(f.load, /提示词设置升级失败.*备份已存在且内容不同/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.raw);
  assert.equal(fs.readFileSync(f.backup, 'utf8'), '另一次升级备份');
});

test('设置读取失败或无法解析时不使用默认覆盖原用户内容', t => {
  const f = fixture(t, { formatSpecVariant: 'full', customFormatSpecFull: '用户原文' });
  const original = fs.readFileSync;
  try {
    fs.readFileSync = (() => { throw new Error('配置无法读取'); }) as typeof fs.readFileSync;
    assert.throws(f.load, /设置读取失败.*配置无法读取/);
  } finally { fs.readFileSync = original; }
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.raw);
  fs.writeFileSync(f.file, '{不完整JSON');
  assert.throws(f.load, /设置读取失败/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{不完整JSON');
  assert.equal(fs.existsSync(f.backup), false);
});
