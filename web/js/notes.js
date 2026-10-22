/* notes.js —— 笔记渲染、块切分、页码锚点、页码标签与跨模块链接
 *
 * 笔记格式约定（见 tools/笔记生成提示词.md）：
 *   页码写成 （P7） / （P7–P15） / （P11、P14），块级 + 继承：
 *   标题带页码，其下的列表项若自己不带页码，就继承最近一次出现的页码。
 *   跨模块引用写成 [[Module 2]]。
 *
 * 页码只用于「显示 + 点击跳页」，笔记原文一个字符都不改。
 */

const SPEC_RE = /^P\s*\d+(?:\s*[–—~－-]\s*P?\s*\d+)?(?:\s*[、,，/]\s*P?\s*\d+)*/i;
const COMBINED_RE = /\[\[([^\[\]]{1,40})\]\]|[（(]([^（()）]{1,60})[)）]/g;

/* 多页标记有两种，语义完全不同，不能混为一谈：
 *   （P7–P15）   连续区间 → 中间每一页都算被引用
 *   （P11、P14） 离散列举 → 只有这两页被引用
 * 两者都是"两个数字"，光看数字分不出来，只能靠分隔符判断。
 * 分不清的后果很具体：把 11、14 当成 11–14，翻到第 12 页时
 * 「当前页」高亮会亮起来，而那一页笔记根本没提。 */
const RANGE_SEP = /[–—~－]|-/;
const LIST_SEP = /[、,，/]/;

/* 表格按「行」切，不按整张表切：一张对照表里每一行往往就是一个独立考点，
   整表共用一个颜色太粗。tr 含表头行。
   注：列表项里内嵌的表格会被外层 li 吞掉（祖先已标注的块不再单独成块），
   这是刻意的——Markdown 里 4 空格缩进的表格本来就会被当成代码块。 */
const BLOCK_SEL = 'h1,h2,h3,h4,h5,h6,p,li,pre,tr';

function numsOf(spec) {
  const out = [];
  const re = /\d+/g;
  let m;
  while ((m = re.exec(spec))) {
    const v = Number(m[0]);
    if (v >= 1 && v <= 3000) out.push(v);
  }
  return out;
}

/* 把一段纯文本切成 token：普通文字 / 页码 / 跨模块引用 */
export function scanTokens(text) {
  const tokens = [];
  let i = 0;
  let m;
  COMBINED_RE.lastIndex = 0;
  while ((m = COMBINED_RE.exec(text))) {
    if (m.index > i) tokens.push({ t: 'text', v: text.slice(i, m.index) });
    if (m[1] !== undefined) {
      tokens.push({ t: 'module', raw: m[1].trim() });
    } else {
      const inner = m[2].trim();
      const spec = SPEC_RE.exec(inner);
      if (spec) {
        const specRaw = spec[0];
        const pages = numsOf(specRaw);
        tokens.push({
          t: 'page',
          pages,
          // 两个以上页码 + 有范围符 + 没有列举符，才算连续区间。
          isRange: pages.length > 1 && RANGE_SEP.test(specRaw) && !LIST_SEP.test(specRaw),
          label: specRaw.replace(/\s+/g, ''),
          rest: inner.slice(specRaw.length),
        });
      } else {
        tokens.push({ t: 'text', v: m[0] });
      }
    }
    i = m.index + m[0].length;
  }
  if (i < text.length) tokens.push({ t: 'text', v: text.slice(i) });
  return tokens;
}

function shortTitle(text) {
  return text.replace(/[（(][^（()）]{0,60}[)）]\s*$/, '').trim().slice(0, 42);
}

/* 内容指纹（FNV-1a 32 位，转 36 进制）。
 *
 * 存在的唯一理由：批注是按「块在文档里的序号」绑定的（b0、b1…）。
 * 一旦笔记重新生成、中间插了一行，后面所有块集体后移一位，
 * 批注就会静默挂到错误的段落上——不报错、不丢数据，只是错了，最难发现。
 * 指纹只认文本内容、不认位置，所以能识别出这种错位。
 * 文本已归一化过（空白压成单空格、首尾 trim），所以换行/缩进变化不会误判。 */
