/* 文件路径呈现，项目根由工作区 owner 决定。 */
(function () {
  'use strict';
  window.setupEditorToolbar = function () {
    const root = document.getElementById('root-label');
    return {
      renderRoot: function (absolutePath) {
        const parts = String(absolutePath || '').split(/[\\/]/).filter(Boolean);
        root.textContent = absolutePath ? parts.slice(-2).join(' / ') || absolutePath : '未打开目录';
        root.title = absolutePath || '';
        const treePath = document.getElementById('tree-root-path');
        if (treePath) { treePath.textContent = absolutePath || '未选择项目'; treePath.title = absolutePath || ''; }
      },
    };
  };
})();
