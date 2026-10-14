/** 只读消息顺序见证；在隔离世界保存，不能把 DOM 重挂载当作新输出。 */
export type ReplySource = 'new' | 'history' | 'unknown';
interface ReplyNode { textContent: string | null }

export function createReplySourceTracker(initial: readonly ReplyNode[] = [], epoch = '', readText?: (node: ReplyNode) => string, readIdentity?: (node: ReplyNode) => string | undefined) {
  const known = new Set<string>();
  const remembered = new WeakSet<ReplyNode>();
  const identities = new WeakMap<ReplyNode, number>(); let nextIdentity = 0;
  const keys = { identity(node: ReplyNode): number {
    let id = identities.get(node);
    if (id === undefined) { id = ++nextIdentity; identities.set(node, id); }
    return id;
  }, fingerprint(node: ReplyNode): string {
    const text = readText ? readText(node) : String(node.textContent || '');
    let first = 2166136261, second = 5381;
    for (let i = 0; i < text.length; i++) {
      first = Math.imul(first ^ text.charCodeAt(i), 16777619);
      second = Math.imul(second, 33) ^ text.charCodeAt(i);
    }
    return [text.length, first >>> 0, second >>> 0].join(':');
  }, uniqueIdentity(node: ReplyNode, nodes: readonly ReplyNode[]): string | undefined {
    const id = readIdentity?.(node);
    return id && nodes.filter(candidate => readIdentity?.(candidate) === id).length === 1 ? id : undefined;
  }, remember(nodes: readonly ReplyNode[]): void {
    for (const node of nodes) {
      if (remembered.has(node)) continue;
      remembered.add(node);
      known.add(keys.fingerprint(node));
      // 不淘汰历史见证；到达上限后停止自动处理，避免重新开放旧消息。
      if (known.size >= 10_000) exhausted = true;
    }
  } };
  let frontier = initial.at(-1);
  let frontierKey = frontier ? keys.fingerprint(frontier) : '';
  let frontierIdentity = frontier ? keys.uniqueIdentity(frontier, initial) : undefined;
  let fresh = false;
  let sealed = false;
  let exhausted = false;
  keys.remember(initial);
  return {
    observe(nodes: readonly ReplyNode[], history = false, generatingChanged = false): void {
      const latest = nodes.at(-1);
      if (!latest) return;
      // 仅同一消息的唯一稳定 ID 与已确认正文同时匹配，才修复卸载后的顺序锚。
      // 已接纳消息仍是历史；不能凭正文相同把任意历史节点变成新尾部。
      if (frontier && !nodes.includes(frontier) && frontierIdentity) {
        const matches = nodes.filter(node => readIdentity?.(node) === frontierIdentity);
        const replacement = matches.length === 1 ? matches[0] : undefined;
        if (replacement && keys.fingerprint(replacement) === frontierKey) {
          identities.set(replacement, keys.identity(frontier));
          frontier = replacement; fresh &&= !sealed;
        }
      }
      const key = keys.fingerprint(latest);
      if (history) {
        keys.remember(nodes); frontier = latest; frontierKey = key; frontierIdentity = keys.uniqueIdentity(latest, nodes); fresh = false; sealed = true; return;
      }
      if (latest === frontier) {
        if (frontierIdentity && readIdentity?.(latest) !== frontierIdentity) {
          if (!generatingChanged) { fresh = false; sealed = true; return; }
          frontierIdentity = keys.uniqueIdentity(latest, nodes);
        }
        if (key !== frontierKey && known.has(key)) { fresh = false; frontierKey = key; return; }
        if (key !== frontierKey && sealed && !generatingChanged) { fresh = false; keys.remember([latest]); return; }
        if (generatingChanged && key !== frontierKey && !known.has(key)) { fresh = true; sealed = false; }
        if (fresh) { known.add(key); frontierKey = key; if (known.size >= 10_000) exhausted = true; }
        return;
      }
      const anchor = frontier ? nodes.indexOf(frontier) : -1;
      // 只有保留旧尾部的顺序追加，或真实生成中的正文变化，才能推进消息尾部。
      const appended = frontier ? anchor >= 0 && anchor < nodes.length - 1 : known.size === 0;
      if (!known.has(key) && (appended || generatingChanged)) {
        keys.remember(nodes); frontier = latest; frontierKey = key; frontierIdentity = keys.uniqueIdentity(latest, nodes); fresh = true; sealed = false;
      } else {
        keys.remember(nodes);
      }
    },
    source(node: ReplyNode | undefined): ReplySource {
      if (!node || exhausted) return 'unknown';
      if (node === frontier && fresh && keys.fingerprint(node) === frontierKey) return 'new';
      return known.has(keys.fingerprint(node)) ? 'history' : 'unknown';
    },
    hasObserved(node: ReplyNode): boolean { return remembered.has(node); },
    key(node: ReplyNode | undefined): string | undefined { return node ? epoch + '|' + keys.identity(node) + ':' + keys.fingerprint(node) : undefined; },
    seal(node: ReplyNode | undefined, expected?: string): void {
      if (expected !== undefined) {
        if (!frontier || !expected.startsWith(epoch + '|' + keys.identity(frontier) + ':')) return;
        node = frontier;
      }
      if (!node || node !== frontier) return;
      sealed = true;
      if (expected !== undefined && expected !== this.key(node)) { fresh = false; known.add(keys.fingerprint(node)); }
    },
  };
}
