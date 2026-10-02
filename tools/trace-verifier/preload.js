/**
 * P0a 自动化特征核验 —— 网页内探针（preload，隔离世界）
 *
 * 边界说明（重要）：
 *  本探针只做一件事 —— **观察并采集**现有环境的可观测值。
 *  它不修改任何属性、不伪装身份、不覆写 getter、不写入页面 DOM。
 *  这符合项目硬边界"程序不向网页写入任何内容"（只读取可观测值）。
 */
const { contextBridge, ipcRenderer } = require('electron');

/** 读取属性的描述符形态，用于识别"被注入式伪装过"的表面 */
function describeProperty(obj, key) {
  if (!obj) return null;
  try {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    if (!d) return { present: false };
    const type = typeof d.value;
    return {
      present: true,
      kind: d.get || d.set ? 'accessor' : 'data',
      valueType: type,
      isNative: type === 'function' ? /\{\s*\[native code\]\s*\}/.test(String(d.value)) : null,
      enumerable: !!d.enumerable,
      configurable: !!d.configurable,
      writable: !!d.writable,
    };
  } catch (err) {
    return { present: null, error: String(err) };
  }
}

/** 识别常见的"伪造身份"注入痕迹：脚本覆写原生 getter 会留下这些特征 */
function inspectSpoofSignals() {
  const signals = [];
  const checks = [
    ['navigator', 'userAgent'],
    ['navigator', 'platform'],
    ['navigator', 'webdriver'],
    ['navigator', 'languages'],
    ['navigator', 'hardwareConcurrency'],
    ['screen', 'width'],
    ['screen', 'height'],
  ];
  for (const [owner, key] of checks) {
    const target = window[owner];
    const d = describeProperty(target, key);
    if (d && d.present && d.kind === 'accessor') {
      signals.push(`${owner}.${key} 被定义为 accessor（原生实现应为 data 属性或原生 getter）`);
    }
    if (d && d.present && d.kind === 'data' && d.isNative === false) {
      signals.push(`${owner}.${key} 被非原生函数覆写`);
    }
  }
  return signals;
}

function collectBrowserSurface() {
  const chrome = window.chrome || null;
  return {
    chromeExists: !!chrome,
    chromeKeys: chrome ? Object.keys(chrome) : [],
    chromeApp: !!(chrome && chrome.app),
    chromeRuntime: !!(chrome && chrome.runtime),
    chromeCsi: typeof (chrome && chrome.csi),
    chromeLoadTimes: typeof (chrome && chrome.loadTimes),
    pluginsLength: navigator.plugins ? navigator.plugins.length : null,
    mimeTypesLength: navigator.mimeTypes ? navigator.mimeTypes.length : null,
    languages: navigator.languages ? Array.from(navigator.languages) : null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemory: navigator.deviceMemory ?? null,
    platform: navigator.platform,
    userAgent: navigator.userAgent,
    userAgentDataBrands: navigator.userAgentData ? navigator.userAgentData.brands : null,
    userAgentDataMobile: navigator.userAgentData ? navigator.userAgentData.mobile : null,
    userAgentDataPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
    webdriver: navigator.webdriver,
    pdfViewerEnabled: navigator.pdfViewerEnabled ?? null,
    productSub: navigator.productSub,
    vendor: navigator.vendor,
    maxTouchPoints: navigator.maxTouchPoints,
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth,
    },
  };
}

function collectLeaks() {
  const suspiciousGlobals = [
    'require',
    'module',
    'exports',
    'process',
    'global',
    'Buffer',
    '__dirname',
    '__filename',
    'electron',
    'webFrame',
    'ipcRenderer',
  ];
  const found = [];
  for (const name of suspiciousGlobals) {
    try {
      if (typeof window[name] !== 'undefined') found.push(name);
    } catch {
      found.push(`${name} (抛错：可能是可疑的受保护属性)`);
    }
  }
  return {
    suspiciousGlobals: found,
    chromeRuntimeUndefined: typeof (window.chrome && window.chrome.runtime) === 'undefined',
  };
}

function collectCdpTraces() {
  // 已知的自动化/CDP 痕迹位置（只读取，不写入）
  const traces = [];
  if ('__playwright' in window) traces.push('window.__playwright');
  if ('__puppeteer_evaluation_script__' in window) traces.push('window.__puppeteer_evaluation_script__');
  if ('__pw_manual' in window) traces.push('window.__pw_manual');
  if ('__nightmare' in window) traces.push('window.__nightmare');
  if ('_phantom' in window) traces.push('window._phantom');
  if ('callPhantom' in window) traces.push('window.callPhantom');
  if ('__selenium_unwrapped' in window) traces.push('window.__selenium_unwrapped');
  if ('__webdriver_evaluate' in window) traces.push('window.__webdriver_evaluate');
  if ('__driver_evaluate' in window) traces.push('window.__driver_evaluate');
  if ('__fxdriver_evaluate' in window) traces.push('window.__fxdriver_evaluate');
  if (document.documentElement && document.documentElement.getAttribute('webdriver')) {
    traces.push('documentElement[webdriver]');
  }
  const cdcKeys = Object.keys(window).filter((k) => /^\$?cdc_/.test(k));
  if (cdcKeys.length) traces.push(`cdc_* keys: ${cdcKeys.join(', ')}`);

  // 无头特征
  const headlessSignals = [];
  if (navigator.webdriver === true) headlessSignals.push('navigator.webdriver === true');
  if (typeof window.Notification === 'undefined') headlessSignals.push('Notification 不存在');
  if (typeof window.chrome === 'undefined') headlessSignals.push('window.chrome 不存在');
  if (navigator.plugins && navigator.plugins.length === 0) headlessSignals.push('plugins 为空');
  if (!navigator.languages || navigator.languages.length === 0) headlessSignals.push('languages 为空');

  return { traces, headlessSignals };
}

