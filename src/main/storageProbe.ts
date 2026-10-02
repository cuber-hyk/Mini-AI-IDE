/**
 * 回程采集（主进程 / 诊断用，**只读**）
 *
 * 边界（ADR-0003）：本模块只做**读取**——在页面世界里读取 localStorage / IndexedDB /
 * sessionStorage 的**结构**（键名、大小、是否可解析出会话痕迹），用于判断"登录态存在哪里"。
 *
 * 它不修改页面、不写入任何内容、不派发事件。执行方式通过 `executeJavaScript`，
 * 且脚本是**纯读取**的 IIFE。
 */

export interface StorageFact {
  /** 所在存储 */
  area: 'localStorage' | 'sessionStorage' | 'indexedDB' | 'cookie';
  key: string;
  /** 值的字符长度（不输出值本身） */
  valueLength: number;
  /** 是否为 JSON 对象 */
  jsonLike: boolean;
  /** 值里是否出现会话相关关键词（命中即为可疑的会话载体） */
  sessionLike: boolean;
  /** 脱敏预览：只保留前 24 个字符并以 * 掩盖其余 */
  preview: string;
}

export interface StorageInspection {
  ok: boolean;
  capturedAt: string;
  url: string;
  localStorage: StorageFact[];
  sessionStorage: StorageFact[];
  indexedDB: Array<{ name: string; version: number; objectStores: string[] }>;
  /** 页面里的 token 痕迹（键名匹配，只报键名） */
  tokenKeys: string[];
  error?: string;
}

/** 会话相关关键词（用于判断某个键是否像会话载体，只做键名/长度层面判断） */
const SESSION_HINTS = ['token', 'session', 'auth', 'user', 'login', 'jwt', 'credential', 'account'];

function looksSessionLike(key: string): boolean {
  const lower = key.toLowerCase();
  return SESSION_HINTS.some((h) => lower.includes(h));
}

function preview(value: string): string {
  if (value.length <= 24) return value;
  return `${value.slice(0, 24)}${'*'.repeat(Math.min(24, value.length - 24))}`;
}

/** 需要注入页面执行的只读脚本（IIFE，不修改任何东西） */
export const STORAGE_PROBE_SCRIPT = `(async () => {
  const HINTS = ${JSON.stringify(SESSION_HINTS)};
  const looksSessionLike = (k) => {
    const s = String(k).toLowerCase();
    return HINTS.some((h) => s.includes(h));
  };
  const previewOf = (v) => {
    const s = String(v);
    return s.length <= 24 ? s : s.slice(0, 24) + '*'.repeat(Math.min(24, s.length - 24));
  };
  const dump = (area, storage) => {
    const out = [];
    try {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key === null) continue;
        const raw = storage.getItem(key) ?? '';
        let jsonLike = false;
        try { JSON.parse(raw); jsonLike = true; } catch (e) { jsonLike = false; }
        out.push({
          area,
          key,
          valueLength: raw.length,
          jsonLike,
          sessionLike: looksSessionLike(key),
          preview: previewOf(raw),
        });
      }
    } catch (e) { /* 读取失败忽略 */ }
    return out;
  };

  let indexedDB = [];
  try {
    if (indexedDB && typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases();
      indexedDB = dbs.map((d) => ({ name: d.name || '<unnamed>', version: d.version || 0, objectStores: [] }));
    }
  } catch (e) { indexedDB = []; }

  const localStorageFacts = dump('localStorage', window.localStorage);
  const sessionStorageFacts = dump('sessionStorage', window.sessionStorage);

  return {
    ok: true,
    capturedAt: new Date().toISOString(),
    url: location.href,
    localStorage: localStorageFacts,
    sessionStorage: sessionStorageFacts,
    indexedDB,
    tokenKeys: [...localStorageFacts, ...sessionStorageFacts].filter((f) => f.sessionLike).map((f) => f.key),
  };
})()`;

export function summarizeInspection(raw: unknown): StorageInspection {
  const obj = raw as Partial<StorageInspection> | null;
  if (!obj || obj.ok !== true) {
    return {
      ok: false,
      capturedAt: new Date().toISOString(),
      url: '',
      localStorage: [],
      sessionStorage: [],
      indexedDB: [],
      tokenKeys: [],
      error: '页面未返回可用的存储事实',
    };
  }
  return {
    ok: true,
    capturedAt: obj.capturedAt ?? new Date().toISOString(),
    url: obj.url ?? '',
    localStorage: (obj.localStorage ?? []).map((f) => ({ ...f, sessionLike: f.sessionLike || looksSessionLike(f.key), preview: preview(f.preview ?? '') })),
    sessionStorage: obj.sessionStorage ?? [],
    indexedDB: obj.indexedDB ?? [],
    tokenKeys: obj.tokenKeys ?? [],
  };
}
