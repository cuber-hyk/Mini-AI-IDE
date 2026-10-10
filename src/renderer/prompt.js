/** 唯一输出格式要求编辑器；无文件、命令和官网能力。 */
(function () {
  'use strict';
  const bridge = window.promptBridge;
  const el = {};
  ['close', 'editor', 'status', 'count', 'hint', 'usage', 'reset', 'cancel', 'save'].forEach(function (name) {
    el[name] = document.getElementById('pm-' + name);
  });
  if (!bridge || !el.editor || !el.status || !el.count || !el.save) return;
  const defaultText = window.formatSpecDefaults;
  const LOAD_RETRIES = 4;
  let state = null;
  let savedText = '';
  let maxLength = 10000;
  let saving = false;
  let loadError = '';
  function normalize(text) { return text.replace(/\r\n/g, '\n').trim(); }
  function paint() {
    const text = el.editor.value;
    const dirty = normalize(text) !== normalize(savedText);
    const over = text.length > maxLength;
    el.count.textContent = text.length + ' / ' + maxLength;
    el.count.classList.toggle('over', over);
    el.status.textContent = over ? '超出长度上限' : dirty ? '未保存' : state && state.isCustom ? '使用自定义' : '使用内置默认';
    el.status.className = 'pm-status ' + (over || dirty ? 'is-dirty' : state && state.isCustom ? 'is-custom' : 'is-default');
    el.save.disabled = saving || over || !dirty || !state;
    el.reset.disabled = saving || !state;
    el.editor.disabled = saving;
    el.hint.className = 'pm-hint';
    if (loadError) {
      el.hint.textContent = loadError;
      el.hint.className = 'pm-hint warn';
    } else if (over) {
      el.hint.textContent = '内容超出上限，请精简后再保存。';
      el.hint.className = 'pm-hint warn';
    } else if (!text.trim()) {
      el.hint.textContent = '内容为空：保存后恢复完整内置默认。';
    } else if (dirty) {
      el.hint.textContent = '已修改，保存后用于初始化需求和格式复制。';
    } else if (state && state.isCustom) {
      el.hint.textContent = '自定义原文已保留，程序始终附带强制工具协议。请检查自定义补充；旧行号格式不可应用。';
    } else {
      el.hint.textContent = '当前使用完整内置模板；改动并保存后使用自定义内容。';
    }
    el.usage.textContent = !state ? '未能确认当前设置，显示内置原文' :
      state.isCustom ? '当前使用：自定义（' + (state.updatedAt ? state.updatedAt.slice(0, 19).replace('T', ' ') : '—') + '）' : '当前使用：内置默认';
  }
  function absorbState(next) {
    state = next;
    maxLength = next.maxLength;
    savedText = next.isCustom && typeof next.customSpec === 'string' ? next.customSpec : next.defaultSpec;
    el.editor.value = savedText;
    loadError = '';
    paint();
  }
  async function load(attempt) {
    const tries = typeof attempt === 'number' ? attempt : 0;
    try {
      const next = await bridge.getState();
      if (!next || typeof next.defaultSpec !== 'string' || typeof next.maxLength !== 'number') throw new Error('主进程返回无效状态');
      absorbState(next);
    } catch (err) {
      if (tries < LOAD_RETRIES) {
        window.setTimeout(function () { void load(tries + 1); }, 120 * (tries + 1));
        return;
      }
      // 状态未知时只展示内置原文，不能覆盖可能存在的自定义设置。
      savedText = defaultText;
      el.editor.value = defaultText;
      loadError = '读取设置失败（显示内置原文，保存已禁用，请重新打开重试）：' + (err && err.message ? err.message : String(err));
      paint();
    }
  }
  async function save() {
    if (el.save.disabled) return;
    saving = true;
    paint();
    try {
      const result = await bridge.save(el.editor.value);
      if (!result || !result.ok) throw new Error(result && result.error || '未知错误');
      absorbState(result.state);
      el.hint.textContent = result.resetToDefault ? '已恢复完整内置默认。' : '已保存，初始化需求和格式复制将使用此内容。';
      el.hint.className = 'pm-hint ok';
    } catch (err) {
      saving = false;
      paint();
      el.hint.textContent = '保存失败（内容已保留在编辑框里，可直接重试）：' + (err && err.message ? err.message : String(err));
      el.hint.className = 'pm-hint warn';
      el.save.disabled = false;
    } finally {
      saving = false;
      el.editor.disabled = false;
      el.reset.disabled = !state;
      el.save.disabled = !state || el.editor.value.length > maxLength || normalize(el.editor.value) === normalize(savedText);
    }
  }
  function resetToDefault() {
    if (!state || saving) return;
    el.editor.value = state.defaultSpec;
    paint();
    el.editor.focus();
    el.hint.textContent = '已载入完整内置默认，保存后生效；取消可保留原设置。';
  }
  async function close() { await bridge.close(); }
  el.editor.addEventListener('input', paint);
  el.save.addEventListener('click', save);
  el.reset.addEventListener('click', resetToDefault);
  el.cancel.addEventListener('click', close);
  el.close.addEventListener('click', close);
  el.close.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void close(); }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { event.preventDefault(); void close(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
  });
  el.save.disabled = true;
  el.reset.disabled = true;
  void load();
})();
