/**
 * P0b 可达性与登录实测 —— preload（隔离世界）
 *
 * 只读观察：定期读取页面可见文本，命中"人机验证/风控提示"关键词时上报主进程。
 * **不修改页面**：不写 DOM、不点击、不填表、不派发事件、不绕过任何验证。
 */
const { ipcRenderer } = require('electron');

// 命中即上报的关键词（多语言，覆盖常见人机验证与风控提示）
const CHALLENGE_KEYWORDS = [
  '验证', '人机', '安全验证', '滑动', '拖动滑块', '异常', '行为异常', '访问受限',
  'verify you are human', 'verifying you are human', 'unusual traffic', 'captcha',
  'are you a robot', 'checking your browser', 'access denied', 'too many requests',
  '请完成安全验证', '网络环境异常', '操作过于频繁', '请求过于频繁',
];

let lastSignature = '';
let reported = false;

function scan() {
  try {
    const text = (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 20000);
    const matched = CHALLENGE_KEYWORDS.filter((k) => text.toLowerCase().includes(k.toLowerCase()));
    if (!matched.length) return;
    const signature = matched.join('|');
    if (signature === lastSignature) return;
    lastSignature = signature;
    const idx = text.toLowerCase().indexOf(matched[0].toLowerCase());
    ipcRenderer.send('challenge-signal', {
      url: location.href,
      matched,
      excerpt: text.slice(Math.max(0, idx - 80), idx + 200),
    });
  } catch (err) {
    /* 只读观察失败不打断用户操作 */
  }
}

window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.send('page-ready', { url: location.href, title: document.title });
  scan();
  // 低频轮询：足够发现提示，又不会给页面带来可观测负担
  const timer = setInterval(scan, 2000);
  window.addEventListener('beforeunload', () => clearInterval(timer));
});
