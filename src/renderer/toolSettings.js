/* 专用原生浮层只修改声明式设置，执行和持久化仍由主进程 owner 决定。 */
(function () {
  'use strict';
  const bridge = window.toolSettingsBridge;
  const interval = document.getElementById('tool-send-interval');
  const down = document.getElementById('tool-interval-down'), up = document.getElementById('tool-interval-up');
  const dirty = document.getElementById('tool-dirty-policy'), sound = document.getElementById('tool-completion-sound');
  const autoCopy = document.getElementById('tool-auto-copy'), clear = document.getElementById('tool-clear-rules');
  const notice = document.getElementById('tool-settings-notice'), hint = document.getElementById('tool-permission-hint');
  const audio = window.createToolCompletionSound();
  let state, saving = false, version = 0;

  function message(text, error) { notice.textContent = text; notice.classList.toggle('is-error', Boolean(error)); }
  function render() {
    const disabled = saving || !state || Boolean(state.storageError);
    [interval, dirty, sound, autoCopy].forEach(function (control) { control.disabled = disabled; });
    down.disabled = disabled || state.config.sendIntervalSeconds <= 0;
    up.disabled = disabled || state.config.sendIntervalSeconds >= 300;
    clear.disabled = disabled || !state.hasProject || state.busy;
    if (!state) return;
    if (document.activeElement !== interval || saving) interval.value = String(state.config.sendIntervalSeconds);
    dirty.value = state.config.dirtyPolicy; sound.checked = state.config.completionSound; autoCopy.checked = state.config.autoCopyResults;
    hint.textContent = state.storageError ? '工具记录未加载，设置不可用；仍可编辑提示词。' : {
      ask: '项目内读取与搜索自动执行；修改与命令由 IDE 请求批准。',
      rules: '按本项目已记住的规则执行；未覆盖的调用由 IDE 请求批准。',
      full: '在当前 Windows 账户权限内执行，可访问项目外文件并运行联网命令。',
    }[state.config.permission];
  }
  function receive(next) { state = next; version++; render(); if (state.storageError) message(state.storageError, true); }
  async function save(patch) {
    if (saving || !state || state.storageError) return false;
    saving = true; message('', false); render(); const before = version;
    try { const next = await bridge.configure(patch); if (version === before) receive(next); return true; }
    catch (error) { message('设置未保存：' + (error instanceof Error ? error.message : String(error)), true); return false; }
    finally { saving = false; render(); }
  }
  interval.addEventListener('change', function () {
    const seconds = Number(interval.value);
    if (!interval.value.trim() || !Number.isInteger(seconds) || seconds < 0 || seconds > 300) { message('发送间隔须为 0–300 秒的整数', true); interval.value = String(state.config.sendIntervalSeconds); return; }
    void save({ sendIntervalSeconds: seconds });
  });
  [down, up].forEach(function (button, index) {
    button.addEventListener('pointerdown', function (event) { event.preventDefault(); });
    button.addEventListener('click', function () { if (!button.disabled) void save({ sendIntervalSeconds: state.config.sendIntervalSeconds + (index === 0 ? -1 : 1) }); });
  });
  dirty.addEventListener('change', function () { void save({ dirtyPolicy: dirty.value }); });
  autoCopy.addEventListener('change', function () { void save({ autoCopyResults: autoCopy.checked }); });
  sound.addEventListener('change', async function () {
    if (saving || !state) return;
    const enabled = sound.checked;
    const prepared = enabled && !state.config.completionSound ? audio.prepare().catch(function () { return null; }) : null;
    const saved = await save({ completionSound: enabled });
    if (prepared) {
      const context = await prepared;
      if (!saved || !state.config.completionSound) return;
      if (!context) { message('音效未播放，可重新开启音效后重试。', true); return; }
      try { audio.play(context); } catch (_error) { message('音效未播放，可重新开启音效后重试。', true); }
    }
  });
  clear.addEventListener('click', async function () {
    if (clear.disabled) return;
    saving = true; message('', false); render(); const before = version;
    try { const next = await bridge.clearRules(); if (version === before) receive(next); message('已清除本项目记住的规则；未覆盖的调用会请求批准。', false); }
    catch (error) { message('清除规则失败：' + (error instanceof Error ? error.message : String(error)), true); }
    finally { saving = false; render(); }
  });
  function close() { void bridge.close().catch(function (error) { message(String(error), true); }); }
  document.getElementById('tool-settings-close').addEventListener('click', close);
  document.getElementById('btn-settings').addEventListener('click', function () { void bridge.openPrompt().catch(function (error) { message('打开提示词设置失败：' + String(error), true); }); });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') { event.preventDefault(); close(); } });
  window.addEventListener('beforeunload', function () { audio.dispose(); });
  bridge.onState(receive); const initial = version;
  render(); void bridge.getState().then(function (next) { if (version === initial) receive(next); }).catch(function (error) { message('读取设置失败：' + String(error), true); });
})();
