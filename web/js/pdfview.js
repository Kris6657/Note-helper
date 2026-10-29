/* pdfview.js —— 基于 pdf.js 的连续滚动阅读器
 *
 * 89 页一次性渲染 canvas 会吃掉大量内存，所以这里用「占位 + 按需渲染」：
 * 先用每页的真实尺寸建出占位元素（高度准确，滚动条长度就是对的），
 * 再用 IntersectionObserver 在页面进入视野时才真正画 canvas，离开视野就回收。
 */

import * as pdfjsLib from '/vendor/pdfjs-6.4.299/pdf.min.mjs';
export { pdfjsLib };
export const PDF_RESOURCE_ROOT = '/vendor/pdfjs-6.4.299/';
pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_RESOURCE_ROOT + 'pdf.worker.min.mjs';

// Both the reader and diagnostics use the same display-layer loader.
// No full Viewer or PDF scripting/sandbox module is loaded.
export function createPdfDocument(url) {
  return pdfjsLib.getDocument({
    url,
    cMapUrl: PDF_RESOURCE_ROOT + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: PDF_RESOURCE_ROOT + 'standard_fonts/',
    wasmUrl: PDF_RESOURCE_ROOT + 'wasm/',
    iccUrl: PDF_RESOURCE_ROOT + 'iccs/',
    useWorkerFetch: true,
    enableXfa: false,
  });
}

/* CMap 是「字符编码 → Unicode」的映射表。PDF 用了 CID 字体（中日韩最常见）却没把字体
   本身嵌进来时，pdf.js 只能靠它判断每个字节对应哪个字——缺了就是空白或乱码。
   .bcmap 放在 web/vendor/pdfjs-6.4.299/cmaps/（跟 pdf.js 一样不入库，可从 pdfjs-dist 包重新取）。
   按需加载：只有真遇上需要 CMap 的 PDF，才会去请求对应的那一个文件，平时零开销。 */

const GAP = 12;        // 页间距，需与 style.css 里 #pdfPages 的 gap 一致
const PAD_TOP = 12;    // #pdfPages 的上内边距

/* 阅读线 —— 距滚动区顶边的固定像素，本文件里所有「位置」都是相对它算的：
   ① 跳页时把目标页的顶边放到线上（scrollToPage / scrollToPageFloat）
   ② 反过来，判定「当前是第几页」也看这条线（pageAtScroll）
   ③ 右栏同步滚动用同一个数（app.js 从这里 import）
   三者共用一个数，跳页算出来的页码就必然等于所跳的那一页。

   用固定像素而不用「视口高度的百分比」：百分比会随页高和窗口比例变化 ——
   页高一旦小于那条线的高度（把课件缩小、或窗口又高又窄），判定就会越过本页，
   表现为「跳到第 5 页、页码却显示 6，再点下一页直接跳过一页」。
   取值与 #pdfPages 的 padding-top 相同，于是第 1 页在 scrollTop = 0 时正好落在线上。 */
export const READ_LINE = 12;

export class PdfView {
  constructor(scrollEl, pagesEl) {
    this.scrollEl = scrollEl;
    this.pagesEl = pagesEl;
    this.doc = null;
    this.loadingTask = null;
    this.scale = 1.3;
    this.baseScale = 1.3;
    this.pages = [];         // [{ num, w, h, el, canvas, busy }]
    this.tops = [];          // 每页顶部相对滚动内容原点的偏移
    this.visiblePages = [];  // 当前筛选入选的页面，num 始终是课件原始页码
    this.pageFilter = null;  // null = 全部页面；Set = 入选的原始页码
    this.observer = null;
    this.onPage = null;      // (pageFloat, pageInt) => void
    this._raf = 0;
    this._loadSeq = 0;       // load() 的代次，用来作废被切模块打断的旧加载
  }

  get count() { return this.pages.length; }
  get ready() { return !!this.doc; }

