/* 关注事件只由真实状态变化产生，重复广播和历史初始化不重复切换标签。 */
(function () {
  'use strict';
  window.createToolAttention = function () {
    let previous = new Set();
    let lastBatchStart = 0;
    function events(state) {
      const items = [];
      state.results.forEach(function (result) {
        const key = JSON.stringify([result.batch_id, result.request_id]);
        const process = result.tool === 'run_command' && result.data;
        if (result.status === 'pending_permission') items.push({ id: 'approval:' + key, key });
        if (result.status === 'failed' || process && (process.status === 'failed' || process.status === 'stopped' && process.timed_out)) {
          items.push({ id: 'failure:' + key, key });
        }
      });
      if (state.batchError) items.push({ id: 'validation:' + state.batchError.error, key: 'batch-error' });
      if (state.storageError) items.push({ id: 'storage:' + state.storageError });
      // 一次回传失败会先后由两个 owner 广播暂停；在都离开暂停前只视为同一事件。
      if (['continuation', 'resultReturn'].some(function (name) { return state[name] && state[name].phase === 'paused'; })) {
        items.push({ id: JSON.stringify(['paused', state.completion && state.completion.id,
          state.results.map(function (result) { return result.batch_id; })]) });
      }
      return items;
    }
    return {
      receive: function (state, baseline) {
        const next = events(state);
        const fresh = baseline || state.restored ? [] : next.filter(function (item) { return !previous.has(item.id); });
        previous = new Set(next.map(function (item) { return item.id; }));
        if (state.batchStart && state.batchStart.id > lastBatchStart) {
          lastBatchStart = state.batchStart.id;
          if (!baseline && !state.restored) fresh.push({ id: 'batch:' + lastBatchStart, kind: 'batch' });
        }
        return fresh;
      }
    };
  };
})();
