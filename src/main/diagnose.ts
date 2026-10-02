/**
 * 会话与网络诊断（`electron . --diagnose`）
 *
 * 目的：当"启动后需要重新登录"或"出现 SSL/网络错误"时，把真相测出来，而不是猜。
 * 它只做只读观测，不修改任何会话内容、不向网页写入任何内容。
 *
 * 输出：
 *  - 目标会话分区名与磁盘路径；
 *  - 该分区内的全部 cookie（名字 + 长度 + 过期时间；**不输出值**）；
 *  - 是否存在 `ds_session_id`（登录态判据）及其有效性；
 *  - 加载目标 URL 后的落点（`/sign_in` 还是聊天页）；
 *  - 网络失败明细（`did-fail-load` 与 webRequest 失败原因，含 SSL 错误）；
 *  - 实际使用的 UA 与分区。
 */
import { session, type WebContentsView } from 'electron';
import * as path from 'node:path';

import { STORAGE_PROBE_SCRIPT, summarizeInspection, type StorageInspection } from './storageProbe';

export interface DiagnoseInput {
  webView: WebContentsView;
  partition: string;
  targetUrl: string;
  userAgent: string;
  /** 探测等待时长（毫秒） */
  waitMs?: number;
}

export interface CookieFact {
  name: string;
  domain: string;
  path: string;
  valueLength: number;
  session: boolean;
  /** epoch 秒；session cookie 为 null */
  expires: number | null;
  expired: boolean;
}

export interface WebRequestFailure {
  url: string;
  error: string;
  resourceType: string;
  at: string;
}

export interface DiagnoseReport {
  collectedAt: string;
  partition: string;
  storagePath: string | null;
  userAgent: string;
  cookieCount: number;
  cookies: CookieFact[];
  hasSessionCookie: boolean;
  sessionCookieValid: boolean;
  /** 页面侧存储事实（只读）：用于判断登录态究竟存在哪里 */
  storage: StorageInspection | null;
  landingUrl: string;
  landedOnSignIn: boolean;
  webRequestFailures: WebRequestFailure[];
  didFailLoad: Array<{ code: number; desc: string; url: string }>;
  verdict: 'SESSION_OK' | 'SESSION_MISSING' | 'NETWORK_BLOCKED';
  notes: string[];
}

function sanitize(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(raw);
  }
}

