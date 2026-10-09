/* 本地需求、技能选择与发送；网页写入只通过主进程窄接口。 */
window.setupLocalPrompt = function (bridge, setInfo) {
  const input = document.getElementById('requirement');
  const include = document.getElementById('prompt-initialization');
  const send = document.getElementById('btn-send-prompt');
  const menu = document.getElementById('skill-menu');
  const chips = document.getElementById('skill-chips');
  const preview = document.getElementById('skill-preview');
  const attachmentPanel = document.getElementById('prompt-attachments');
  const attachmentList = document.getElementById('prompt-attachment-list');
  const addAttachment = document.getElementById('btn-add-prompt-attachment');
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
  let stagingAttachments = 0;
  let attachmentStageFailed = false;
  let lastAttachmentStage = Promise.resolve(true);
  let composerBusy = false;
  let composing = false;
  let attachments = [];
  let busyListener = function () {};
  let publishedBusy;
  function errorText(err) { return err && err.message ? err.message : String(err); }
  function resized() { document.dispatchEvent(new Event('prompt-size-changed')); }
  function busy() { return !optionsReady || !catalogReady || changing || sending || stagingAttachments > 0 || composerBusy; }
  function paint() {
    send.disabled = busy() || !input.value.trim();
    send.classList.toggle('is-sending', sending);
    send.setAttribute('aria-label', sending ? '正在发送需求' : '发送需求');
    send.setAttribute('aria-busy', String(sending));
    send.title = sending ? '正在发送需求' : '发送需求';
    addAttachment.disabled = !optionsReady || changing || sending || stagingAttachments > 0 || composerBusy;
    include.disabled = !optionsReady || changing || sending || composerBusy;
    const externalBusy = !optionsReady || !catalogReady || changing || sending;
    if (publishedBusy !== externalBusy) { publishedBusy = externalBusy; busyListener(externalBusy); }
    resized();
  }
  function renderAttachments() {
    attachmentList.replaceChildren();
    attachments.forEach(function (file) {
      const chip = document.createElement('span'); chip.className = 'prompt-attachment';
      const name = document.createElement('span'); name.className = 'prompt-attachment-name'; name.textContent = file.name;
      name.title = file.name + ' · ' + (file.size / 1024 / 1024).toFixed(file.size < 1024 * 1024 ? 2 : 1) + ' MB';
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'prompt-attachment-remove'; remove.textContent = '×';
      remove.setAttribute('aria-label', '移除附件 ' + file.name); remove.disabled = busy();
      remove.addEventListener('click', function () {
        if (busy()) return;
        void bridge.removePromptAttachment(file.id).then(function () {
          attachments = attachments.filter(function (item) { return item.id !== file.id; }); renderAttachments(); paint();
        }).catch(function (err) { setInfo('移除附件失败：' + errorText(err), true); });
      });
      chip.append(name, remove); attachmentList.appendChild(chip);
    });
    attachmentPanel.hidden = attachments.length === 0; resized();
  }
  async function addFiles(operation) {
    if (busy()) return;
    stagingAttachments += 1; attachmentStageFailed = false; paint();
    setInfo('正在添加附件…');
    lastAttachmentStage = (async function () {
      try {
        const added = await operation();
        if (Array.isArray(added) && added.length) {
          const ids = new Set(attachments.map(function (item) { return item.id; }));
          attachments = attachments.concat(added.filter(function (item) { return item && typeof item.id === 'string' && !ids.has(item.id); }));
          renderAttachments();
        }
        return true;
      } catch (err) { attachmentStageFailed = true; setInfo('添加附件失败：' + errorText(err), true); return false; }
    })();
    try { await lastAttachmentStage; }
    finally { stagingAttachments = Math.max(0, stagingAttachments - 1); renderAttachments(); paint(); }
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
  function getSubmission() { syncSelection(); return { requirement: input.value.trim(), root: root, skills: selected.slice(), attachments: attachments.map(function (file) { return file.id; }) }; }
  async function submit() {
    if (!optionsReady || !catalogReady || changing || sending || composerBusy) return;
    sending = true; paint();
    if (stagingAttachments > 0) {
      setInfo('正在添加附件，完成后将继续发送…');
      await lastAttachmentStage;
    }
    if (attachmentStageFailed) { setInfo('附件添加失败，本次需求未发送；请重新添加图片后再试。', true); sending = false; paint(); return; }
    const draft = input.value;
    const submission = getSubmission();
    if (!submission.requirement) { setInfo('请先写下你的需求', true); input.focus(); sending = false; paint(); return; }
    try {
      const result = await bridge.sendPrompt(submission);
      if (!result.ok) { setInfo((result.uncertain ? '发送状态未知，请检查官网后再操作：' : '发送失败：') + (result.error || '未知错误'), true); return; }
      attachments = []; renderAttachments();
      if (root === submission.root && input.value === draft) {
        input.value = ''; closeMenu(); previewRevision += 1; preview.hidden = true;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      setInfo('需求已发送到官网');
    } catch (err) { setInfo('发送失败：' + errorText(err), true); }
    finally { sending = false; paint(); }
  }
  async function changeOptions() {
    if (changing || !optionsReady) return;
    changing = true; paint();
    try {
      const next = await bridge.setLocalPromptOptions({ includeInitialization: include.checked });
      include.checked = next.includeInitialization;
    } catch (err) {
      setInfo('保存输入设置失败：' + errorText(err), true);
      try { const next = await bridge.getLocalPromptOptions(); include.checked = next.includeInitialization; }
      catch (_) { optionsReady = false; }
    } finally { changing = false; paint(); }
  }
  include.addEventListener('change', function () { void changeOptions(); });
  send.addEventListener('click', function () { void submit(); });
  addAttachment.addEventListener('click', function () { void addFiles(function () { return bridge.choosePromptAttachments(); }); });
  async function readClipboardImage(file, sourceType) {
    const type = String(file.type || sourceType || '').toLowerCase();
    const direct = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
    const extension = direct[type];
    if (extension) return { name: 'clipboard-image.' + extension, type: type, bytes: new Uint8Array(await file.arrayBuffer()) };
    if (!type.startsWith('image/')) throw new Error('剪贴板格式不是可识别的图片');
    if (!file.size || file.size > 100 * 1024 * 1024) throw new Error('剪贴板图片不能为空且不能超过 100 MB');
    if (typeof createImageBitmap !== 'function') throw new Error('当前剪贴板图片格式无法转换，请先另存为 PNG/JPEG');
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d'); if (!context) throw new Error('无法转换剪贴板图片');
      context.drawImage(bitmap, 0, 0);
      const blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
      if (!blob) throw new Error('无法将剪贴板图片转换为 PNG');
      return { name: 'clipboard-image.png', type: 'image/png', bytes: new Uint8Array(await blob.arrayBuffer()) };
    } finally { bitmap.close(); }
  }
  input.addEventListener('paste', function (event) {
    if (!event.clipboardData) return;
    const items = Array.from(event.clipboardData.items || []);
    const image = items.find(function (item) { return item.kind === 'file' && item.type.toLowerCase().startsWith('image/'); });
    const file = image && image.getAsFile() || Array.from(event.clipboardData.files || []).find(function (candidate) { return candidate.type.toLowerCase().startsWith('image/'); });
    if (!file) {
      const types = Array.from(event.clipboardData.types || []).map(function (type) { return String(type).toLowerCase(); });
      if (types.some(function (type) { return type.startsWith('image/') || type === 'files'; })) setInfo('检测到剪贴板中可能有图片，但无法读取图片数据；请使用“添加附件”选择图片文件。', true);
      return;
    }
    event.preventDefault();
    if (busy()) { setInfo('当前需求正在处理，剪贴板图片未添加。请稍后重新粘贴。', true); return; }
    void addFiles(async function () {
      if (!file.size || file.size > 100 * 1024 * 1024) throw new Error('剪贴板图片不能为空且不能超过 100 MB');
      const normalized = await readClipboardImage(file, image && image.type);
      if (!normalized.bytes.byteLength || normalized.bytes.byteLength > 100 * 1024 * 1024) throw new Error('转换后的剪贴板图片不能为空且不能超过 100 MB');
      return bridge.stageClipboardPromptImage(normalized.name, normalized.type, normalized.bytes);
    });
  });
  const dropTarget = document.querySelector('.prompt-shell');
  function containsFiles(event) { return Array.from(event.dataTransfer?.types || []).includes('Files'); }
  function containsWorkspaceFiles(event) { return Array.from(event.dataTransfer?.types || []).includes('application/x-mini-ai-ide-workspace-files'); }
  ['dragenter', 'dragover'].forEach(function (name) { dropTarget.addEventListener(name, function (event) {
    if (!containsFiles(event) && !containsWorkspaceFiles(event)) return; event.preventDefault(); dropTarget.classList.add('has-file-drag');
  }); });
  ['dragleave', 'dragend'].forEach(function (name) { dropTarget.addEventListener(name, function (event) {
    if (!containsFiles(event) && !containsWorkspaceFiles(event)) return; dropTarget.classList.remove('has-file-drag');
  }); });
  dropTarget.addEventListener('drop', function (event) {
    if (!containsFiles(event) && !containsWorkspaceFiles(event)) return;
    event.preventDefault(); dropTarget.classList.remove('has-file-drag');
    if (containsFiles(event)) {
      const files = Array.from(event.dataTransfer.files || []); if (files.length) void addFiles(function () { return bridge.stagePromptAttachments(files); });
      return;
    }
    try {
      const payload = JSON.parse(event.dataTransfer.getData('application/x-mini-ai-ide-workspace-files'));
      if (payload && payload.root === root && Array.isArray(payload.paths) && payload.paths.length)
        void addFiles(function () { return bridge.stageWorkspacePromptAttachments(payload.paths, payload.root); });
      else setInfo('工作区已切换或拖入的文件无效，请重新拖入', true);
    } catch (_) { setInfo('无法读取工作区拖入的文件', true); }
  });
  document.getElementById('skill-preview-close').addEventListener('click', function () { previewRevision += 1; preview.hidden = true; resized(); });
  input.addEventListener('input', function () { updateMenu(); paint(); });
  input.addEventListener('click', updateMenu);
  input.addEventListener('compositionstart', function () { composing = true; closeMenu(); });
  input.addEventListener('compositionend', function () { composing = false; updateMenu(); });
  input.addEventListener('keydown', function (event) {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && event.shiftKey) { closeMenu(); return; }
    if (event.key === 'Enter' && event.repeat && !event.shiftKey) { event.preventDefault(); return; }
    if (!menu.hidden) {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); active = (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length; paintMenu(); return; }
      if (event.key === 'Enter') { event.preventDefault(); choose(active); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); }
  });
  bridge.onRootChanged(function (next) { root = next.root; attachments = []; renderAttachments(); void refreshCatalog(); });
  paint();
  void bridge.getLocalPromptOptions().then(function (next) { include.checked = next.includeInitialization; optionsReady = true; paint(); }).catch(function (err) { setInfo('读取输入设置失败：' + errorText(err), true); });
  void refreshCatalog();
  return {
    getSubmission: getSubmission,
    stageWorkspaceAttachments: function (paths) { return addFiles(function () { return bridge.stageWorkspacePromptAttachments(paths, root); }); },
    setComposerBusy: function (value) { composerBusy = value; paint(); },
    onBusy: function (listener) { busyListener = listener; listener(!optionsReady || !catalogReady || changing || sending); },
  };
};