function buildResult() {
  const leaks = collectLeaks();
  const cdp = collectCdpTraces();
  const spoof = inspectSpoofSignals();
  const chromeSurface = collectBrowserSurface();

  // ---- A 级：自动化特征，必须为零 ----
  const aLevel = [
    {
      id: 'A1',
      name: 'navigator.webdriver 非真值',
      pass: navigator.webdriver !== true,
      observed: navigator.webdriver,
    },
    {
      id: 'A2',
      name: '无 playright/puppeteer/selenium 等自动化痕迹',
      pass: cdp.traces.length === 0,
      observed: cdp.traces,
    },
    {
      id: 'A3',
      name: '无 cdc_* 类 CDP 注入痕迹',
      pass: !cdp.traces.some((t) => t.startsWith('cdc_')),
      observed: cdp.traces.filter((t) => t.startsWith('cdc_')),
    },
    {
      id: 'A4',
      name: '无无头模式特征',
      pass: cdp.headlessSignals.length === 0,
      observed: cdp.headlessSignals,
    },
    {
      id: 'A5',
      name: '渲染进程无 Electron/Node 全局泄漏',
      pass: leaks.suspiciousGlobals.length === 0,
      observed: leaks.suspiciousGlobals,
    },
    {
      id: 'A6',
      name: '无注入式身份伪装痕迹（未覆写原生属性）',
      pass: spoof.length === 0,
      observed: spoof,
    },
  ];

  // ---- C 级：伪装造成的内部矛盾，不得出现 ----
  // 说明：判定的是"声明之间互相矛盾 / 声明与能力不符"，而不是"声明了 Electron"。
  // 按 ADR-0001，Electron 默认 UA 中出现 `Electron/xx` 是**如实披露**，属预期与可接受；
  // 若强行删掉该标记却仍留着 Chrome 标记，反而是 C 级红线。因此这里对 Chrome 标记本身不判失败。
  const ua = navigator.userAgent;
  const uaChromeMatch = /Chrome\/(\d+)\./.exec(ua);
  const realKernelMatch = /(?:Chrome|Chromium)\/(\d+)\./.exec(navigator.userAgent);
  const uaChromeMajor = uaChromeMatch ? uaChromeMatch[1] : null;
  const cLevel = [
    {
      id: 'C1',
      name: 'UA 声明的 Chrome 主版本与声明的内核版本自洽（无版本错乱）',
      pass: uaChromeMajor !== null && realKernelMatch !== null && uaChromeMajor === realKernelMatch[1],
      observed: { uaChromeMajor, kernelFromUa: realKernelMatch ? realKernelMatch[1] : null, ua },
    },
    {
      id: 'C2',
      name: 'UA 未声称 Chrome 却缺失 Chrome 能力（反向伪造矛盾）',
      pass: !( /Chrome\/\d+/.test(ua) && !/Electron\/\d+/.test(ua) && !(chromeSurface && chromeSurface.chromeApp) ),
      observed: null,
    },
  ];

  // ---- B 级：如实记录（不追求消除） ----
  const bLevel = {
    note: 'B 级为如实记录项，不作为修补目标（见 ADR-0003）',
    browserSurface: chromeSurface,
    cdpProbe: cdp,
    chromiumVersion: process.versions.chrome || null,
    electronVersion: process.versions.electron || null,
    v8Version: process.versions.v8 || null,
    // ADR-0001 的直接后果：平台可看出本客户端为 Electron 应用。此为**已知且接受**的披露，
    // 仅在报告中留档，不构成矛盾，也不作为修补目标。
    electronDisclosure: {
      uaContainsElectronToken: /Electron\/\d+/.test(ua),
      uaContainsChromeToken: /Chrome\/\d+/.test(ua),
      note: '按 ADR-0001，如实披露 Electron 身份是决策本身；删除该标记属于伪装，被禁止',
    },
  };

  return {
    collectedAt: new Date().toISOString(),
    location: location.href,
    aLevel,
    bLevel,
    cLevel,
  };
}

// 只暴露一个只读方法给隔离世界之外调用；不暴露任何写入能力
contextBridge.exposeInMainWorld('__traceProbe', {
  collect: () => {
    const result = buildResult();
    ipcRenderer.send('trace-result', result);
    return result;
  },
});
