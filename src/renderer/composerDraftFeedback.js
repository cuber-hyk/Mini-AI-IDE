/* 只展示本轮当前项目新保存的网页草稿，文件读取沿用编辑器入口。 */
(function () {
  'use strict';
  window.setupComposerDraftFeedback = function (options) {
    let scope = null;
    let notification = 0;
    const opened = new Set();
    function current(event) {
      return event.root === options.getRoot() && event.revision === options.getRevision();
    }
    options.bridge.onComposerDraftSaved(async function (event) {
      if (!event || typeof event.root !== 'string' || !event.root || !Number.isInteger(event.revision) ||
          typeof event.relPath !== 'string' || !/^\.mini-ai-ide\/composer-drafts\/[A-Za-z0-9_-]+\.txt$/.test(event.relPath) || !current(event)) return;
      const nextScope = JSON.stringify([event.root, event.revision]);
      if (scope !== nextScope) { scope = nextScope; opened.clear(); }
      if (opened.has(event.relPath)) return;
      opened.add(event.relPath);
      const version = ++notification;
      options.setInfo('网页草稿已保存，工具结果回传继续');
      let ok = false;
      try { ok = await options.openFile(event.relPath, { focus: false, reveal: true }); }
      catch (_) { /* 展示失败不改变已保存事实，也不影响网页回传。 */ }
      if (!current(event) || version !== notification) return;
      options.setInfo(ok ? '网页草稿已保存，已打开备份：' + event.relPath :
        '网页草稿已保存，打开备份失败，请从文件区查看：' + event.relPath, !ok);
    });
  };
})();
