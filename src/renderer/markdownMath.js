import { ensureSyntaxTree } from '@codemirror/language';
import katex from 'katex';

function escaped(text, offset) {
  let slashes = 0;
  while (offset > 0 && text[--offset] === '\\') slashes++;
  return slashes % 2 === 1;
}

/** Locate formulas in the original document; never serialize rendered markup back. */
export function mathRanges(state) {
  const text = state.doc.toString();
  const tree = ensureSyntaxTree(state, text.length, 75);
  // An incomplete Markdown tree cannot reliably distinguish unparsed code from prose.
  if (!tree) return [];
  const excluded = [];
  tree.iterate({ enter(node) {
    if (/^(?:FencedCode|CodeBlock|InlineCode|HTMLBlock|InlineHTML|URL|LinkTitle|Image)$/.test(node.name)) {
      excluded.push({ from: node.from, to: node.to });
      return false;
    }
  } });
  const frontmatter = /^(?:\uFEFF)?(---|\+\+\+)[ \t]*\r?\n/.exec(text);
  if (frontmatter) {
    const marker = frontmatter[1];
    let end = frontmatter[0].length;
    for (; end < text.length;) {
      const lineEnd = text.indexOf('\n', end);
      const next = lineEnd < 0 ? text.length : lineEnd + 1;
      if (text.slice(end, lineEnd < 0 ? text.length : lineEnd).trim() === marker) {
        end = next;
        break;
      }
      end = next;
    }
    excluded.push({ from: 0, to: end });
  }
  excluded.sort((a, b) => a.from - b.from);
  const ranges = [];
  let excludedIndex = 0;
  const blocked = (from, to) => {
    while (excludedIndex < excluded.length && excluded[excludedIndex].to <= from) excludedIndex++;
    return excludedIndex < excluded.length && excluded[excludedIndex].from < to;
  };
  const add = (from, to, contentFrom, contentTo, display) => {
    ranges.push({ from, to, contentFrom, contentTo, tex: text.slice(contentFrom, contentTo), display });
  };
  for (let pos = 0; pos < text.length;) {
    if (blocked(pos, pos + 1)) { pos = excluded[excludedIndex].to; continue; }
    const line = state.doc.lineAt(pos);
    // Display delimiters must occupy a complete line (possibly with same-line TeX).
    if (pos === line.from) {
      const match = /^[ \t]*(\$\$|\\\[)(.*)$/.exec(line.text);
      if (match) {
        const opening = match[1];
        const closing = opening === '$$' ? '$$' : '\\]';
        const from = line.from;
        const contentFrom = line.from + line.text.indexOf(opening) + opening.length;
        const tail = line.text.slice(contentFrom - line.from);
        const closeOffset = tail.lastIndexOf(closing);
        if (closeOffset >= 0 && !tail.slice(closeOffset + closing.length).trim()
          && !escaped(text, contentFrom + closeOffset) && !blocked(from, line.to)) {
          add(from, line.to, contentFrom, contentFrom + closeOffset, true);
          pos = line.to; continue;
        }
        if (!tail.trim()) {
          let nextLine = line.number + 1;
          let found = false;
          for (; nextLine <= state.doc.lines; nextLine++) {
            const endLine = state.doc.line(nextLine);
            if (blocked(endLine.from, endLine.to)) break;
            if (endLine.text.trim() === closing) {
              add(from, endLine.to, Math.min(line.to + 1, text.length), Math.max(line.to + 1, endLine.from - 1), true);
              pos = endLine.to; found = true; break;
            }
          }
          if (found) continue;
        }
        // An unfinished display delimiter is visible source, never an inline opener.
        pos = line.to; continue;
      }
    }
    const dollar = text[pos] === '$' && text[pos - 1] !== '$' && text[pos + 1] !== '$';
    const parenthesis = text.startsWith('\\(', pos);
    if ((!dollar && !parenthesis) || escaped(text, pos)) { pos++; continue; }
    const contentFrom = pos + (dollar ? 1 : 2);
    if (dollar && /\s/.test(text[contentFrom] || ' ')) { pos++; continue; }
    let closing = contentFrom;
    for (; closing < line.to; closing++) {
      if (blocked(closing, closing + 1)) break;
      if (escaped(text, closing)) continue;
      if (dollar ? text[closing] !== '$' : !text.startsWith('\\)', closing)) continue;
      if (dollar && (text[closing - 1] === '$' || text[closing + 1] === '$')) break;
      const tex = text.slice(contentFrom, closing);
      // Dollar notation follows non-space boundaries and must not eat currency prose.
      if (!tex || (dollar && (/\s/.test(text[closing - 1]) || /\d/.test(text[closing + 1] || '')
        || /^[，。；：、？！]+$/.test(tex)))) {
        // Do not reuse a rejected currency/space closing delimiter as a new opener.
        pos = closing + (dollar ? 1 : 2); break;
      }
      const to = closing + (dollar ? 1 : 2);
      add(pos, to, contentFrom, closing, false);
      pos = to;
      break;
    }
    if (pos < closing) pos++;
  }
  return ranges;
}

export function renderMath(tex, display) {
  const host = document.createElement(display ? 'div' : 'span');
  host.className = `markdown-math markdown-math-${display ? 'display' : 'inline'}`;
  try {
    if (tex.length > 16000) throw new Error('公式超过 16000 字符，请缩短后重试');
    katex.render(tex, host, {
      displayMode: Boolean(display), throwOnError: true, trust: false,
      maxExpand: 500, maxSize: 20, macros: Object.create(null),
      output: 'htmlAndMathml', strict: false
    });
  } catch (error) {
    host.classList.add('markdown-render-error');
    const source = document.createElement('code'); source.textContent = tex;
    const reason = document.createElement('span');
    reason.className = 'markdown-render-error-reason';
    reason.textContent = `公式无法渲染：${String(error.message || error).slice(0, 240)}`;
    host.replaceChildren(source, reason);
  }
  return host;
}
