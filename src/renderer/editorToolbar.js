/* 文件路径呈现，项目根由工作区 owner 决定。 */
(function () {
  'use strict';
  window.setupEditorToolbar = function () {
    return {
      renderRoot: function (absolutePath) {
        const treePath = document.getElementById('tree-root-path');
        if (treePath) { treePath.textContent = absolutePath || '未选择项目'; treePath.title = absolutePath || ''; }
      },
    };
  };
})();