function hashText(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/* 只复制阅读所需的 HTML 元素和属性。模板内容不挂进页面，事件、样式、
   内嵌文档及 SVG/MathML 不进入最终 DOM；图片只允许本机同源资源。 */
function safeMarkdown(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const allowed = new Set(('h1 h2 h3 h4 h5 h6 p ul ol li pre code blockquote table thead tbody tfoot tr th td '
    + 'strong em b i u s del a br hr span div sub sup kbd samp var abbr details summary img input').split(' '));
  const discard = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'TEMPLATE', 'SVG', 'MATH']);
  function safeURL(value, image = false) {
    try {
      const url = new URL(value, location.href);
      if (url.username || url.password) return null;
      if (image) return ['http:', 'https:'].includes(url.protocol) && url.origin === location.origin ? url.href : null;
      return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }
  const fragment = document.createDocumentFragment();
  function copy(node, parent) {
    if (node.nodeType === Node.TEXT_NODE) { parent.appendChild(document.createTextNode(node.data)); return; }
    if (node.nodeType !== Node.ELEMENT_NODE || discard.has(node.tagName)
        || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;
    const tag = node.localName;
    if (!allowed.has(tag)) { for (const child of node.childNodes) copy(child, parent); return; }
    if (tag === 'input' && node.getAttribute('type') !== 'checkbox') return;
    const el = document.createElement(tag);
    if (node.hasAttribute('title')) el.title = node.getAttribute('title');
    if (tag === 'a') {
      const href = safeURL(node.getAttribute('href') || '');
      if (href) { el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
    }
    if (tag === 'img') {
      const src = safeURL(node.getAttribute('src') || '', true);
      if (!src) { parent.appendChild(document.createTextNode(node.getAttribute('alt') || '')); return; }
      el.src = src;
      el.alt = node.getAttribute('alt') || '';
    }
    if (tag === 'code' && /^language-[\w-]+$/.test(node.className)) el.className = node.className;
    if ((tag === 'td' || tag === 'th') && /^(left|right|center)$/.test(node.getAttribute('align'))) {
      el.setAttribute('align', node.getAttribute('align'));
    }
    if (tag === 'ol' && /^\d{1,9}$/.test(node.getAttribute('start'))) el.start = Number(node.getAttribute('start'));
    if (tag === 'input') { el.type = 'checkbox'; el.disabled = true; el.checked = node.hasAttribute('checked'); }
    for (const child of node.childNodes) copy(child, el);
    parent.appendChild(el);
  }
  for (const node of template.content.childNodes) copy(node, fragment);
  return fragment;
}

/* 渲染 markdown 并切块、算页码；过滤后才生成块编号与内容指纹。 */
export function renderNotes(article, markdown) {
  window.marked.setOptions({ gfm: true, breaks: false });
  article.replaceChildren(safeMarkdown(window.marked.parse(markdown || '')));

  const all = Array.from(article.querySelectorAll(BLOCK_SEL));
  const taken = new Set();
  const blocks = [];

  for (const el of all) {
    let anc = el.parentElement;
    let skip = false;
    while (anc && anc !== article) {
      if (taken.has(anc)) { skip = true; break; }
      anc = anc.parentElement;
    }
    if (skip) continue;
    taken.add(el);

    const id = 'b' + blocks.length;
    el.dataset.block = id;
    el.classList.add('blk');

    // tr 的 textContent 会把各单元格直接连起来（没有分隔符），
    // 于是"分配正义"和"平等获取"会粘成一个词，搜索和摘要都跟着失真。
    // 按单元格拼、中间补空格。
    const raw = el.tagName === 'TR'
      ? Array.from(el.cells).map(c => c.textContent || '').join(' ')
      : (el.textContent || '');
    const text = raw.replace(/\s+/g, ' ').trim();
    const refs = scanTokens(text).filter(t => t.t === 'page');
    const firstRef = refs[0] || null;
    const level = /^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : 0;

    blocks.push({
      id, el, text, level,
      hash: hashText(text),
      refs,
      ownPages: firstRef ? firstRef.pages : null,
      ownRange: firstRef ? firstRef.isRange : false,   // true=（P7–P15）连续；false=（P11、P14）离散
      page: null,
      pageEnd: null,
      syncPage: null,
      path: '',
    });
  }

  // 一、锚点页：块内自己的标记优先，否则继承最近一次出现的页码
  // pageEnd 取 max，描述的是「这一节覆盖到第几页为止」，专供同步滚动算插值区间。
  // 它不表示「这几个页码是连续的」：显示（批注框里的 P 标签）和「当前页高亮」
  // 判定另有依据（ownRange 与 refs[].pages），别再拿 pageEnd 当区间用。
  let carry = null;
  for (const b of blocks) {
    if (b.ownPages && b.ownPages.length) {
      carry = b.ownPages[0];
      b.page = b.ownPages[0];
      b.pageEnd = Math.max(...b.ownPages);
    } else {
      b.page = carry;
      b.pageEnd = carry;
    }
  }

  // 二、给章节内的子块按页码区间等比分配，供同步滚动做插值用
  const roots = [];
  const stack = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.level > 0) {
      while (stack.length && stack[stack.length - 1].level >= b.level) stack.pop();
      const sec = {
        level: b.level,
        blockIndex: i,
        span: b.ownPages ? [b.page, b.pageEnd] : (stack.length ? stack[stack.length - 1].span : null),
        kids: [],
      };
      if (stack.length) stack[stack.length - 1].kids.push(sec); else roots.push(sec);
      stack.push(sec);
    } else {
      const top = stack[stack.length - 1];
      if (top) top.kids.push({ blockIndex: i, span: b.ownPages ? [b.page, b.pageEnd] : null });
    }
  }

  const distribute = sec => {
    const span = sec.span ? Math.max(0, sec.span[1] - sec.span[0]) : 0;
    const a = sec.span ? sec.span[0] : null;
    const n = sec.kids.length;
    sec.kids.forEach((k, idx) => {
      if (!k.span && a != null) {
        const p = (span > 0 && n > 1) ? a + Math.round(span * idx / (n - 1)) : a;
        k.span = [p, p];
      }
      if (k.level !== undefined) distribute(k);
    });
  };
  roots.forEach(distribute);

  const applySpan = node => {
    for (const k of node.kids) {
      const b = blocks[k.blockIndex];
      if (b) b.syncPage = k.span ? k.span[0] : (node.span ? node.span[0] : null);
      if (k.level !== undefined) applySpan(k);
    }
  };
  for (const sec of roots) {
    const hb = blocks[sec.blockIndex];
    if (hb) hb.syncPage = sec.span ? sec.span[0] : null;
    applySpan(sec);
  }
  let last = 1;
  for (const b of blocks) {
    if (b.syncPage == null) b.syncPage = (b.page != null ? b.page : last);
    last = b.syncPage;
  }

  // 三、章节路径，给搜索结果和批注气泡做定位提示
  const hs = [];
  for (const b of blocks) {
    if (b.level) {
      hs.length = Math.min(hs.length, b.level - 1);
      hs[b.level - 1] = shortTitle(b.text) || b.text.slice(0, 42);
    }
    b.path = hs.filter(Boolean).join(' › ');
  }

  return blocks;
}

