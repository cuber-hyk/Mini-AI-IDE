/** ChatGPT 官网原生视图：仅手动操作，无采集、发送或本地桥。 */
import { app, session, WebContentsView } from 'electron';
import { WEB_PLATFORMS } from '../shared/webPlatform';
import { checkUaConsistency, stripSelfDeclarations } from '../shared/userAgent';
import { deepseekAccountPartition } from '../shared/deepseekAccounts';

/** 附加 DeepSeek 账号采用稳定分区，官网没有 preload、本地桥或通用弹窗权限。 */
export function createDeepSeekAccountView(partition: string): WebContentsView {
  if (!/^persist:postcheck-ds-[1-9]\d*$/.test(partition) ||
    deepseekAccountPartition('account-' + partition.slice('persist:postcheck-ds-'.length)) !== partition)
    throw new Error('DeepSeek 账号分区无效');
  const targetSession = session.fromPartition(partition);
  const ua = stripSelfDeclarations(targetSession.getUserAgent(), app.getName()).effective;
  if (!checkUaConsistency(ua, process.versions.chrome ?? '').ok) throw new Error('网页 UA 与实际内核不一致');
  targetSession.setUserAgent(ua);
  const webPreferences = {
    partition, userAgent: ua, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    backgroundThrottling: false,
  };
  const view = new WebContentsView({ webPreferences });
  view.webContents.setUserAgent(ua);
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return view;
}

export function createChatGPTView(): WebContentsView {
  const partition = WEB_PLATFORMS.chatgpt.partition;
  const targetSession = session.fromPartition(partition);
  const ua = stripSelfDeclarations(targetSession.getUserAgent(), app.getName()).effective;
  if (!checkUaConsistency(ua, process.versions.chrome ?? '').ok) throw new Error('网页 UA 与实际内核不一致');
  targetSession.setUserAgent(ua);
  const webPreferences = {
    partition, userAgent: ua, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    backgroundThrottling: false,
  };
  const view = new WebContentsView({ webPreferences });
  view.webContents.setUserAgent(ua);
  view.webContents.setWindowOpenHandler(({ url }) => {
    let allowed = false;
    try {
      const target = new URL(url); const host = target.hostname;
      allowed = target.protocol === 'https:' && (host === 'chatgpt.com' || host === 'openai.com' || host.endsWith('.openai.com') ||
        ['accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com'].includes(host));
    } catch { /* 无效地址拒绝打开。 */ }
    return { action: allowed ? 'allow' : 'deny', overrideBrowserWindowOptions: { webPreferences } };
  });
  view.webContents.on('did-create-window', popup => popup.webContents.setUserAgent(ua));
  return view;
}
