/* app.js —— 主控：模块切换、双栏联动、批注、搜索、布局与同步滚动 */

import { PdfView, READ_LINE } from './pdfview.js';
import { renderNotes, decorate, normalizeModuleName, buildMastery } from './notes.js';

/* ---------------- DOM ---------------- */
const $ = id => document.getElementById(id);
const moduleBtn   = $('moduleBtn');
const modulePanel = $('modulePanel');
const backdrop    = $('backdrop');
const moduleLabel = $('moduleLabel');
const moduleFilter= $('moduleFilter');
const moduleList  = $('moduleList');
const modeSeg     = $('modeSeg');
const modeHint    = $('modeHint');
const themeBtn    = $('themeBtn');
const syncChk     = $('syncChk');
const layoutSeg   = $('layoutSeg');
const main        = $('main');
const pdfScroll   = $('pdfScroll');
const pdfPages    = $('pdfPages');
const notesScroll = $('notesScroll');
const notesBody   = $('notesBody');
const pageInput   = $('pageInput');
const pageTotal   = $('pageTotal');
const pageStar    = $('pageStar');
const pageFlag    = $('pageFlag');
const pageFilter  = $('pageFilter');
const pageFilterCount = $('pageFilterCount');
const pdfEmpty    = $('pdfEmpty');
const zoomFit     = $('zoomFit');
const progressText= $('progressText');
const progressFill= $('progressFill');
const masterySel  = $('masterySel');
const annoStatus  = $('annoStatus');
const searchInput = $('searchInput');
const searchResults = $('searchResults');
const pop         = $('pop');
const toastEl     = $('toast');
const splitter    = $('splitter');

const pdf = new PdfView(pdfScroll, pdfPages);

const COLORS = { yellow: '重点', blue: '疑问', red: '待查' };

const state = {
  modules: [],
  currentId: null,
  course: null,
  module: null,
  mode: 'read',
  theme: 'light',
  blocks: [],
  mastery: null,
  masteryMode: 'leaf',
  units: [],
  unitOfLeaf: {},
  anno: { version: 1, blocks: {}, meta: {}, pages: {} },
  pageFilter: 'all',
  pagesReady: false,
  reviewPage: 0,
  chips: [],
  sync: false,
  layout: 'both',
  autoFit: true,
  scrollNotes: 0,
  scrollSlides: 0,
  anchors: null,
  saveTimer: 0,
  dirty: false,
  saveRevision: 0,
  checkpoint: null,
  switching: false,
  popBlock: null,
  popUnit: null,
};

