import assert from 'node:assert/strict';
import { it } from 'node:test';
import { webPlatformSwitchBlock } from '../src/shared/webPlatform';

it('权限等待中的执行与存活后台命令仍阻止切换，不能依赖摘要是否显示 running', () => {
  assert.equal(webPlatformSwitchBlock({ busy: true }), '工具正在执行，完成后可切换');
  assert.equal(webPlatformSwitchBlock({ busy: false, hasRunningProcesses: true }), '后台命令正在运行，结束后可切换');
});

it('本地需求从准备开始和结果发送均锁住平台，等待与倒计时不锁住', () => {
  assert.equal(webPlatformSwitchBlock({ busy: false }, true), '正在发送，请稍候');
  const results = { canSend: false, attachmentCount: 0, message: '' };
  assert.equal(webPlatformSwitchBlock({ busy: false, resultReturn: { ...results, phase: 'sending' } }), '正在发送，请稍候');
  for (const phase of ['countdown', 'waiting_reply', 'waiting_user'] as const)
    assert.equal(webPlatformSwitchBlock({ busy: false, continuation: { phase, message: '' } }), undefined);
  assert.equal(webPlatformSwitchBlock({ busy: false, continuation: { phase: 'sending', message: '' } }), '正在发送，请稍候');
  assert.equal(webPlatformSwitchBlock({ busy: false, resultReturn: { ...results, phase: 'paused' } }), undefined);
});
