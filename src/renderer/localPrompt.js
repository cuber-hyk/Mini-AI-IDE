/* 本地需求、技能选择与发送；网页写入只通过主进程窄接口。 */
window.setupLocalPrompt = function (bridge, setInfo) {
  const input = document.getElementById('requirement');
  const include = document.getElementById('prompt-initialization');
  const enter = document.getElementById('prompt-send-on-enter');
  const send = document.getElementById('btn-send-prompt');
  const menu = document.getElementById('skill-menu');
  const chips = document.getElementById('skill-chips');
  const preview = document.getElementById('skill-preview');
  let root = null;
  let catalog = [];
  let selected = [];
  let matches = [];
  let active = 0;
  let token;
  let revision = 0;
  let previewRevision = 0;
  let optionsReady = false;
  let catalogReady = false;
  let changing = false;
  let sending = false;
  let composerBusy = false;
  let composing = false;
  let busyListener = function () {};
  let publishedBusy;
  function errorText(err) { return err && err.message ? err.message : String(err); }
  function resized() { document.dispatchEvent(new Event('prompt-size-changed')); }
  function busy() { return !optionsReady || !catalogReady || changing || sending || composerBusy; }
  function paint() {
    send.hidden = !enter.checked;
    send.disabled = busy();
    include.disabled = !optionsReady || changing || sending || composerBusy;
    // 关闭发送仍允许主进程取消等待中的动作。
    enter.disabled = !optionsReady || changing;
    const externalBusy = !optionsReady || !catalogReady || changing || sending;
    if (publishedBusy !== externalBusy) { publishedBusy = externalBusy; busyListener(externalBusy); }
    resized();
  }
  function closeMenu() { menu.hidden = true; token = undefined; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); resized(); }
  function showPreview(name) {
    const version = ++previewRevision;
    preview.hidden = false; preview.textContent = '加载技能说明…'; resized();
    void bridge.loadSkill(name).then(function (result) {
      if (version !== previewRevision) return;
      if (!result.ok || !result.skill) throw new Error(result.error || '技能不可用');
      preview.textContent = result.skill.content; resized();
    }).catch(function (err) { if (version === previewRevision) { preview.textContent = '加载失败：' + errorText(err); resized(); } });
  }
  function syncSelection() {
    const names = new Set((input.value.match(/(?:^|\s)\/([^\s/\\，。；：！？,.!?;:]+)(?=$|[\s，。；：！？,.!?;:])/g) || []).map(function (value) { return value.trim().slice(1); }));
    selected = selected.filter(function (name) { return names.has(name) && catalog.some(function (skill) { return skill.name === name; }); });
    chips.replaceChildren();
    selected.forEach(function (name) {
      const skill = catalog.find(function (entry) { return entry.name === name; });
      const button = document.createElement('button'); button.type = 'button'; button.className = 'skill-chip';
      button.textContent = '/' + name + ' · ' + (skill.source === 'project' ? '项目' : '全局'); button.title = '查看技能说明';
      button.addEventListener('click', function () { showPreview(name); }); chips.appendChild(button);
    });
    chips.hidden = selected.length === 0; resized();
  }
  function choose(index) {
    const skill = matches[index]; if (!skill || !token) return;
    const replacement = '/' + skill.name + ' ';
    input.setRangeText(replacement, token.start, input.selectionStart, 'end');
    if (!selected.includes(skill.name)) selected.push(skill.name);
    closeMenu(); syncSelection(); input.dispatchEvent(new Event('input')); input.focus();
  }
  function paintMenu() {
    menu.replaceChildren();
    matches.forEach(function (skill, index) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'skill-option';
      button.id = 'skill-option-' + index; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === active));
      const source = skill.source === 'project' ? '项目' : '全局';
      button.title = '/' + skill.name + ' · ' + source + '\n' + skill.description;
      button.setAttribute('aria-label', '/' + skill.name + '，' + source + '，' + skill.description);
      for (const [className, text] of [['skill-option-icon', '/'], ['skill-option-name', skill.name], ['skill-option-source', source], ['skill-option-description', skill.description]]) {
        const span = document.createElement('span'); span.className = className; span.textContent = text;
        if (className === 'skill-option-icon') span.setAttribute('aria-hidden', 'true');
        button.appendChild(span);
      }
      button.addEventListener('mousedown', function (event) { event.preventDefault(); });
      button.addEventListener('mousemove', function () {
        if (active === index) return;
        active = index;
        Array.from(menu.children).forEach(function (row, position) { row.setAttribute('aria-selected', String(position === active)); });
        input.setAttribute('aria-activedescendant', button.id);
      });
      button.addEventListener('click', function () { choose(index); }); menu.appendChild(button);
    });
    menu.hidden = matches.length === 0;
    input.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) {
      input.setAttribute('aria-activedescendant', 'skill-option-' + active);
      const row = menu.children[active];
      if (row.offsetTop < menu.scrollTop) menu.scrollTop = row.offsetTop;
      else if (row.offsetTop + row.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = row.offsetTop + row.offsetHeight - menu.clientHeight;
    }
    else input.removeAttribute('aria-activedescendant');
    resized();
  }
  function updateMenu() {
    syncSelection();
    const before = input.value.slice(0, input.selectionStart);
    const match = /(?:^|\s)\/([^\s/\\，。；：！？,.!?;:]*)$/.exec(before);
    if (!match || composing) { closeMenu(); return; }
    const query = match[1].toLowerCase(); token = { start: before.length - query.length - 1 };
    matches = catalog.filter(function (skill) { return skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query); });
    active = 0; paintMenu();
  }
  async function refreshCatalog() {
    const version = ++revision;
    catalogReady = false; closeMenu(); paint();
    previewRevision += 1; preview.hidden = true; resized();
    try {
      const next = await bridge.getSkillCatalog(); if (version !== revision) return;
      root = next.root; catalog = next.skills; catalogReady = true; paint();
      updateMenu();
    } catch (err) { if (version === revision) { catalog = []; catalogReady = true; paint(); updateMenu(); } }
  }
  function getSubmission() { syncSelection(); return { requirement: input.value.trim(), root: root, skills: selected.slice() }; }
  async function submit() {
    if (busy() || !enter.checked) return;
    const submission = getSubmission();
    if (!submission.requirement) { setInfo('请先写下你的需求', true); input.focus(); return; }
    sending = true; paint();
    try {
      const result = await bridge.sendPrompt(submission);
      if (!result.ok) { setInfo((result.uncertain ? '发送状态未知，请检查官网后再操作：' : '发送失败：') + (result.error || '未知错误'), true); return; }
      setInfo('需求已发送到官网，保留本地草稿');
    } catch (err) { setInfo('发送失败：' + errorText(err), true); }
    finally { sending = false; paint(); }
  }
  async function changeOptions() {
    if (changing || !optionsReady) return;
    changing = true; paint();
    try {
      const next = await bridge.setLocalPromptOptions({ includeInitialization: include.checked, sendOnEnter: enter.checked });
      include.checked = next.includeInitialization; enter.checked = next.sendOnEnter;
    } catch (err) {
      setInfo('保存输入设置失败：' + errorText(err), true);
      try { const next = await bridge.getLocalPromptOptions(); include.checked = next.includeInitialization; enter.checked = next.sendOnEnter; }
      catch (_) { optionsReady = false; }
    } finally { changing = false; paint(); }
  }
  include.addEventListener('change', function () { void changeOptions(); });
  enter.addEventListener('change', function () { void changeOptions(); });
  send.addEventListener('click', function () { void submit(); });
  document.getElementById('skill-preview-close').addEventListener('click', function () { previewRevision += 1; preview.hidden = true; resized(); });
  input.addEventListener('input', updateMenu);
  input.addEventListener('click', updateMenu);
  input.addEventListener('compositionstart', function () { composing = true; closeMenu(); });
  input.addEventListener('compositionend', function () { composing = false; updateMenu(); });
  input.addEventListener('keydown', function (event) {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && event.shiftKey) { closeMenu(); return; }
    if (event.key === 'Enter' && event.repeat && !event.shiftKey && (enter.checked || !menu.hidden)) { event.preventDefault(); return; }
    if (!menu.hidden) {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); active = (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length; paintMenu(); return; }
      if (event.key === 'Enter') { event.preventDefault(); choose(active); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey && enter.checked) { event.preventDefault(); void submit(); }
  });
  bridge.onRootChanged(function (next) { root = next.root; void refreshCatalog(); });
  paint();
  void bridge.getLocalPromptOptions().then(function (next) { include.checked = next.includeInitialization; enter.checked = next.sendOnEnter; optionsReady = true; paint(); }).catch(function (err) { setInfo('读取输入设置失败：' + errorText(err), true); });
  void refreshCatalog();
  return {
    getSubmission: getSubmission,
    setComposerBusy: function (value) { composerBusy = value; paint(); },
    onBusy: function (listener) { busyListener = listener; listener(!optionsReady || !catalogReady || changing || sending); },
  };
};
