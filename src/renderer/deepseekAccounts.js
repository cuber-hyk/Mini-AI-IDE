/** DeepSeek 账号备注与选择；异步状态和切换锁统一归 webbar。 */
(function () {
  'use strict';
  window.createDeepSeekAccountsUI = function (options) {
    const ids = ['deepseek-accounts', 'deepseek-account-control', 'deepseek-account', 'deepseek-account-hint',
      'btn-add-deepseek-account', 'deepseek-account-form', 'deepseek-account-name', 'btn-confirm-deepseek-account', 'btn-cancel-deepseek-account'];
    const nodes = ids.map(function (id) { return document.getElementById(id); });
    if (nodes.some(function (node) { return !node; })) return { render: function () {} };
    const [root, control, select, hint, add, form, name, confirm, cancel] = nodes;
    let state = null;
    let blocked = true;
    let editing = false;
    let composing = false;
    let validationError = '';
    function close(restoreFocus) {
      editing = false; name.value = ''; root.classList.toggle('adding', false);
      form.hidden = true; control.hidden = false; add.hidden = false;
      if (validationError) { validationError = ''; options.onError(''); }
      if (restoreFocus && !root.hidden) add.focus();
    }
    function updateConfirm() {
      const value = name.value.trim();
      const error = /[\u0000-\u001f\u007f-\u009f]/.test(name.value) ? '账号备注不能包含控制字符'
        : value.length > 32 ? '账号备注最多 32 个字符'
        : value && state && state.deepseekAccounts && state.deepseekAccounts.accounts.some(function (account) { return account.name === value; }) ? '账号备注已存在，请使用其他名称' : '';
      confirm.disabled = blocked || !value || Boolean(error);
      name.setAttribute('aria-invalid', String(Boolean(error)));
      name.title = error || '输入 1–32 字账号备注，首次使用需手动登录';
      if (editing && error !== validationError) { validationError = error; options.onError(error); }
    }
    function render(next, local) {
      state = next;
      const accounts = state && state.deepseekAccounts;
      root.hidden = !state || state.platform !== 'deepseek' || !accounts;
      const reason = state && state.switchBlockedReason || (state && state.switching || local.switching ? '正在切换官网，请稍候' : '');
      blocked = root.hidden || Boolean(reason);
      if (root.hidden && editing) close(false);
      select.replaceChildren();
      if (accounts) accounts.accounts.forEach(function (account) {
        const option = document.createElement('option'); option.value = account.id; option.textContent = account.name; select.appendChild(option);
      });
      select.value = accounts ? accounts.activeId : '';
      const active = accounts && accounts.accounts.find(function (account) { return account.id === accounts.activeId; });
      select.disabled = blocked; add.disabled = blocked; name.disabled = blocked; cancel.disabled = blocked;
      select.title = reason || (active ? '切换 DeepSeek 账号：' + active.name : '切换 DeepSeek 账号');
      add.title = reason || '添加 DeepSeek 账号，首次使用需手动登录';
      confirm.title = reason || '保存备注并打开新账号'; cancel.title = reason || '取消添加账号';
      control.title = reason || select.title; control.tabIndex = blocked ? 0 : -1; hint.textContent = reason;
      updateConfirm();
    }
    add.addEventListener('click', function () {
      if (blocked) return;
      editing = true; root.classList.toggle('adding', true); control.hidden = true; add.hidden = true; form.hidden = false;
      name.value = ''; updateConfirm(); name.focus();
    });
    cancel.addEventListener('click', function () { if (!blocked) close(true); });
    name.addEventListener('input', function () { updateConfirm(); });
    name.addEventListener('compositionstart', function () { composing = true; });
    name.addEventListener('compositionend', function () { composing = false; updateConfirm(); });
    name.addEventListener('keydown', function (event) {
      if (composing || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape' && !blocked) { event.preventDefault(); close(true); }
      if (event.key === 'Enter') { event.preventDefault(); void submit(); }
    });
    async function submit() {
      updateConfirm();
      if (confirm.disabled || composing || !editing) return;
      const saved = await options.onAdd(name.value.trim());
      if (saved && editing) close(false);
    }
    confirm.addEventListener('click', submit);
    select.addEventListener('change', function () {
      if (blocked || !state || !state.deepseekAccounts) return;
      const id = select.value;
      if (id !== state.deepseekAccounts.activeId && state.deepseekAccounts.accounts.some(function (account) { return account.id === id; }))
        return options.onSelect(id);
    });
    return { render: render };
  };
})();
