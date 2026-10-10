/* 提示词状态与输入高度；需求提交由本地输入 owner 提供。 */
window.setupPromptComposer = function (bridge, setInfo, localPrompt) {
  const el = {
    requirement: document.getElementById('requirement'),
    custom: document.getElementById('prompt-custom'),
  };
  (function setupRequirementAutoGrow() {
    const MIN_H = 44;  // 2 行（含上下 padding，见下面 BOX_PAD 的说明）
    const MAX_H = 220; // 与 CSS 对应的基础上限，实际高度还受操作栏预算限制。

    let lastWidth = -1;   // 上一次测量时的内容宽度
    let lastActionsHeight = -1;

    // scrollHeight 已包含 padding；额外留 4px 保持输入底部的呼吸空间。
    const BOX_PAD = 4;

    function grow() {
      const ta = el.requirement;
      if (!ta || !document.getElementById('requirement-panel').open) return;
      // 归零时连 min/max 一起放开：否则 min-height 会把 scrollHeight 顶到 MIN_H 起，
      // 测出来的永远是钳制后的值而非真实内容高度。
      ta.style.height = 'auto';
      ta.style.minHeight = '0px';
      ta.style.maxHeight = 'none';
      // 保留既有自动增高范围与底部余量。
      const contentH = ta.scrollHeight + BOX_PAD;
      const reserved = document.getElementById('prompt-actions').offsetHeight + 48;
      const limit = Math.max(MIN_H, Math.min(MAX_H, Math.floor(window.innerHeight * .48) - reserved));
      const wanted = Math.min(Math.max(contentH, MIN_H), limit);
      ta.style.height = wanted + 'px';
      ta.style.minHeight = MIN_H + 'px';
      ta.style.maxHeight = limit + 'px';
      // 到上限才滚动；未到上限时用 hidden，避免出现两条无意义的滚动条痕迹
      ta.style.overflowY = contentH > limit ? 'auto' : 'hidden';
      document.dispatchEvent(new Event('prompt-size-changed'));
    }

    /** 宽度或操作栏高度变了才重算；忽略自身 height 变化，避免 RO 自激。 */
    function growIfWidthChanged() {
      const ta = el.requirement;
      if (!ta) return;
      const w = ta.clientWidth;
      const actionsHeight = document.getElementById('prompt-actions').offsetHeight;
      if (w === lastWidth && actionsHeight === lastActionsHeight) return;
      lastWidth = w;
      lastActionsHeight = actionsHeight;
      grow();
    }

    el.requirement.addEventListener('input', grow);
    document.getElementById('requirement-panel').addEventListener('toggle', grow);

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
      ro.observe(document.getElementById('prompt-actions'));
    }

    // 首次测量放到 rAF 之后：等 flex 布局定下来、字体就位，再量第一次。
    // 即便如此仍保留 RO 兜底 —— 字体加载完成等后续变化同样会校正。
    window.requestAnimationFrame(function () {
      lastWidth = el.requirement ? el.requirement.clientWidth : -1;
      grow();
    });
  })();

  let status = null;
  let revision = 0;
  function paint(next) {
    status = next;
    el.custom.hidden = !next.isCustom;
    el.custom.title = '当前使用自定义原文；强制工具协议由程序统一附带，可在提示词设置中修改';
    el.custom.setAttribute('aria-label', '使用自定义提示词');
    localPrompt.setComposerBusy(false);
  }
  async function refresh() {
    const version = ++revision;
    const next = await bridge.getPromptStatus();
    if (version === revision) paint(next);
  }
  bridge.onPromptStatus(function (next) {
    revision += 1;
    paint(next);
  });
  localPrompt.setComposerBusy(!status);
  void refresh().catch(function (err) {
    setInfo('读取提示词设置失败：' + (err && err.message ? err.message : String(err)), true);
  });
};
