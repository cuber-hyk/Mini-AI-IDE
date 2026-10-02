/**
 * P0a 网页内自检（页面世界）
 *
 * 只做观察：把只能在页面世界里测得的信号回报给主进程。
 * 不做任何伪装、不覆写属性、不写入 DOM（仅更新本页 <pre> 用于人眼查看）。
 */
(function () {
  const out = document.getElementById('out');

  function checkConsoleDebugSerialization() {
    // CDP 的 Runtime.enable 会为 console.debug 增加序列化行为；用 toString 形态探测
    try {
      return { ok: true, source: String(console.debug).slice(0, 120) };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async function checkPermissions() {
    // 已知无头/自动化环境下 permissions.query 可能异常
    try {
      const names = ['notifications', 'geolocation', 'clipboard-read'];
      const results = {};
      for (const name of names) {
        try {
          const status = await navigator.permissions.query({ name });
          results[name] = status.state;
        } catch (err) {
          results[name] = `error: ${err.name}`;
        }
      }
      return results;
    } catch (err) {
      return { error: String(err) };
    }
  }

  (async () => {
    const pageLevel = {
      consoleDebug: checkConsoleDebugSerialization(),
      permissions: await checkPermissions(),
      notificationPermission: typeof Notification !== 'undefined' ? Notification.permission : 'Notification 不存在',
      isSecureContext: window.isSecureContext,
      origin: location.origin,
      hasServiceWorkerApi: 'serviceWorker' in navigator,
      serviceWorkerContainers: navigator.serviceWorker ? navigator.serviceWorker.controller !== null : null,
    };

    // 触发 contextBridge 暴露的只读采集器（其结果由主进程接收）
    let bridged = null;
    if (window.__traceProbe && typeof window.__traceProbe.collect === 'function') {
      bridged = window.__traceProbe.collect();
    }

    const merged = { pageLevel, bridged };
    out.textContent = JSON.stringify(merged, null, 2);
    out.className = bridged && bridged.aLevel.every((t) => t.pass) ? 'ok' : 'bad';
    window.__traceProbePageLevel = pageLevel;
  })();
})();
