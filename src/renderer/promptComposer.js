/* 输入区的唯一初始化入口；网页操作仍由用户手动完成。 */
window.setupPromptComposer = function (bridge, setInfo) {
  const el = {
    requirement: document.getElementById('requirement'),
    variantSwitch: document.getElementById('variant-switch'),
    btnCopyPrompt: document.getElementById('btn-copy-prompt'),
    custom: document.getElementById('prompt-custom'),
  };
  (function setupRequirementAutoGrow() {
    const MIN_H = 44;  // 2 行（含上下 padding，见下面 BOX_PAD 的说明）
    const MAX_H = 220; // 10 行（= CSS 的 min/max-height，两处必须一致）

    let lastWidth = -1;   // 上一次测量时的内容宽度

    // scrollHeight 已包含 padding；额外留 4px 保持输入底部的呼吸空间。
    const BOX_PAD = 4;

    function grow() {
      const ta = el.requirement;
      if (!ta) return;
      // 归零时连 min/max 一起放开：否则 min-height 会把 scrollHeight 顶到 MIN_H 起，
      // 测出来的永远是钳制后的值而非真实内容高度。
      ta.style.height = 'auto';
      ta.style.minHeight = '0px';
      ta.style.maxHeight = 'none';
      // 保留既有自动增高范围与底部余量。
      const contentH = ta.scrollHeight + BOX_PAD;
      const wanted = Math.min(Math.max(contentH, MIN_H), MAX_H);
      ta.style.height = wanted + 'px';
      ta.style.minHeight = MIN_H + 'px';
      ta.style.maxHeight = MAX_H + 'px';
      // 到上限才滚动；未到上限时用 hidden，避免出现两条无意义的滚动条痕迹
      ta.style.overflowY = contentH > MAX_H ? 'auto' : 'hidden';
    }

    /** 宽度变了才重算高度 —— RO 回调里必须走这条，否则改height 会自激成死循环 */
    function growIfWidthChanged() {
      const ta = el.requirement;
      if (!ta) return;
      const w = ta.clientWidth;
      if (w === lastWidth) return; // 宽度没变：多半是 grow() 自己触发的回调，直接跳过
      lastWidth = w;
      grow();
    }

    el.requirement.addEventListener('input', grow);

    // 粘贴 / 拖拽：input 事件在部分粘贴路径下先于 DOM 更新触发，用 rAF 再量一次
    el.requirement.addEventListener('paste', function () {
      window.requestAnimationFrame(grow);
    });
    el.requirement.addEventListener('drop', function () {
      window.requestAnimationFrame(grow);
    });

    // 缩放窗口会改变可用宽度 → 换行数变化 → 需要重算。
    // 注意这里**不再判断输入框是否为空**：空输入框在缩放后同样需要复位高度
    // （上一版漏了这个判断，导致"空输入框 + 缩放窗口"这条路走不通）。
    window.addEventListener('resize', function () {
      lastWidth = -1; // 强制下次RO/grow 重新评估
      grow();
    });

    // 核心：跟随实际宽度持续校正。RO 在首次布局完成后会立即回调一次，
    // 正好把"脚本同步执行时量错"的初始值纠正回来（用户看到的初始溢出）。
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(function () {
        window.requestAnimationFrame(growIfWidthChanged);
      });
      ro.observe(el.requirement);
    }

    // 首次测量放到 rAF 之后：等 flex 布局定下来、字体就位，再量第一次。
    // 即便如此仍保留 RO 兜底 —— 字体加载完成等后续变化同样会校正。
    window.requestAnimationFrame(function () {
      lastWidth = el.requirement ? el.requirement.clientWidth : -1;
      grow();
    });
  })();

  const sw = el.variantSwitch;
  const opts = Array.from(sw.querySelectorAll('.variant-opt'));
  let status = null;
  let switching = false;
  let copying = false;
  let feedbackTimer;
  let revision = 0;

  function updateBusy() {
    opts.forEach(function (b) { b.disabled = switching || copying; });
    sw.setAttribute('aria-busy', String(switching));
    el.btnCopyPrompt.disabled = switching || copying || !status;
  }

  function paint(next) {
    status = next;
    sw.dataset.variant = next.variant;
    sw.setAttribute('aria-checked', String(next.variant === 'full'));
    opts.forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.variant === next.variant));
    });
    el.custom.hidden = !(next.variant === 'full' ? next.fullIsCustom : next.shortIsCustom);
    el.custom.title = '当前使用自定义原文，请在提示词设置中检查是否满足明确操作的新协议；旧行号格式不可应用';
    el.custom.setAttribute('aria-label', '使用自定义提示词，请检查新协议');
    updateBusy();
  }

  async function applyVariant(variant) {
    if (switching || copying) return;
    switching = true;
    updateBusy();
    try {
      await bridge.setFormatSpecVariant(variant);
      // 读取落盘状态；切换失败时界面仍保留之前实际使用的版本。
      await refresh();
    } catch (err) {
      setInfo('切换提示词版本失败：' + (err && err.message ? err.message : String(err)), true);
    } finally {
      switching = false;
      updateBusy();
    }
  }

  opts.forEach(function (b) {
    b.addEventListener('click', function () { void applyVariant(b.dataset.variant); });
  });
  sw.addEventListener('keydown', function (e) {
    if (e.target !== sw) return; // 子按钮使用原生键盘点击，避免冒泡后二次切换。
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'Spacebar') {
      e.preventDefault();
      void applyVariant(sw.dataset.variant === 'full' ? 'short' : 'full');
    }
  });

  async function refresh() {
    const version = ++revision;
    const next = await bridge.getPromptStatus();
    if (version === revision) paint(next);
  }
  bridge.onPromptStatus(function (next) {
    revision += 1; // 广播比尚未返回的初始查询更新。
    paint(next);
  });
  updateBusy();
  void refresh().catch(function (err) {
    setInfo('读取提示词设置失败：' + (err && err.message ? err.message : String(err)), true);
    // 状态未知时复制禁用；版本按钮始终保留重试入口。
    updateBusy();
  });

  el.btnCopyPrompt.addEventListener('click', async function () {
    if (copying || switching || !status) return;
    const requirement = el.requirement.value.trim();
    if (!requirement) {
      setInfo('请先写下你的需求，再点「复制提示词」', true);
      el.requirement.focus();
      return;
    }
    window.clearTimeout(feedbackTimer);
    el.btnCopyPrompt.textContent = '复制提示词';
    copying = true;
    updateBusy();
    try {
      const result = await bridge.copyPrompt(requirement, []);
      if (!result.ok) throw new Error(result.error || '未知错误');
      setInfo('已复制完整提示词（' + result.length + ' 字符）—— 请到右侧输入框 Ctrl+V 粘贴，然后自己按发送');
      el.btnCopyPrompt.textContent = '已复制';
      feedbackTimer = window.setTimeout(function () {
        el.btnCopyPrompt.textContent = '复制提示词';
      }, 1800);
    } catch (err) {
      setInfo('复制提示词失败：' + (err && err.message ? err.message : String(err)), true);
    } finally {
      copying = false;
      updateBusy();
    }
  });
};