  async load(url) {
    this.destroy();
    const seq = ++this._loadSeq;
    const loadingTask = createPdfDocument(url);
    this.loadingTask = loadingTask;
    try {
      const doc = await loadingTask.promise;
      if (seq !== this._loadSeq) { await loadingTask.destroy(); return; }
      this.doc = doc;

      // Publish the page placeholders together after metadata is complete.
      const pages = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const p = await doc.getPage(i);
        if (seq !== this._loadSeq) { await loadingTask.destroy(); return; }
        const vp = p.getViewport({ scale: 1 });
        pages.push({ num: i, w: vp.width, h: vp.height, el: null, canvas: null, busy: false });
      }
      this.pages = pages;
      this._build();
      this.scrollEl.scrollTop = 0;
      this._bindScroll();
      this._emit();
    } catch (error) {
      if (seq !== this._loadSeq) return; // A newer module owns the UI.
      this.loadingTask = null;
      await loadingTask.destroy().catch(() => {});
      throw error;
    }
  }

  // 按当前 scale 重建占位元素
  _build() {
    const s = this.scale;
    this.pagesEl.textContent = '';
    this.observer?.disconnect();
    const frag = document.createDocumentFragment();
    for (const p of this.pages) {
      const el = document.createElement('div');
      el.className = 'pdf-page';
      el.dataset.page = String(p.num);
      el.style.width = Math.round(p.w * s) + 'px';
      el.style.height = Math.round(p.h * s) + 'px';
      const tag = document.createElement('span');
      tag.className = 'pgno';
      tag.textContent = p.num;
      el.appendChild(tag);
      p.el = el;
      p.canvas = null;
      p.busy = false;
      frag.appendChild(el);
    }
    this.pagesEl.appendChild(frag);

    this.observer = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) this._render(e.target);
      }
    }, { root: this.scrollEl, rootMargin: '900px 0px' });
    this._layout();
    this._recycle();
  }

  // 只重新排列入选页，不重新下载 PDF；隐藏页不占高度，也不渲染 canvas。
  _layout() {
    this.observer?.disconnect();
    this.visiblePages = [];
    this.tops = new Array(this.count).fill(null);
    let y = PAD_TOP;
    for (const p of this.pages) {
      p.el.hidden = this.pageFilter !== null && !this.pageFilter.has(p.num);
      if (p.el.hidden) continue;
      this.visiblePages.push(p);
      this.tops[p.num - 1] = y;
      y += Math.round(p.h * this.scale) + GAP;
      this.observer?.observe(p.el);
    }
  }

  setVisiblePages(nums = null) {
    const keep = Math.floor(this.pageAtScroll()) || 1;
    this.pageFilter = nums === null ? null : new Set(nums);
    this._layout();
    this.scrollToPage(keep);
    this._recycle();
    this._emit();
  }

  async _render(el) {
    const num = Number(el.dataset.page);
    const p = this.pages[num - 1];
    if (!p || p.el !== el || el.hidden || p.busy || p.canvas) return;
    p.busy = true;
    try {
      const page = await this.doc.getPage(num);
      if (p.el !== el || el.hidden) return;
      const vp = page.getViewport({ scale: this.scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width * dpr);
      canvas.height = Math.round(vp.height * dpr);
      canvas.style.width = Math.round(vp.width) + 'px';
      canvas.style.height = Math.round(vp.height) + 'px';
      const ctx = canvas.getContext('2d', { alpha: false });
      await page.render({ canvas, canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
      if (this.pages[num - 1] !== p || p.el !== el || el.hidden) return;
      el.insertBefore(canvas, el.firstChild);
      p.canvas = canvas;
    } catch (err) {
      if (err && err.name !== 'RenderingCancelledException') console.warn('render page', num, err);
    } finally {
      if (p.el === el) p.busy = false;
    }
  }

  // 回收远处页面的 canvas，控制内存
  _recycle() {
    const st = this.scrollEl.scrollTop;
    const vh = this.scrollEl.clientHeight;
    const lo = st - vh * 3, hi = st + vh * 4;
    for (const p of this.pages) {
      if (!p.canvas) continue;
      const top = this.tops[p.num - 1];
      const bottom = top + Math.round(p.h * this.scale);
      if (top === null || bottom < lo || top > hi) {
        p.canvas.remove();
        p.canvas = null;
      }
    }
  }

  _bindScroll() {
    if (this._bound) return;
    this._bound = true;
    this.scrollEl.addEventListener('scroll', () => {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this._recycle();
        this._emit();
      });
    }, { passive: true });
  }

  _emit() {
    const f = this.pageAtScroll();
    // 注意用 floor 而不是 round：pageAtScroll() 的小数部分是"在这页里走了多深"，
    // 整数部分才是当前页。f=1.6 表示还在第 1 页里，用 round 会误判成第 2 页。
    const i = this.visiblePages.length ? Math.floor(f) : 0;
    if (this.onPage) this.onPage(f, i);
  }

  // 阅读线落在哪一页（返回连续值，如 12.4）
  pageAtScroll() {
    const visible = this.visiblePages;
    if (!visible.length) return 0;
    const s = this.scrollEl;
    /* 已经滚到最底：末页顶边够不到阅读线（#pdfPages 底部只留 40px），
       再按几何算就会停在倒数第二页 —— 而滚到底时看到的就是末页，直接兜住。
       先判 maxScroll > 0，是为了区分「真滚到底」和「整份文档本来就装得下、
       压根没得滚」：后者 scrollTop 恒为 0，不能因此永远报末页。 */
    const maxScroll = s.scrollHeight - s.clientHeight;
    if (maxScroll > 0 && s.scrollTop >= maxScroll - 1) return visible[visible.length - 1].num;
    const y = this.scrollEl.scrollTop + READ_LINE;
    // 浏览器可能按设备像素量化 scrollTop（例如要求 529，实际为 528.8）。
    // 判页给 1px 容差，避免跳到页顶却仍被判成前一页，导致「下一页」卡住。
    const line = y + 1;
    let lo = 0, hi = visible.length - 1;
    if (line <= this.tops[visible[0].num - 1]) return visible[0].num;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.tops[visible[mid].num - 1] <= line) lo = mid; else hi = mid - 1;
    }
    const p = visible[lo];
    const h = Math.max(1, Math.round(p.h * this.scale));
    const frac = Math.min(0.999999, Math.max(0, (y - this.tops[p.num - 1]) / h));
    return p.num + frac;
  }

  scrollToPage(n, opts = {}) {
    if (!this.visiblePages.length) return;
    const i = Math.min(this.count, Math.max(1, Math.round(n)));
    const p = this.visiblePages.find(p => p.num >= i) || this.visiblePages[this.visiblePages.length - 1];
    const top = this.tops[p.num - 1] - (opts.offset ?? READ_LINE);
    this.scrollEl.scrollTop = Math.max(0, top);
    if (opts.flash) {
      const el = p.el;
      if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    }
  }

  scrollToPageFloat(page) {
    const visible = this.visiblePages;
    if (!visible.length) return;
    const target = Math.min(this.count, Math.max(1, page));
    const i = visible.findIndex(p => p.num >= Math.floor(target));
    const p = visible[i < 0 ? visible.length - 1 : i];
    const next = visible[i + 1];
    const frac = p.num === Math.floor(target) ? target - p.num : 0;
    const topI = this.tops[p.num - 1];
    const topJ = next && i >= 0 ? this.tops[next.num - 1] : topI + Math.round(p.h * this.scale);
    const y = topI + (topJ - topI) * frac;
    this.scrollEl.scrollTop = Math.max(0, y - READ_LINE);
  }

  setScale(s) {
    const keep = this.pageAtScroll();
    this.scale = Math.min(3, Math.max(0.2, s));
    // 清掉旧 canvas，重建占位
    for (const p of this.pages) { p.canvas = null; p.busy = false; }
    this._build();
    this.scrollToPageFloat(keep);
    this._emit();
    return this.scale;
  }

  /* 适合宽度：课件基本都是 16:9，固定倍率一定横向溢出，必须按栏宽算 */
  fitWidth(availWidth) {
    if (!this.count) return this.scale;
    const w = this.pages[0].w || 960;
    this.baseScale = Math.max(0.2, (Math.max(240, availWidth) - 30) / w);
    return this.setScale(this.baseScale);
  }

  destroy() {
    this._loadSeq++;
    this.observer?.disconnect();
    this.observer = null;
    this.pagesEl.textContent = '';
    this.pages = [];
    this.tops = [];
    this.visiblePages = [];
    this.pageFilter = null;
    const loadingTask = this.loadingTask;
    this.loadingTask = null;
    this.doc = null;
    loadingTask?.destroy().catch(() => {});
  }
}
