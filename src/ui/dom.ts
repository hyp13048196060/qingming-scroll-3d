/**
 * 极小的 DOM 构造助手。
 *
 * 为什么不用 innerHTML 拼字符串
 * ----------------------------
 * 面板里的文本有一部分来自 `src/data/*.json`,其中包含中文引号、破折号、
 * 以及**用来强调的 `**` 标记**。用模板字符串拼进 innerHTML 有两个问题:
 *   1. 这些字符会被当成 HTML 解析,轻则排版错乱,重则整段被吃掉;
 *   2. 想加一点结构(比如把一个数字包成 <em>)就得改一整条拼接语句,
 *      于是没人愿意加,文案就永远是一坨纯文本。
 *
 * 用 createElement + textContent 则天然安全,且结构是显式写出来的。
 *
 * ⚠️ `text()` 一律走 `textContent`,**没有任何一处**用 innerHTML。
 *    这不是洁癖:本文件的调用方会把 json 里的字符串直接传进来,
 *    哪天 json 里出现一个 `<`,拼字符串的写法就会静默吞掉半段话。
 */

type Attrs = Record<string, string | number | boolean | undefined | null>;

/**
 * 建元素。
 * - `class` 走 className,其余属性走 setAttribute;
 * - 值为 `false` / `null` / `undefined` 的属性**不写入**(便于 `hidden: !on` 这种写法);
 * - `text` 是 textContent,不是 innerHTML。
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = String(v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** 文本节点。存在的意义是让调用处读起来一致。 */
export function text(s: string): Text {
  return document.createTextNode(s);
}

/** 清空一个节点(移除全部子节点)。 */
export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * 把 `**加粗**` 标记转成 <strong>,其余部分一律当纯文本。
 *
 * ⚠️ 这是本文件**唯一**一处处理标记的地方,而且它不解析 HTML ——
 *    它只认 `**`,并且把两段之间的内容**作为文本节点**插入。
 *    所以即便 json 里混进 `<script>`,它也只会原样显示成一串字符。
 *    (用正则替换成 innerHTML 是最容易走上的错路,那条路等于把
 *     "我们控制了数据源"当成安全依据 —— 而数据源将来会变。)
 */
export function richText(s: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const parts = s.split('**');
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    // 奇数段落在 `**` 之间 → 加粗
    if (i % 2 === 1) frag.append(el('strong', {}, [parts[i]!]));
    else frag.append(document.createTextNode(parts[i]!));
  }
  return frag;
}

/** 按钮。`class` 固定带 `qm-btn`,便于统一样式。 */
export function button(
  label: string,
  onClick: () => void,
  attrs: Attrs = {},
): HTMLButtonElement {
  const b = el('button', { type: 'button', class: 'qm-btn', ...attrs }, [label]);
  b.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}