export async function runDiagnose(input: DiagnoseInput): Promise<DiagnoseReport> {
  const ses = session.fromPartition(input.partition);
  const notes: string[] = [];

  const storagePath = (ses as unknown as { storagePath?: string }).storagePath ?? null;
  notes.push(`分区磁盘路径：${storagePath ?? '<未知>'}`);

  const rawCookies = await ses.cookies.get({});
  const now = Math.floor(Date.now() / 1000);
  const cookies: CookieFact[] = rawCookies.map((c) => {
    const sessionCookie = !c.expirationDate;
    const expired = !sessionCookie && (c.expirationDate as number) < now;
    return {
      name: c.name,
      domain: c.domain ?? '',
      path: c.path ?? '',
      valueLength: (c.value ?? '').length,
      session: sessionCookie,
      expires: sessionCookie ? null : Math.floor(c.expirationDate as number),
      expired,
    };
  });

  const sessionCookie = cookies.find((c) => c.name === 'ds_session_id');
  const hasSessionCookie = Boolean(sessionCookie && sessionCookie.valueLength > 0);
  const sessionCookieValid = Boolean(hasSessionCookie && !sessionCookie?.expired);

  /* ---- 网络失败观测（只读） ---- */
  const webRequestFailures: WebRequestFailure[] = [];
  ses.webRequest.onErrorOccurred((details) => {
    webRequestFailures.push({
      url: sanitize(details.url),
      error: details.error,
      resourceType: details.resourceType,
      at: new Date().toISOString(),
    });
  });

  const didFailLoad: Array<{ code: number; desc: string; url: string }> = [];
  input.webView.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) didFailLoad.push({ code, desc, url: sanitize(url) });
  });

  notes.push(`开始加载 ${input.targetUrl}（等待 ${input.waitMs ?? 15000} ms）`);
  let loadError: string | null = null;
  try {
    await input.webView.webContents.loadURL(input.targetUrl);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    notes.push(`loadURL 抛错：${loadError}`);
  }

  await new Promise((r) => setTimeout(r, input.waitMs ?? 15000));

  const landingUrl = input.webView.webContents.isDestroyed() ? '<已销毁>' : input.webView.webContents.getURL();
  const landedOnSignIn = /\/sign_in/.test(landingUrl);

  /* ---- 页面侧存储事实（只读注入读取，不修改页面）---- */
  let storage: StorageInspection | null = null;
  try {
    const raw = await input.webView.webContents.executeJavaScript(STORAGE_PROBE_SCRIPT, true);
    storage = summarizeInspection(raw);
    notes.push(
      `页面存储：localStorage ${storage.localStorage.length} 项 / sessionStorage ${storage.sessionStorage.length} 项 / IndexedDB ${storage.indexedDB.length} 个库`
    );
    if (storage.tokenKeys.length > 0) {
      notes.push(`疑似会话载体键名：${storage.tokenKeys.join(', ')}`);
    }
  } catch (err) {
    notes.push(`页面存储读取失败：${err instanceof Error ? err.message : String(err)}`);
  }

  /* ------------------------------------------------------------------ *
   * 登录态判定（教训：不能只看 cookie）
   *
   * 实测发现：**DeepSeek 的会话存放在 localStorage**（`userToken`、`settingsJwt`、
   * `__appKit_userInfo` 等），cookie 里只有设备指纹（`smidV2`、`.thumbcache_*`）。
   * 早期版本只查 cookie，因此把"已登录"误报为 `SESSION_MISSING`。
   *
   * 现行判据（任一命中即视为有会话）：
   *   a) cookie 中存在有效会话 cookie（其他站点可能是这种形态）；
   *   b) localStorage / sessionStorage 中存在**会话特征键**（键名含 token/session/auth/...）
   *      且其值**非空**。
   * 另外记录"是否落在登录页"作为独立信号，与存储判据分开报告。
   * ------------------------------------------------------------------ */
  const storageSessionFacts = storage
    ? [...storage.localStorage, ...storage.sessionStorage].filter((f) => f.sessionLike && f.valueLength > 0)
    : [];
  const storageHasSession = storageSessionFacts.length > 0;
  const sessionPresent = sessionCookieValid || storageHasSession;

  const sslFailures = webRequestFailures.filter((f) => /SSL|CONNECTION|TIMED_OUT|PROXY/i.test(f.error));
  let verdict: DiagnoseReport['verdict'];
  if (webRequestFailures.length > 0 && sslFailures.length === webRequestFailures.length) {
    verdict = 'NETWORK_BLOCKED';
  } else if (!sessionPresent) {
    verdict = 'SESSION_MISSING';
  } else {
    verdict = 'SESSION_OK';
  }

  notes.push(`网络失败数：${webRequestFailures.length}（其中疑似 TLS/连接类：${sslFailures.length}）`);
  notes.push(
    `会话载体：cookie=${sessionCookieValid ? '有' : '无'}，页面存储=${storageHasSession ? `有（${storageSessionFacts.map((f) => f.key).join(', ')}）` : '无'}`
  );
  if (landedOnSignIn && sessionPresent) {
    notes.push('检测到会话载体，但落点是登录页 —— 可能是接口层被拒或会话未被服务端接受');
  }
  if (!landedOnSignIn && !sessionPresent) {
    notes.push('未落在登录页但也未发现会话载体 —— 可能页面尚未完成初始化，建议加长等待时间后复测');
  }

  return {
    collectedAt: new Date().toISOString(),
    partition: input.partition,
    storagePath,
    userAgent: input.userAgent,
    cookieCount: cookies.length,
    cookies,
    hasSessionCookie,
    sessionCookieValid,
    storage,
    landingUrl: sanitize(landingUrl),
    landedOnSignIn,
    webRequestFailures: webRequestFailures.slice(0, 40),
    didFailLoad,
    verdict,
    notes,
  };
}

export function diagnoseOutPath(baseDir: string): string {
  return path.join(baseDir, `diagnose-${Date.now()}.json`);
}
