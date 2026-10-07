/* 只刷新本地执行时长文字，不读取网页、不重绘工具正文。 */
(function () {
  'use strict';
  window.createToolExecutionClock = function () {
    let entries = [];
    let timer;
    function timing(result) {
      const process = result.tool === 'run_command' && result.data;
      const source = process && typeof process.started_at === 'number' ? process : result;
      const start = source.started_at;
      const finish = source.finished_at;
      return { start: start, finish: finish, running: typeof start === 'number' && typeof finish !== 'number' && source.status === 'running' };
    }
    function update() {
      const now = Date.now();
      entries.forEach(function (entry) {
        const times = timing(entry.result);
        entry.node.textContent = typeof times.start !== 'number' ? '' :
          (Math.max(0, (typeof times.finish === 'number' ? times.finish : now) - times.start) / 1000).toFixed(1) + 's';
      });
    }
    function stop() { if (timer !== undefined) clearInterval(timer); timer = undefined; }
    window.addEventListener('beforeunload', stop);
    return {
      replace: function (next) {
        stop(); entries = next; update();
        if (entries.some(function (entry) { return timing(entry.result).running; })) timer = setInterval(update, 1000);
      },
    };
  };
})();
