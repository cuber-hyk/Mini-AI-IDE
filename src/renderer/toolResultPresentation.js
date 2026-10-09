/* 仅用真实工具结果生成展示摘要；原始结果由调用方保留。 */
(function () {
  'use strict';
  const labels = {
    get_project_info: '项目概况', list_directory: '查看目录', search_files: '查找文件',
    read_file: '读取文件', attach_file: '暂存附件', search_text: '搜索文本', apply_changes: '修改文件', load_skill: '加载技能',
    run_command: '运行命令', get_process_output: '读取进程输出', stop_process: '停止进程',
  };
  const object = function (value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; };
  const text = function (value) { return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''; };
  const brief = function (value) { const normalized = text(value); return normalized.length > 120 ? normalized.slice(0, 119) + '…' : normalized; };
  const integer = function (value) { return Number.isSafeInteger(value) && value >= 0; };

  window.describeToolResult = function (value) {
    const result = object(value);
    const data = object(result.data);
    const label = Object.hasOwn(labels, result.tool) ? labels[result.tool] : '工具调用';
    const outcomes = Array.isArray(data.outcomes) ? data.outcomes : [];
    const paths = outcomes.map(function (outcome) { return text(object(outcome).path); }).filter(Boolean);
    let target = text(data.path) || text(data.root) || text(data.process_id);
    if (result.tool === 'load_skill') target = text(data.name);
    if (result.tool === 'attach_file') target = text(data.name);
    if (result.tool === 'apply_changes') target = paths.length === 1 ? paths[0] : paths.length > 1 ? paths.length + ' 个目标' : '';
    const details = [];
    const error = brief(result.error);
    const dataError = brief(data.error);
    if (error) details.push(error);
    if (dataError && dataError !== error) details.push(dataError);

    // 尚未执行/结果未知不能用残留 data 声称完成了读取或修改。
    if (result.status === 'done' || result.status === 'failed') {
      switch (result.tool) {
        case 'attach_file':
          if (result.status === 'done') {
            details.push('已暂存，待发送');
            if (integer(data.size)) details.push(data.size + ' 字节');
          }
          break;
        case 'get_project_info':
        case 'list_directory':
          if (Array.isArray(data.entries)) details.push(data.entries.length + ' 项');
          break;
        case 'search_files':
          if (Array.isArray(data.files)) details.push(data.files.length + ' 个匹配文件');
          break;
        case 'search_text':
          if (Array.isArray(data.matches)) details.push(data.matches.length + ' 处匹配');
          break;
        case 'read_file':
          if (integer(data.start_line) && integer(data.end_line)) details.push(data.end_line >= data.start_line
            ? '第 ' + data.start_line + '–' + data.end_line + ' 行' : '未返回行');
          if (integer(data.total_lines)) details.push('共 ' + data.total_lines + ' 行');
          break;
        case 'apply_changes': {
          const applied = outcomes.filter(function (outcome) { return object(outcome).ok === true; }).length;
          const failed = outcomes.filter(function (outcome) { return object(outcome).ok === false; }).length;
          if (outcomes.length) details.push('已修改 ' + applied + ' 项');
          if (failed) details.push(failed + ' 项失败');
          break;
        }
        case 'run_command':
        case 'get_process_output':
        case 'stop_process':
          if (data.status === 'running') details.push('进程仍在运行');
          else if (data.status === 'stopped') details.push('进程已停止');
          else if (data.status === 'failed') details.push('进程执行失败');
          else if (data.status === 'done') details.push('进程已结束');
          if (typeof data.exit_code === 'number' && Number.isInteger(data.exit_code)) details.push('退出码 ' + data.exit_code);
          if (data.timed_out === true) details.push('已超时');
          if (text(data.signal)) details.push('信号 ' + brief(data.signal));
          if (data.has_more === true) details.push('还有输出可读取');
          if (data.cleanup_pending === true) details.push('进程树待清理');
          break;
      }
      if (data.truncated === true) details.push('结果已截断');
      if (Array.isArray(data.skipped) && data.skipped.length) details.push('跳过 ' + data.skipped.length + ' 项');
    }
    return { label, target, detail: details.join(' · ') };
  };
})();