/* 把页码标记和跨模块引用替换成可点元素（在 renderNotes 之后调用） */
export function decorate(article, { isKnownModule }) {
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) {
    const pe = n.parentElement;
    if (!pe || pe.closest('pre, code, .pagechip, .modlink')) continue;
    const v = n.nodeValue || '';
    if (v.indexOf('[[') < 0 && v.indexOf('（') < 0 && v.indexOf('(') < 0) continue;
    nodes.push(n);
  }

  for (const node of nodes) {
    const tokens = scanTokens(node.nodeValue);
    if (tokens.length === 1 && tokens[0].t === 'text') continue;
    const frag = document.createDocumentFragment();
    for (const tk of tokens) {
      if (tk.t === 'text') {
        frag.appendChild(document.createTextNode(tk.v));
      } else if (tk.t === 'page') {
        const a = document.createElement('span');
        a.className = 'pagechip';
        a.dataset.page = String(tk.pages[0]);
        // pageEnd 只在连续区间时才填末页；离散多页（P11、P14）另存一份页码表。
        // markCurrentChips 优先读 pages，读不到才退回 page~pageEnd 这个区间。
        a.dataset.pageEnd = String(tk.isRange ? tk.pages[tk.pages.length - 1] : tk.pages[0]);
        if (tk.pages.length > 1 && !tk.isRange) a.dataset.pages = tk.pages.join(',');
        a.textContent = tk.label;
        a.title = '跳到第 ' + tk.pages.join(' / ') + ' 页';
        frag.appendChild(a);
        if (tk.rest) frag.appendChild(document.createTextNode(tk.rest));
      } else {
        const a = document.createElement('span');
        const ok = isKnownModule(tk.raw);
        a.className = 'modlink' + (ok ? '' : ' missing');
        a.dataset.module = tk.raw;
        a.textContent = tk.raw;
        a.title = ok ? '打开 ' + tk.raw : '当前课程里找不到 ' + tk.raw;
        frag.appendChild(a);
      }
    }
    node.parentNode.replaceChild(frag, node);
  }
}