/* ---------------- 后端接口 ---------------- */
const enc = encodeURIComponent;
async function readResponse(r) {
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `请求失败（HTTP ${r.status}）`);
  return data;
}
const api = {
  modules: () => fetch('/api/modules').then(readResponse),
  notes: (c, m) => fetch(`/api/module/${enc(c)}/${enc(m)}/notes`).then(readResponse),
  anno: (c, m) => fetch(`/api/module/${enc(c)}/${enc(m)}/annotations`).then(async r => {
    const data = await readResponse(r);
    const etag = r.headers.get('ETag');
    if (!etag) throw new Error('缺少批注版本，请重启服务并刷新页面');
    return { data, etag };
  }),
  save: (c, m, payload, etag) => fetch(`/api/module/${enc(c)}/${enc(m)}/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'If-Match': etag },
    body: JSON.stringify(payload),
  }).then(async r => {
    const data = await readResponse(r);
    if (!data.ok || !r.headers.get('ETag')) throw new Error('保存未确认，请保留当前修改');
    return r.headers.get('ETag');
  }),
  pdfUrl: (c, m) => `/api/module/${enc(c)}/${enc(m)}/pdf`,
};

/* ---------------- 小工具 ---------------- */
let toastTimer = 0;
function toast(msg, ms = 1600) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
}

function note(msg, ok = true) {
  annoStatus.textContent = msg;
  annoStatus.style.color = ok ? '' : '#a32d2d';
  clearTimeout(note._t);
  annoStatus.title = msg;
  if (ok) note._t = setTimeout(() => { annoStatus.textContent = ''; }, 1800);
}

const rec = id => state.anno.blocks[id] || null;

/* 新建记录时顺手写上内容指纹。老记录（没有 h 字段）在第一次被碰到时补上，
   这样升级过来的批注也能逐步获得指纹保护。 */
function ensureRec(id) {
  const hit = state.anno.blocks[id];
  if (hit) {
    if (hit.h === undefined) {
      const b = state.blocks.find(x => x.id === id);
      if (b) hit.h = b.hash;
    }
    return hit;
  }
  const b = state.blocks.find(x => x.id === id);
  return (state.anno.blocks[id] = { color: null, note: '', mastered: false, h: b ? b.hash : undefined });
}

/* ---------------- 批注落盘 ---------------- */
function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.dirty = true;
  state.saveRevision++;
  state.saveTimer = setTimeout(flushSave, 700);
}

/* 目标课程/模块必须在 await 之前就取成局部变量。
   否则切模块时这个 await 会让出线程，等它回来 state.course 已经变了，
   而 state.anno 还是旧模块的对象——旧批注就被写进了新模块的文件。
   这不是理论风险：切换模块的那次 await 正好给了定时器插队的机会。 */
let saveQueue = Promise.resolve();
async function flushSave() {
  if (!state.course || !state.module || !state.dirty) return true;
  const course = state.course, module = state.module, anno = state.anno;
  const checkpoint = state.checkpoint;
  const revision = state.saveRevision;
  const payload = JSON.parse(JSON.stringify(anno));
  // 按顺序发送快照，避免连续标记时较旧的保存覆盖较新的标记。
  const saving = saveQueue.then(async () => {
    checkpoint.etag = await api.save(course, module, payload, checkpoint.etag);
  });
  saveQueue = saving.catch(() => {});
  try {
    await saving;
    if (anno === state.anno && revision === state.saveRevision) {
      state.dirty = false;
      note('已保存');
    }
    return true;
  } catch (e) {
    note('保存失败：' + e.message, false);
    return false;
  }
}

/* 未确认落盘时提醒用户。无确认的 beacon 可能和排队保存乱序，不能作为保存成功。 */
window.addEventListener('beforeunload', e => {
  if (!state.course || !state.module || !state.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

/* ---------------- 模块加载 ---------------- */
/* ---------------- 课程 / 模块选择器 ---------------- */

async function loadModuleList() {
  const data = await api.modules();
  state.modules = data.modules || [];
  setModuleLabel();
  renderModulePanel('');
}

function setModuleLabel() {
  const cur = state.modules.find(m => m.id === state.currentId);
  moduleLabel.textContent = cur ? cur.course + ' · ' + cur.label : '选择模块';
}

function moduleTag(m) {
  if (m.hasNotes && m.hasSlides) return '笔记 + 课件';
  if (m.hasNotes) return '仅笔记';
  if (m.hasSlides) return '仅课件';
  return '空目录';
}

function renderModulePanel(filterText) {
  const q = (filterText || '').trim().toLowerCase();
  moduleList.textContent = '';
  const courses = [...new Set(state.modules.map(m => m.course))];
  let shown = 0;
  for (const course of courses) {
    const mods = state.modules.filter(m =>
      m.course === course && (!q || (course + ' ' + m.label).toLowerCase().includes(q)));
    if (!mods.length) continue;
    const g = document.createElement('div');
    g.className = 'mp-group';
    g.textContent = course;
    moduleList.appendChild(g);
    for (const m of mods) {
      const it = document.createElement('div');
      it.className = 'mp-item' + (m.id === state.currentId ? ' on' : '');
      it.dataset.id = m.id;
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = m.label;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = moduleTag(m);
      it.append(num, tag);
      it.onclick = () => {
        if (!m.hasNotes && !m.hasSlides) { toast('这个目录里还没有 notes.md 或 slides.pdf'); return; }
        closeModulePanel();
        openModule(m.id);
      };
      moduleList.appendChild(it);
      shown++;
    }
  }
  if (!shown) {
    const d = document.createElement('div');
    d.className = 'mp-empty';
    d.textContent = state.modules.length ? '没有匹配的模块' : 'courses/ 下还没有模块';
    moduleList.appendChild(d);
  }
}

function openModulePanel() {
  closePop();          // 面板铺了全屏遮罩，底下的批注气泡该收起来
  hideSearch();
  moduleFilter.value = '';
  renderModulePanel('');
  modulePanel.hidden = false;
  backdrop.hidden = false;
  moduleFilter.focus();
}

function closeModulePanel() {
  modulePanel.hidden = true;
  backdrop.hidden = true;
}

backdrop.onclick = () => closeModulePanel();

moduleBtn.onclick = () => (modulePanel.hidden ? openModulePanel() : closeModulePanel());

moduleFilter.addEventListener('input', () => renderModulePanel(moduleFilter.value));
moduleFilter.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModulePanel(); moduleBtn.focus(); return; }
  if (e.key === 'Enter') {
    const first = moduleList.querySelector('.mp-item:not(.on)') || moduleList.querySelector('.mp-item');
    if (first) first.click();
  }
});

/* ---------------- 阅读 / 批注 模式 ---------------- */

function setMode(mode, persist = true) {
  state.mode = mode === 'annotate' ? 'annotate' : 'read';
  document.documentElement.dataset.mode = state.mode;
  modeSeg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === state.mode));
  modeHint.style.display = state.mode === 'read' ? '' : 'none';
  if (state.mode === 'annotate') modeHint.textContent = '';
  else modeHint.textContent = '阅读模式 · 切到「批注」才能标注';
  if (state.mode !== 'read') closePop();
  if (persist) { try { localStorage.setItem('nh-mode', state.mode); } catch { } }
  applyNoteTitles();
}

modeSeg.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) setMode(b.dataset.mode);
});

/* ---------------- 深色 / 浅色 ---------------- */

function setTheme(t, persist = true) {
  state.theme = t === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  themeBtn.textContent = state.theme === 'dark' ? '浅色' : '深色';
  themeBtn.title = state.theme === 'dark' ? '切到浅色' : '切到深色';
  if (persist) { try { localStorage.setItem('nh-theme', state.theme); } catch { } }
}

themeBtn.onclick = () => setTheme(state.theme === 'dark' ? 'light' : 'dark');

/* 每次切模块领一个序号。await 回来发现序号已经不是自己的，说明用户又点了别的
   模块，这次的结果直接作废——不然先发的慢请求会盖掉后发的新界面。 */
let openSeq = 0;

async function openModule(id) {
  const m = state.modules.find(x => x.id === id) || state.modules[0];
  if (!m) { toast('courses/ 下没有找到任何模块'); return; }
  const seq = ++openSeq;
  state.switching = true;
  closePop();
  state.pagesReady = false;
  refreshPageTools();  // 保存和切换期间锁住页标记，避免在旧模块离开前漏掉新操作。

  // 先撤掉待触发的自动保存，再用旧模块的身份落一次盘。
  // 少了这一步，那个 700ms 的定时器会在切换之后醒来，
  // 拿着新模块的 course/module 去写旧模块的批注。
  clearTimeout(state.saveTimer);
  if (!(await flushSave())) {
    if (seq === openSeq) { state.switching = false; state.pagesReady = pdf.ready; refreshPageTools(); }
    toast('保存失败，已保留当前模块，请重试保存');
    return;
  }
  if (seq !== openSeq) return;

  // 先把新模块的内容全部取回来，**成功之后再动 state**。
  // 顺序在这里是关键：只要提前把 state.course 改成新模块，下面任何一个 await
  // 都会留下一个「course 已经是新的、anno 还是旧的」的窗口。此时若有谁调用
  // flushSave（另一次 openModule 的开头正好就会调），旧模块的批注就被 POST 到
  // 新模块的文件里。这不是理论风险——本地服务往返只要几毫秒，连点两次模块
  // 就能稳定撞上，而且写进去的是别人模块的数据，事后极难追。
  let notes, anno;
  try {
    [notes, anno] = await Promise.all([api.notes(m.course, m.module), api.anno(m.course, m.module)]);
  } catch (e) {
    if (seq === openSeq) {
      state.switching = false;
      state.pagesReady = pdf.ready;
      refreshPageTools();
      note('模块载入失败：' + e.message, false);
      toast('模块载入失败：' + e.message, 6500);
    }
    return;
  }
  if (seq !== openSeq) return;
  const checkpoint = { etag: anno.etag };
  anno = anno.data;

  // 到这里所有网络往返都结束了，一次性把身份和数据一起切过去，
  // 中间不存在任何「半新半旧」的时刻。
  state.course = m.course;
  state.module = m.module;
  state.currentId = m.id;
  state.checkpoint = checkpoint;
  state.switching = false;
  state.anno = {
    ...anno,
    version: anno.version || 1,
    blocks: anno.blocks || {},
    meta: anno.meta || {},
    pages: anno.pages && typeof anno.pages === 'object' && !Array.isArray(anno.pages) ? anno.pages : {},
  };
  state.pagesReady = false;
  state.pageFilter = 'all';
  state.reviewPage = 0;
  pageFilter.value = 'all';
  state.dirty = false;     // 刚从磁盘读来，与磁盘一致；后面 reconcileAnno 若有改动会再置脏
  note('');
  setModuleLabel();
  try { localStorage.setItem('nh-last', m.id); } catch { }

  closePop();
  hideSearch();
  closeModulePanel();

  // 渲染笔记
  notesBody.classList.toggle('annotatable', !!notes.markdown);
  state.blocks = renderNotes(notesBody, notes.markdown || '');
  if (!notes.markdown) {
    notesBody.innerHTML = '<p class="dim" style="padding:40px 0;text-align:center">这个模块还没有 notes.md。把按约定生成的笔记放进模块目录即可。</p>';
  }
  decorate(notesBody, { isKnownModule });
  state.chips = Array.from(notesBody.querySelectorAll('.pagechip'));
  state.anchors = null;

  reconcileAnno();         // 笔记若被重新生成过，按指纹把批注搬回正确的块
  setupMastery();          // 内部会顺带重绘批注态与进度
  setMode(state.mode, false);

  // 载入 PDF
  pdf.destroy();
  refreshPageTools();
  if (m.hasSlides) {
    pageTotal.textContent = '/ …';
    try {
      await pdf.load(api.pdfUrl(m.course, m.module));
      if (seq !== openSeq) return;
      state.pagesReady = true;
      pageTotal.textContent = '/ ' + pdf.count;
      pageInput.max = String(pdf.count);
      pageInput.value = '1';
      applyFit();
      applyPageFilter();
    } catch (e) {
      if (seq !== openSeq) return;
      pageTotal.textContent = '/ 载入失败';
      console.error(e);
      pdf.destroy();
    }
  } else {
    pageTotal.textContent = '/ 无课件';
  }

  notesScroll.scrollTop = 0;
  markCurrentChips(1);
  refreshPageTools();
}

/* 笔记重新生成后，「块的序号」会整体错位——批注按序号绑定，于是集体挂到错误的
   段落上：不报错、不丢数据，只是错了，属最难发现的一类。
   这里用内容指纹把它纠正回来。

   三条原则：
     1. 位置没动的不碰。
     2. 指纹在全文里唯一匹配、且目标块没人占 → 搬过去。
     3. 匹配不上、或有多处同文（分不清是哪一处）→ 不猜。从活跃批注里摘出来
        存进 meta.orphans：不静默删除，也不容许它挂在错误的块上。
        （留在 blocks 里是有害的——那个 id 现在指向别的段落，颜色会画错地方。） */
function reconcileAnno() {
  const byId = new Map(state.blocks.map(b => [b.id, b]));
  const byHash = new Map();
  for (const b of state.blocks) {
    const list = byHash.get(b.hash);
    if (list) list.push(b); else byHash.set(b.hash, [b]);
  }

  const settled = new Set();     // 已经明确归属的块 id
  const pending = [];
  for (const [id, r] of Object.entries(state.anno.blocks)) {
    const here = byId.get(id);
    if (!r.h || (here && here.hash === r.h)) { settled.add(id); continue; }
    pending.push([id, r]);
  }

  const moves = [];
  const orphans = [];
  for (const [id, r] of pending) {
    const cands = byHash.get(r.h) || [];
    if (cands.length !== 1 || settled.has(cands[0].id)) { orphans.push([id, r]); continue; }
    settled.add(cands[0].id);
    moves.push([id, cands[0].id, r]);
  }

  if (!moves.length && !orphans.length) return;

  for (const [oldId, newId, r] of moves) {
    delete state.anno.blocks[oldId];
    state.anno.blocks[newId] = r;
  }
  for (const [oldId, r] of orphans) {
    delete state.anno.blocks[oldId];
    (state.anno.meta.orphans ||= []).push({ from: oldId, ...r });
  }

  const bits = [];
  if (moves.length) bits.push(`已按内容归位 ${moves.length} 条`);
  if (orphans.length) bits.push(`${orphans.length} 条对不上（已留档，没删）`);
  toast('笔记与上次不一致：' + bits.join('，'), 4200);
  scheduleSave();
}

function isKnownModule(raw) {
  const norm = normalizeModuleName(raw);
  if (!norm) return false;
  return state.modules.some(x => x.course === state.course && x.label.toLowerCase() === norm.toLowerCase());
}

/* ---------------- 批注渲染 ---------------- */
function paintBlock(b) {
  const r = rec(b.id);
  b.el.classList.toggle('anno-yellow', r?.color === 'yellow');
  b.el.classList.toggle('anno-blue', r?.color === 'blue');
  b.el.classList.toggle('anno-red', r?.color === 'red');
  b.el.classList.toggle('has-note', !!(r && r.note && r.note.trim()));
  b.el.classList.toggle('mastered', !!(r && r.mastered));
}

/* 阅读模式下把评论挂成原生 tooltip：鼠标停一下就能看到，不用点开批注框 */
function applyNoteTitles() {
  for (const b of state.blocks) {
    const r = rec(b.id);
    const n = (state.mode === 'read' && r && r.note) ? r.note.trim() : '';
    if (n) b.el.title = n; else b.el.removeAttribute('title');
  }
}

function applyAnnotationsToDom() {
  for (const b of state.blocks) paintBlock(b);
  applyNoteTitles();
}

function refreshBlock(b) {
  paintBlock(b);
}

/* ---------------- 掌握点：按 Markdown 标题层级切 ----------------
 * 存储永远落在「叶子标题」上，展示粒度可切，所以换粒度不会丢勾选。
 */

function isMastered(leafId) { return rec(leafId)?.mastered === true; }
const unitMastered = u => u.leafIds.length > 0 && u.leafIds.every(isMastered);

function setupMastery() {
  state.mastery = buildMastery(state.blocks);
  const m = state.mastery;

  masterySel.textContent = '';
  const add = (value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    masterySel.appendChild(o);
  };
  add('leaf', `最细（${m.leafUnits.length}）`);
  // 一级标题按约定"不管"（通常是分节符），除非这份笔记只有 H1
  const withUnits = m.levels.filter(L => (m.byLevel[L] || []).length);
  const shown = withUnits.filter(L => L > 1);
  const valid = new Set(['leaf']);
  for (const L of (shown.length ? shown : withUnits)) {
    add(String(L), `${L} 级标题（${m.byLevel[L].length}）`);
    valid.add(String(L));
  }

  let saved = null;
  try { saved = localStorage.getItem('nh-mastery'); } catch { }
  if (saved && valid.has(saved)) state.masteryMode = saved;
  else if (!m.leafUnits.length && shown.length) state.masteryMode = String(shown[shown.length - 1]);
  else state.masteryMode = 'leaf';
  masterySel.value = state.masteryMode;

  applyMasteryMode();
}

function applyMasteryMode() {
  const m = state.mastery;
  if (!m) { state.units = []; state.unitOfLeaf = {}; updateProgress(); return; }

  state.units = (state.masteryMode !== 'leaf' && (m.byLevel[Number(state.masteryMode)] || []).length)
    ? m.byLevel[Number(state.masteryMode)]
    : m.leafUnits;

  state.unitOfLeaf = {};
  state.units.forEach((u, idx) => u.leafIds.forEach(id => { state.unitOfLeaf[id] = idx; }));

  applyAnnotationsToDom();
  updateProgress();
}

function updateProgress() {
  const units = state.units;
  const total = units.length;
  let done = 0, partial = 0;
  for (const u of units) {
    const n = u.leafIds.filter(isMastered).length;
    if (!n) continue;
    if (n === u.leafIds.length) done++; else partial++;
  }
  progressText.textContent = `已掌握 ${done} / ${total}` + (partial ? `（${partial} 节进行中）` : '');
  progressFill.style.width = total ? (done * 100 / total).toFixed(1) + '%' : '0';
  progressText.title = total
    ? `掌握点按 Markdown 标题层级切分，当前：${masterySel.options[masterySel.selectedIndex]?.textContent || ''}\n`
      + '切到更粗的粒度时，一个知识点要其下全部细条目都打钩才算已掌握。'
    : '这份笔记里没有可用的标题层级';
}

function setUnit(u, on) {
  for (const id of u.leafIds) {
    const r = ensureRec(id);
    r.mastered = on;
    // 清掉没有任何内容的空记录，别在 json 里堆垃圾
    if (!on && !r.color && !(r.note || '').trim()) delete state.anno.blocks[id];
  }
  scheduleSave();
}

function unitForBlock(b) {
  if (!b || !b.leafOwner) return null;
  const idx = state.unitOfLeaf[b.leafOwner];
  return idx === undefined ? null : state.units[idx];
}

masterySel.addEventListener('change', () => {
  state.masteryMode = masterySel.value;
  try { localStorage.setItem('nh-mastery', state.masteryMode); } catch { }
  applyMasteryMode();
  toast('掌握点：' + (masterySel.options[masterySel.selectedIndex]?.textContent || ''));
});

/* ---------------- 批注气泡 ---------------- */
let popBuilt = false;
function buildPop() {
  pop.innerHTML = '';
  const path = document.createElement('div'); path.className = 'pop-path'; path.id = 'popPath';
  const row1 = document.createElement('div'); row1.className = 'pop-row';
  for (const c of ['yellow', 'blue', 'red']) {
    const b = document.createElement('button');
    b.className = 'swatch'; b.dataset.color = c; b.title = COLORS[c];
    b.onclick = () => setColor(c);
    row1.appendChild(b);
  }
  const clearBtn = document.createElement('button');
  clearBtn.className = 'mini'; clearBtn.textContent = '清除颜色';
  clearBtn.onclick = () => setColor(null);
  row1.appendChild(clearBtn);

  const grow = document.createElement('span'); grow.className = 'grow';
  row1.appendChild(grow);

  const mBtn = document.createElement('button');
  mBtn.className = 'mini'; mBtn.id = 'popMastered'; mBtn.textContent = '已掌握';
  mBtn.onclick = () => toggleMastered();
  row1.appendChild(mBtn);

  const ta = document.createElement('textarea');
  ta.id = 'popNote'; ta.placeholder = '写点想法、疑问、补充…';
  ta.oninput = () => { const r = ensureRec(state.popBlock.id); r.note = ta.value; refreshBlock(state.popBlock); scheduleSave(); };
  ta.onkeydown = e => { if (e.key === 'Escape') closePop(); };

  const foot = document.createElement('div'); foot.className = 'pop-foot';
  const pg = document.createElement('span'); pg.className = 'pop-page'; pg.id = 'popPage';
  const jump = document.createElement('button'); jump.className = 'mini'; jump.id = 'popJump'; jump.textContent = '跳到此页';
  jump.onclick = () => { const b = state.popBlock; if (b && b.page != null) gotoPage(b.page, true); };
  const cp = document.createElement('button'); cp.className = 'mini'; cp.textContent = '复制原文';
  cp.onclick = () => { navigator.clipboard.writeText(state.popBlock.text).then(() => toast('已复制'), () => toast('复制失败')); };
  const sp = document.createElement('span'); sp.className = 'grow';
  foot.append(pg, sp, jump, cp);

  pop.append(path, row1, ta, foot);
  popBuilt = true;
}

function openPop(block) {
  if (!popBuilt) buildPop();
  state.popBlock = block;
  state.popUnit = unitForBlock(block);
  const r = rec(block.id) || { color: null, note: '', mastered: false };

  const u = state.popUnit;
  $('popPath').textContent = (block.path || '(文档开头)')
    + (u && u.leafIds.length > 1 ? '　·　知识点：' + u.title : '');
  pop.querySelectorAll('.swatch').forEach(s => s.classList.toggle('on', s.dataset.color === r.color));
  paintMasteredButton();
  $('popNote').value = r.note || '';
  // 直接显示笔记里写的那个页码标记本身（P11、P14 就照原样显示）。
  // 不要用 page ~ pageEnd 重新拼：pageEnd 是插值上界，
  // 用它拼会把「第 11、14 页」这种离散列举显示成「第 11–14 页」这一段连续区间。
  const own = block.refs && block.refs[0];
  $('popPage').textContent = own
    ? own.label
    : (block.page != null ? 'P' + block.page + '（继承）' : '未标页码');
  $('popJump').disabled = block.page == null;

  pop.hidden = false;
  positionPop(block);
  state.blocks.forEach(b => b.el.classList.toggle('active', b === block));
}

function positionPop(block) {
  if (!block || pop.hidden) return;
  const rect = block.el.getBoundingClientRect();
  const w = pop.offsetWidth || 320, h = pop.offsetHeight || 190;
  let left = Math.min(rect.left + 24, window.innerWidth - w - 12);
  let top = rect.top + 6;
  if (top + h > window.innerHeight - 10) top = Math.max(10, window.innerHeight - h - 10);
  if (top < 10) top = 10;
  pop.style.left = Math.max(10, left) + 'px';
  pop.style.top = top + 'px';
}

function closePop() {
  pop.hidden = true;
  state.popBlock = null;
  state.blocks.forEach(b => b.el.classList.remove('active'));
}

function setColor(c) {
  if (!state.popBlock) return;
  const r = ensureRec(state.popBlock.id);
  r.color = c;
  refreshBlock(state.popBlock);
  pop.querySelectorAll('.swatch').forEach(s => s.classList.toggle('on', s.dataset.color === c));
  scheduleSave();
}

/* 按钮反映的是"所属知识点"的状态，不是被点的那一块。
   点一个段落，等于给这一节打钩。 */
function paintMasteredButton() {
  const mb = $('popMastered');
  if (!mb) return;
  const u = state.popUnit;
  if (!u) {
    mb.disabled = true;
    mb.classList.remove('on');
    mb.textContent = '无可归属的知识点';
    mb.title = '这一块不在任何标题底下';
    return;
  }
  const on = unitMastered(u);
  mb.disabled = false;
  mb.classList.toggle('on', on);
  mb.textContent = on ? '已掌握 ✓' : '已掌握';
  mb.title = '「' + u.title + '」' + (u.leafIds.length > 1 ? '（含 ' + u.leafIds.length + ' 个最细条目）' : '');
}

function toggleMastered() {
  const u = state.popUnit;
  if (!u) return;
  setUnit(u, !unitMastered(u));
  paintMasteredButton();
  applyAnnotationsToDom();
  updateProgress();
}

/* ---------------- 笔记栏交互（事件委托） ---------------- */
notesBody.addEventListener('click', e => {
  if (state.switching) return;
  const chip = e.target.closest('.pagechip');
  if (chip) { gotoPage(Number(chip.dataset.page), true); return; }

  const ml = e.target.closest('.modlink');
  if (ml) {
    const norm = normalizeModuleName(ml.dataset.module);
    const target = state.modules.find(x => x.course === state.course && x.label.toLowerCase() === (norm || '').toLowerCase());
    if (target) { openModule(target.id); toast('已切到 ' + target.label); }
    else toast('当前课程里找不到 ' + ml.dataset.module);
    return;
  }

  if (e.target.closest('a')) return;
  if (window.getSelection && String(window.getSelection()).trim()) return;

  // 阅读模式：点笔记不做任何事，避免打断阅读
  if (state.mode !== 'annotate') return;

  const blk = e.target.closest('.blk');
  if (!blk) return;
  const b = state.blocks.find(x => x.el === blk);
  if (!b) return;
  if (state.popBlock === b) closePop(); else openPop(b);
});

/* ---------------- 页码跳转与「你在这里」 ---------------- */
function gotoPage(n, flash) {
  if (!state.pagesReady || !pdf.ready || !Number.isFinite(n) || !n) return;
  const i = Math.min(pdf.count, Math.max(1, Math.round(n)));
  if (state.pageFilter !== 'all' && !pdf.visiblePages.some(p => p.num === i)) {
    state.pageFilter = 'all';
    pageFilter.value = 'all';
    applyPageFilter();
    toast('第 ' + i + ' 页未入选，已切回全部页面');
  }
  pdf.scrollToPage(i, { flash: !!flash });
  pageInput.value = String(i);   // 显式回写，免得输入框聚焦时 onPage 的守卫把它跳过
  markCurrentChips(i);
  pdf._emit();
}

function markCurrentChips(page) {
  if (!state.chips.length) return;
  for (const c of state.chips) {
    let hit;
    if (c.dataset.pages) {
      // 离散列举（P11、P14）：只在这几页上亮。中间那些页没被引用，不该跟着亮。
      hit = c.dataset.pages.split(',').some(n => Number(n) === page);
    } else {
      const a = Number(c.dataset.page), b = Number(c.dataset.pageEnd || c.dataset.page);
      hit = page >= a && page <= b;
    }
    c.classList.toggle('here', hit);
  }
}

pdf.onPage = (f, i) => {
  if (!state.pagesReady) return;
  if (document.activeElement !== pageInput) pageInput.value = String(i);
  markCurrentChips(i);
  refreshPageTools(i);
  if (state.pageFilter !== 'all' && i && state.reviewPage !== i) {
    notesScroll.scrollTop = Math.max(0, topForPage(i) - READ_LINE);
  }
  state.reviewPage = i;
};

/* ---------------- 课件页：个人星标 / 课程重点旗帜 ---------------- */
function pageMatches(num, filter = state.pageFilter) {
  const mark = state.anno.pages[num];
  if (filter === 'star') return mark?.star === true;
  if (filter === 'flag') return mark?.flag === true;
  if (filter === 'marked') return mark?.star === true || mark?.flag === true;
  return true;
}

function refreshPageTools(page = currentPage()) {
  const ready = state.pagesReady && pdf.count > 0;
  const visible = ready ? pdf.visiblePages : [];
  const index = visible.findIndex(p => p.num === page);
  const mark = ready && index >= 0 ? state.anno.pages[page] : null;
  pageStar.disabled = pageFlag.disabled = !ready || index < 0;
  pageStar.setAttribute('aria-pressed', String(mark?.star === true));
  pageFlag.setAttribute('aria-pressed', String(mark?.flag === true));
  pageStar.textContent = mark?.star === true ? '★ 星标' : '☆ 星标';
  pageFilter.disabled = !ready;
  pageInput.disabled = !ready || !visible.length;
  if (!visible.length) pageInput.value = '';
  $('pagePrev').disabled = index <= 0;
  $('pageNext').disabled = index < 0 || index >= visible.length - 1;
  const labels = { all: '全部页面', star: '星标页', flag: '旗帜页', marked: '全部已标记页' };
  for (const option of pageFilter.options) {
    const count = ready ? pdf.pages.filter(p => pageMatches(p.num, option.value)).length : 0;
    option.textContent = labels[option.value] + '（' + count + '）';
  }
  pageFilterCount.textContent = ready && state.pageFilter !== 'all'
    ? (index >= 0 ? `第 ${index + 1} / ${visible.length} 个结果` : '0 个结果') : '';
  pdfEmpty.hidden = !ready || state.pageFilter === 'all' || visible.length > 0;
  for (const p of pdf.pages) {
    const r = state.anno.pages[p.num];
    p.el.querySelector('.pgno').textContent =
      (r?.star === true ? '★ ' : '') + (r?.flag === true ? '⚑ ' : '') + p.num;
  }
}

function applyPageFilter() {
  if (!state.pagesReady) return;
  state.reviewPage = 0;
  const nums = state.pageFilter === 'all' ? null : pdf.pages.filter(p => pageMatches(p.num)).map(p => p.num);
  pdf.setVisiblePages(nums);
  refreshPageTools();
}

function togglePageMark(kind) {
  if (!state.pagesReady || !pdf.visiblePages.length) return;
  const page = currentPage();
  const mark = state.anno.pages[page] || {};
  state.anno.pages[page] = { ...mark, [kind]: mark[kind] !== true };
  scheduleSave();
  if (state.pageFilter === 'all') refreshPageTools(page);
  else applyPageFilter();
}

pageStar.onclick = () => togglePageMark('star');
pageFlag.onclick = () => togglePageMark('flag');
pageFilter.addEventListener('change', () => {
  state.pageFilter = pageFilter.value;
  applyPageFilter();
});

/* ---------------- 同步滚动（按页码锚点插值，不按滚动比例） ---------------- */
let syncing = false;

/* 两侧都必须用 PDF 侧那条阅读线（READ_LINE），不能各算各的：
   左右两栏的"当前位置"是同一个数，用同一个偏移量才谈得上对齐。
   这里刻意不用「视口高度的百分比」—— 两栏高度不同，百分比会把对齐线撕成两条。 */

function notesAnchors() {
  if (state.anchors) return state.anchors;
  const st = notesScroll.scrollTop;
  const base = notesScroll.getBoundingClientRect().top;
  const out = [];
  for (const b of state.blocks) {
    const page = b.syncPage;
    if (page == null) continue;
    const top = b.el.getBoundingClientRect().top - base + st;
    if (!out.length || out[out.length - 1].page !== page) out.push({ top, page });
    else out[out.length - 1].top = Math.min(out[out.length - 1].top, top);
  }
  state.anchors = out;
  return out;
}

function topForPage(page) {
  const A = notesAnchors();
  if (!A.length) return 0;
  if (page <= A[0].page) return A[0].top;
  for (let i = A.length - 1; i >= 0; i--) {
    if (A[i].page <= page) {
      const a = A[i], b = A[i + 1];
      if (!b) return a.top;
      const f = (page - a.page) / Math.max(1e-6, b.page - a.page);
      return a.top + (b.top - a.top) * Math.min(1, Math.max(0, f));
    }
  }
  return 0;
}

function pageForTop(top) {
  const A = notesAnchors();
  if (!A.length) return 1;
  if (top <= A[0].top) return A[0].page;
  for (let i = A.length - 1; i >= 0; i--) {
    if (A[i].top <= top) {
      const a = A[i], b = A[i + 1];
      if (!b) return a.page;
      const f = (top - a.top) / Math.max(1, b.top - a.top);
      return a.page + (b.page - a.page) * Math.min(1, Math.max(0, f));
    }
  }
  return A[0].page;
}

function follow(from) {
  // 筛选复习时由入选课件页带动笔记；笔记自由滚动不会把课件带到未入选页。
  if (state.pageFilter !== 'all' || !state.sync || syncing || !state.pagesReady || !pdf.ready) return;
  syncing = true;
  if (from === 'slides') {
    const p = pdf.pageAtScroll();
    notesScroll.scrollTop = Math.max(0, topForPage(p) - READ_LINE);
  } else {
    const p = pageForTop(notesScroll.scrollTop + READ_LINE);
    pdf.scrollToPageFloat(p);
  }
  requestAnimationFrame(() => requestAnimationFrame(() => { syncing = false; }));
}

pdfScroll.addEventListener('scroll', () => follow('slides'), { passive: true });
notesScroll.addEventListener('scroll', () => {
  if (state.popBlock) positionPop(state.popBlock);
  follow('notes');
}, { passive: true });

syncChk.addEventListener('change', () => {
  state.sync = syncChk.checked;
  toast(state.sync ? '同步滚动已开（按页码锚点）' : '同步滚动已关');
  if (state.sync) follow('slides');
});

/* ---------------- 布局 ---------------- */
function setLayout(l, silent) {
  if (!silent && l === state.layout) return;
  closePop();   // 布局一变，气泡锚定的那个块可能已被移出视野，留着它只会挂在半空
  state.scrollNotes = notesScroll.scrollTop;
  state.scrollSlides = pdfScroll.scrollTop;
  state.layout = l;
  main.dataset.layout = l;
  layoutSeg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.layout === l));
  requestAnimationFrame(() => {
    if (l !== 'slides') notesScroll.scrollTop = state.scrollNotes;
    if (l !== 'notes') pdfScroll.scrollTop = state.scrollSlides;
    state.anchors = null;
    if (state.autoFit) setTimeout(applyFit, 0);
  });
}

layoutSeg.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) setLayout(b.dataset.layout);
});

/* 拖动分栏 */
(function bindSplitter() {
  let dragging = false;
  splitter.addEventListener('mousedown', e => {
    if (state.layout !== 'both') return;
    dragging = true;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rect = main.getBoundingClientRect();
    const pct = Math.min(78, Math.max(22, ((e.clientX - rect.left) / rect.width) * 100));
    main.style.setProperty('--colL', pct.toFixed(2) + '%');
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    state.anchors = null;
    if (state.autoFit) applyFit();
  });
})();

/* ---------------- 搜索 ---------------- */
function hideSearch() { searchResults.hidden = true; searchResults.textContent = ''; }

function runSearch(q) {
  const needle = q.trim().toLowerCase();
  if (needle.length < 1) { hideSearch(); return; }
  const hits = state.blocks
    .filter(b => b.text.toLowerCase().includes(needle))
    .slice(0, 80);

  searchResults.textContent = '';
  if (!hits.length) {
    const d = document.createElement('div');
    d.className = 'sr-empty';
    d.textContent = '没有匹配的块';
    searchResults.appendChild(d);
    searchResults.hidden = false;
    return;
  }
  for (const b of hits) {
    const item = document.createElement('div');
    item.className = 'sr-item';
    const p = document.createElement('div'); p.className = 'sr-path';
    p.textContent = (b.page != null ? 'P' + b.page + ' · ' : '') + (b.path || '(文档开头)');
    const s = document.createElement('div'); s.className = 'sr-snip';
    const i = b.text.toLowerCase().indexOf(needle);
    const from = Math.max(0, i - 30);
    const snip = (from > 0 ? '…' : '') + b.text.slice(from, from + 110);
    const idx = snip.toLowerCase().indexOf(needle);
    if (idx >= 0) {
      s.append(document.createTextNode(snip.slice(0, idx)));
      const mk = document.createElement('mark');
      mk.textContent = snip.slice(idx, idx + needle.length);
      s.append(mk, document.createTextNode(snip.slice(idx + needle.length)));
    } else {
      s.textContent = snip;
    }
    item.append(p, s);
    item.onclick = () => {
      b.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      b.el.classList.add('search-hit');
      setTimeout(() => b.el.classList.remove('search-hit'), 1800);
      if (b.page != null) markCurrentChips(b.page);
      hideSearch();
    };
    searchResults.appendChild(item);
  }
  searchResults.hidden = false;
}

searchInput.addEventListener('input', () => runSearch(searchInput.value));
searchInput.addEventListener('focus', () => { if (searchInput.value.trim()) runSearch(searchInput.value); });
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { searchInput.value = ''; hideSearch(); searchInput.blur(); }
  if (e.key === 'Enter') {
    const first = searchResults.querySelector('.sr-item');
    if (first) first.click();
  }
});

/* ---------------- PDF 工具栏 ---------------- */
/* 翻页：水平方向。之前只有一个"上一页"，而且数字框自带的上/下小箭头
   是"上=页码+1、下=页码−1"，跟"往下读=往后翻"正好相反，容易点错。
   这里统一成：上/左 = 上一页，下/右 = 下一页。 */
function currentPage() {
  // 与 pdfview 的 _emit 保持一致：整数部分才是当前页
  if (!state.pagesReady || !pdf.visiblePages.length) return 0;
  return Math.min(pdf.count, Math.max(1, Math.floor(pdf.pageAtScroll()) || 1));
}

function stepPage(delta) {
  if (!state.pagesReady) return;
  const index = pdf.visiblePages.findIndex(p => p.num === currentPage());
  const target = pdf.visiblePages[index + delta];
  if (target) gotoPage(target.num, true);
}

$('pagePrev').onclick = () => stepPage(-1);
$('pageNext').onclick = () => stepPage(1);
pageInput.addEventListener('change', () => {
  const n = Number(pageInput.value);
  if (n >= 1) gotoPage(n, true);
});
/* 数字框里按 ↑/↓ 也跟着统一成"上=上一页、下=下一页"，
   不再沿用 number 输入框原生的"上=数字加一"（那个方向跟阅读方向相反） */
function stepFromInput(delta) {
  if (state.pageFilter !== 'all') { stepPage(delta); return; }
  const cur = Number(pageInput.value);
  const base = (Number.isFinite(cur) && cur >= 1) ? Math.round(cur) : currentPage();
  gotoPage(base + delta, true);   // gotoPage 会把新页码写回输入框
}

pageInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowUp') { e.preventDefault(); stepFromInput(-1); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); stepFromInput(1); return; }
  if (e.key === 'Enter') pageInput.blur();
});
$('zoomIn').onclick = () => { pdf.setScale(pdf.scale + 0.12); state.autoFit = false; updateZoomLabel(); state.anchors = null; };
$('zoomOut').onclick = () => { pdf.setScale(pdf.scale - 0.12); state.autoFit = false; updateZoomLabel(); state.anchors = null; };
zoomFit.onclick = () => applyFit();

function updateZoomLabel() {
  zoomFit.textContent = Math.round(pdf.scale / pdf.baseScale * 100) + '%';
}

/* 课件基本是 16:9，固定倍率必然横向溢出，默认按栏宽适配 */
function applyFit() {
  if (!pdf.ready) return;
  if (state.layout === 'notes') return;      // 面板隐藏时宽度为 0，不能算
  const w = pdfScroll.clientWidth;
  if (w < 120) return;
  pdf.fitWidth(w);
  state.autoFit = true;
  state.anchors = null;
  updateZoomLabel();
}

/* ---------------- 全局键盘 ---------------- */
window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    closePop();            // 搜索面板和批注气泡都是浮层，同时开着会互相压
    searchInput.focus();
    searchInput.select();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); flushSave(); return; }
  if (e.key === 'Escape') { closePop(); hideSearch(); closeModulePanel(); }
});

document.addEventListener('mousedown', e => {
  if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.blk')) closePop();
  if (!searchResults.hidden && !searchResults.contains(e.target) && e.target !== searchInput) hideSearch();
  if (!modulePanel.hidden && !modulePanel.contains(e.target) && e.target !== moduleBtn) closeModulePanel();
});

/* 未保存离开提醒在「批注落盘」一节注册。 */
window.addEventListener('resize', () => { state.anchors = null; if (state.autoFit) applyFit(); });

/* ---------------- 启动 ---------------- */
(async function boot() {
  try {
    const dom = document.documentElement;
    setTheme(dom.dataset.theme || 'light', false);
    setMode(dom.dataset.mode || 'read', false);

    await loadModuleList();
    if (!state.modules.length) {
      notesBody.innerHTML = '<p class="dim" style="padding:40px 0;text-align:center">courses/ 下还没有模块。按「课程名/Module N/」建目录，放入 notes.md 与 slides.pdf。</p>';
      return;
    }
    let want = null;
    try {
      const last = localStorage.getItem('nh-last');
      want = state.modules.find(m => m.id === last) || null;
    } catch { }
    if (!want) want = state.modules.find(m => m.hasNotes && m.hasSlides) || state.modules[0];
    await openModule(want.id);
  } catch (e) {
    console.error(e);
    const message = document.createElement('p');
    message.className = 'dim';
    message.textContent = '启动失败：' + e.message;
    notesBody.replaceChildren(message);
  }
})();
