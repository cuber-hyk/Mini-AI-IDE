/**
 * 提示词编辑面板（渲染进程脚本）
 *
 * 这个视图改的是**系统提示词里的「输出格式要求」那一段**：
 * 提示词的其余部分（## 用户需求 / ## 工作环境 / ## 目录结构）由程序按模板生成，
 * 用户不需要也不该改；唯一需要按模型/任务调整的就是这段格式约定。
 *
 * **分版本**（用户设计）：简洁版与完整版各有自己的内置默认与自定义内容，
 * 顶部页签切换，互不影响。底部双段开关决定"实际发出去用哪一版"。
 *
 * 边界（与其它面板一致）：不能读文件、不能访问 Node、不能向网页写入任何内容。
 * 它只做四件事：读状态 / 按版本保存 / 按版本恢复默认 / 关闭。
 */
(function () {
  'use strict';

  const bridge = window.promptBridge;
  const el = {
    close: document.getElementById('pm-close'),
    editor: document.getElementById('pm-editor'),
    status: document.getElementById('pm-status'),
    count: document.getElementById('pm-count'),
    hint: document.getElementById('pm-hint'),
    usage: document.getElementById('pm-usage'),
    reset: document.getElementById('pm-reset'),
    cancel: document.getElementById('pm-cancel'),
    save: document.getElementById('pm-save'),
    tabs: Array.prototype.slice.call(document.querySelectorAll('.pm-tab')),
    tabUsing: document.getElementById('pm-tab-using'),
  };
  if (!bridge || !el.editor || !el.status || !el.count || !el.save) {
    return;
  }

  // 两版兜底原文来自构建生成资源，与 shared/formatSpec 保持逐字一致。
  const defaults = window.formatSpecDefaults;
  function defaultText(variant) { return defaults[variant === 'full' ? 'full' : 'short']; }

  /**
   * 每个版本的独立编辑状态。
   *
   * `savedText` 是"最近一次成功保存/载入的内容"，用它判定 `dirty` —— 不能拿
   * `state.x.customSpec` 直接比，因为 `state` 每次保存都会被整体替换，
   * 而"有没有未保存的改动"必须拿**编辑框当前文本**与**最近一次生效的内容**比。
   *
   * `draft` 缓存"切走时还没保存的编辑"，这样在两个页签之间来回切不会丢掉草稿。
   */
  const perVariant = {
    short: { savedText: '', draft: null, dirty: false, defaultSpec: '', isCustom: false },
    full: { savedText: '', draft: null, dirty: false, defaultSpec: '', isCustom: false },
  };

  /** 主进程给的当前状态（保存后会整体替换） */
  let state = null;
  /** 当前正在编辑的版本 */
  let active = 'short';
  let maxLength = 8000;
  /** `getState()` 的失败重试次数（吸收"注册还没完成"这类时序抖动） */
  const LOAD_RETRIES = 4;

  function cur() {
    return perVariant[active];
  }

  /** 编辑器当前文本 */
  function currentText() {
    return el.editor.value;
  }

  /**
   * 归一化比较用文本。
   *
   * 尾随换行/前后空白不视为实质改动 —— 用户按 Ctrl+A 全选粘贴时常常会多带一个换行，
   * 若把它算成"已修改"，就会出现"明明没改，保存按钮却一直亮着"的困惑。
   */
  function normalize(text) {
    return text.replace(/\r\n/g, '\n').trim();
  }

  /** 把编辑框内容记入当前版本的草稿，并更新 dirty 标记 */
  function captureDraft() {
    const c = cur();
    const text = currentText();
    c.draft = text;
    c.dirty = normalize(text) !== normalize(c.savedText);
  }

  /** 当前版本"实际生效"的内容（自定义 or 默认） */
  function effectiveText(v) {
    const st = state ? state[v] : null;
    if (st) return st.isCustom && typeof st.customSpec === 'string' ? st.customSpec : st.defaultSpec;
    // 状态没读到时，两版均使用从权威模板生成的默认原文。
    return defaultText(v);
  }

  /** 切到某个版本：先把当前版本的草稿存下来，再载入目标版本 */
  function switchTo(variant, opts) {
    const v = variant === 'full' ? 'full' : 'short';
    const keepDraft = !(opts && opts.discardCurrentDraft);
    if (!keepDraft) {
      cur().draft = null;
    } else if (el.editor.value !== cur().savedText || perVariant[active].draft !== null) {
      // 记下当前编辑框内容，来回切不丢
      captureDraft();
    }
    active = v;
    el.tabs.forEach(function (t) {
      t.setAttribute('aria-selected', t.dataset.variant === v ? 'true' : 'false');
    });
    const c = cur();
    el.editor.value = c.draft !== null ? c.draft : c.savedText;
    paint();
  }

  function paintTabs() {
    el.tabs.forEach(function (t) {
      const st = perVariant[t.dataset.variant];
      t.classList.toggle('has-dirty', !!st.dirty);
    });
    if (state) {
      const using = state.variant === 'full' ? '完整版' : '简洁版';
      el.tabUsing.innerHTML = '底部开关当前使用：<b>' + using + '</b>';
    } else {
      el.tabUsing.textContent = '';
    }
  }

  function paint() {
    const c = cur();
    const text = currentText();
    const len = text.length;
    const over = len > maxLength;
    const st = state ? state[active] : null;

    el.count.textContent = `${len} / ${maxLength}`;
    el.count.classList.toggle('over', over);

    // 每次都重算 dirty（用户可能刚敲了一个字符）
    const dirty = normalize(text) !== normalize(c.savedText);
    c.dirty = dirty;

    if (over) {
      el.status.textContent = '超出长度上限';
      el.status.className = 'pm-status is-dirty';
    } else if (dirty) {
      el.status.textContent = '未保存';
      el.status.className = 'pm-status is-dirty';
    } else if (st && st.isCustom) {
      el.status.textContent = '使用自定义';
      el.status.className = 'pm-status is-custom';
    } else {
      el.status.textContent = '使用内置默认';
      el.status.className = 'pm-status is-default';
    }

    // 与默认不同 = 有实质差异（用它给出"你是不是只是没点保存"的清晰判断）
    const defaultSpec = st ? st.defaultSpec : c.defaultSpec;
    const differsFromDefault = defaultSpec ? normalize(text) !== normalize(defaultSpec) : false;

    if (over) {
      el.hint.textContent = `内容超出上限，保存时会被截断到 ${maxLength} 字符，请精简后再保存。`;
      el.hint.className = 'pm-hint warn';
    } else if (!text.trim()) {
      el.hint.textContent = '内容为空：点保存等于恢复默认（不会让提示词里缺掉格式要求这一段）。';
      el.hint.className = 'pm-hint warn';
    } else if (dirty) {
      el.hint.textContent = differsFromDefault
        ? `已修改：点「保存」后，底部开关拨到「${active === 'full' ? '完整' : '简洁'}」时就会用这段内容。`
        : '已恢复为默认文本：点「保存」即可切回该版本的内置默认。';
      el.hint.className = 'pm-hint';
    } else if (st && st.isCustom) {
      el.hint.textContent = '当前这一版使用自定义原文，请检查是否满足「文件 + 操作 + SEARCH／REPLACE」新协议；旧行号格式不可应用。点「恢复默认」可载入新版，保存后生效。';
      el.hint.className = 'pm-hint';
    } else {
      el.hint.textContent = '当前这一版使用内置默认。改动并保存后，只有你自己写的这段会替换它的默认。';
      el.hint.className = 'pm-hint';
    }

    el.save.disabled = over || !dirty;
    /*
     * 状态没读到（state === null，走的是兜底副本）时：
     *  - 「恢复默认」要**置灰**：它依赖 `state[v].defaultSpec`，此刻点它无异于清空编辑框；
     *  - 底部说明改口径，不让用户以为"这就是当前生效的设置"。
     * 保存仍然可点 —— 内容是我们给的默认原文，把它存下来也符合用户预期。
     */
    el.reset.disabled = !state;
    if (state) {
      const who = st && st.isCustom
        ? `自定义（${state.updatedAt ? state.updatedAt.slice(0, 19).replace('T', ' ') : '—'}）`
        : '内置默认';
      el.usage.innerHTML = `「${active === 'full' ? '完整版' : '简洁版'}」这一版生效的是：<b>${who}</b>`;
    } else {
      el.usage.innerHTML = '当前提示词里生效的是：<b>内置默认</b>（未能读到状态，显示的是内置原文）';
    }

    paintTabs();
  }

  /** 把主进程返回的 state 灌进 perVariant（保留当前正在编辑的草稿） */
  function absorbState(s) {
    state = s;
    maxLength = typeof s.maxLength === 'number' && s.maxLength > 0 ? s.maxLength : maxLength;
    (['short', 'full']).forEach(function (v) {
      const vs = s[v] || {};
      const c = perVariant[v];
      c.defaultSpec = typeof vs.defaultSpec === 'string' ? vs.defaultSpec : '';
      c.isCustom = !!vs.isCustom;
      c.savedText = effectiveTextFrom(vs, v);
      // 有草稿且草稿与新的生效值不同 → 保留草稿（用户手还没停）；否则对齐到生效值
      if (c.draft !== null && normalize(c.draft) !== normalize(c.savedText)) {
        c.dirty = true;
      } else {
        c.draft = null;
        c.dirty = false;
      }
    });
    // 编辑框同步到当前版本
    const c = cur();
    el.editor.value = c.draft !== null ? c.draft : c.savedText;
  }

  function effectiveTextFrom(vs, v) {
    if (vs && vs.isCustom && typeof vs.customSpec === 'string') return vs.customSpec;
    if (vs && typeof vs.defaultSpec === 'string' && vs.defaultSpec.length > 0) return vs.defaultSpec;
    return defaultText(v);
  }

  /**
   * 读取状态。失败重试若干次，仍失败则用**内置默认兜底**呈现。
   *
   * 为什么重试：主进程 handler 的注册时机曾经出过问题（见状态读取与构建资源约定），
   * 而面板页面加载与注册是两个异步过程 —— 少数情况下第一次调用会赶在注册之前。
   * 重试能把这种时序抖动吸收掉，而不是把用户丢在一个空白框前面。
   */
  async function load(attempt) {
    const tries = typeof attempt === 'number' ? attempt : 0;
    try {
      const s = await bridge.getState();
      if (s && typeof s === 'object') {
        absorbState(s);
        // 打开时默认停在"底部开关正在用的那一版"，用户最可能想改的就是它
        active = s.variant === 'full' ? 'full' : 'short';
        el.tabs.forEach(function (t) {
          t.setAttribute('aria-selected', t.dataset.variant === active ? 'true' : 'false');
        });
        const c = cur();
        el.editor.value = c.draft !== null ? c.draft : c.savedText;
        paint();
        return;
      }
      throw new Error('主进程返回空状态');
    } catch (err) {
      if (tries < LOAD_RETRIES) {
        window.setTimeout(function () {
          void load(tries + 1);
        }, 120 * (tries + 1));
        return;
      }
      // 兜底：**先让用户有内容可看可改**，再如实说明状态没能读到
      active = 'short';
      el.tabs.forEach(function (t) {
        t.setAttribute('aria-selected', t.dataset.variant === 'short' ? 'true' : 'false');
      });
      ['short', 'full'].forEach(function (v) {
        perVariant[v].savedText = defaultText(v);
        perVariant[v].defaultSpec = defaultText(v);
        perVariant[v].dirty = perVariant[v].draft !== null && normalize(perVariant[v].draft) !== normalize(defaultText(v));
      });
      const c = cur();
      el.editor.value = c.draft !== null ? c.draft : c.savedText;
      el.hint.textContent =
        '未能从主进程读到设置（已显示内置默认原文，可直接编辑）。若保存也失败，请重启应用后重试：' +
        (err instanceof Error ? err.message : String(err));
      el.hint.className = 'pm-hint warn';
      paint();
    }
  }

  async function save() {
    if (el.save.disabled) return;
    el.save.disabled = true;
    const v = active;
    try {
      const result = await bridge.save(v, currentText());
      if (result && result.ok) {
        absorbState(result.state);
        // 保存是"归一化"的（空内容回落默认），把编辑框同步成真正生效的内容
        const c = perVariant[v];
        c.draft = null;
        c.dirty = false;
        if (active === v) {
          el.editor.value = c.savedText;
        }
        paint();
        el.hint.textContent = result.resetToDefault
          ? `已把「${v === 'full' ? '完整版' : '简洁版'}」恢复为内置默认。`
          : `已保存（${v === 'full' ? '完整版' : '简洁版'}），底部开关拨到这一版时就会用它。`;
        el.hint.className = 'pm-hint ok';
      } else {
        el.hint.textContent = `保存失败：${(result && result.error) || '未知错误'}`;
        el.hint.className = 'pm-hint warn';
        paint();
      }
    } catch (err) {
      /*
       * 保存失败时**保留编辑框里的内容**（不刷新、不清空）——用户刚写的东西
       * 不能因为我们的一次调用失败而消失。只把错误如实说出来，并让按钮恢复可点，
       * 他可以直接再点一次重试。
       */
      el.hint.textContent = `保存失败（内容已保留在编辑框里，可直接重试）：${err instanceof Error ? err.message : String(err)}`;
      el.hint.className = 'pm-hint warn';
      el.save.disabled = false;
    }
  }

  /**
   * 「恢复默认」= 把**当前版本**的默认全文**载入编辑框**，不直接落库。
   *
   * 为什么不做成"点一下立刻清空自定义"：那是一个**不可撤销**的动作，
   * 用户辛苦写的约定会瞬间消失。载入到编辑框后仍需点「保存」才生效，
   * 于是"后悔"随时可行（切走或关掉面板即可，什么都没变）。
   */
  function resetToDefault() {
    if (!state) return;
    const st = state[active];
    const text = st && typeof st.defaultSpec === 'string' && st.defaultSpec.length > 0
      ? st.defaultSpec
      : defaultText(active);
    el.editor.value = text;
    paint();
    el.editor.focus();
    el.hint.textContent = `已载入「${active === 'full' ? '完整版' : '简洁版'}」的内置默认全文，点「保存」后生效（现在取消不会丢失你原来的内容）。`;
    el.hint.className = 'pm-hint';
  }

  async function close() {
    try {
      await bridge.close();
    } catch {
      /* 关闭失败没有可恢复的动作：面板已被主进程隐藏 */
    }
  }

  el.tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      if (t.dataset.variant === active) return;
      switchTo(t.dataset.variant);
    });
  });

  el.editor.addEventListener('input', paint);
  el.save.addEventListener('click', save);
  el.reset.addEventListener('click', resetToDefault);
  el.cancel.addEventListener('click', close);
  el.close.addEventListener('click', close);
  el.close.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      close();
    }
  });

  /*
   * 快捷键。
   *  - Esc：关闭面板（浮层类界面的通用约定）；
   *  - Ctrl+S：保存（与编辑器里 Ctrl+S 保存文件的肌肉记忆一致）。
   * 面板里没有"保存文件"这件事，把 Ctrl+S 让给"保存设置"是这一屏最自然的解释。
   */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      void save();
    }
  });

  void load();
})();