/* 把内部模块名（Module 2 / module2 / Module_2）归一成 "Module N" */
export function normalizeModuleName(raw) {
  const m = /module[\s_\-]*(\d+)/i.exec(raw || '');
  return m ? 'Module ' + m[1] : null;
}

/* ---------------- 掌握点的切分 ----------------
 *
 * 按 Markdown 标题层级切，不按块切。257 个块里大部分是 bullet 和表格行，
 * 拿它们当"掌握点"没意义。
 *
 * 规则：
 *   · 存储永远落在「叶子标题」（下面没有更深标题的标题）上，所以切换粒度不会丢数据。
 *   · 展示粒度可切：叶子标题 / 各级标题。粗粒度的单元 = 它管辖的全部叶子标题。
 *   · H1 通常都是分节符（下面必有下级），自然被排除；就算不是，也只在用户主动选它时才出现。
 */
export function buildMastery(blocks) {
  const n = blocks.length;

  // 1) 哪些标题是叶子
  const isLeaf = new Array(n).fill(false);
  const headIdx = [];
  for (let i = 0; i < n; i++) if (blocks[i].level > 0) headIdx.push(i);
  for (let k = 0; k < headIdx.length; k++) {
    const i = headIdx[k];
    let leaf = true;
    for (let j = k + 1; j < headIdx.length; j++) {
      if (blocks[headIdx[j]].level <= blocks[i].level) break;
      leaf = false;
      break;
    }
    isLeaf[i] = leaf;
  }

  // 2) 每个块归属到哪个叶子标题：优先最近的前一个，其次最近的后一个
  const prev = new Array(n).fill(-1);
  const next = new Array(n).fill(-1);
  let last = -1;
  for (let i = 0; i < n; i++) { if (isLeaf[i]) last = i; prev[i] = last; }
  last = -1;
  for (let i = n - 1; i >= 0; i--) { if (isLeaf[i]) last = i; next[i] = last; }

  for (let i = 0; i < n; i++) {
    const owner = prev[i] >= 0 ? prev[i] : next[i];
    blocks[i].leafOwner = owner >= 0 ? blocks[owner].id : null;
  }

  const leafUnits = [];
  for (let i = 0; i < n; i++) {
    if (!isLeaf[i]) continue;
    leafUnits.push({
      id: blocks[i].id,
      title: shortTitle(blocks[i].text) || blocks[i].text.slice(0, 30),
      level: blocks[i].level,
      leafIds: [blocks[i].id],
    });
  }

  // 3) 每一级标题各自构成一套展示单元
  const levels = [...new Set(blocks.filter(b => b.level > 0).map(b => b.level))].sort((a, b) => a - b);
  const byLevel = {};
  for (const L of levels) {
    const units = [];
    for (let i = 0; i < n; i++) {
      if (blocks[i].level !== L) continue;
      const leaves = isLeaf[i] ? [blocks[i].id] : [];
      for (let j = i + 1; j < n; j++) {
        if (blocks[j].level > 0 && blocks[j].level <= L) break;
        if (isLeaf[j]) leaves.push(blocks[j].id);
      }
      if (!leaves.length) continue;          // 底下什么都没有的标题，不算掌握点
      units.push({
        id: blocks[i].id,
        title: shortTitle(blocks[i].text) || blocks[i].text.slice(0, 30),
        level: L,
        leafIds: leaves,
      });
    }
    byLevel[L] = units;
  }

  return { leafUnits, byLevel, levels };
}
