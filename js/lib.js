// =====================================================================
//  SSSG ERP — shared helpers (data access, formatting, UI widgets)
// =====================================================================
const cfg = window.SSSG_CONFIG;
export const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  realtime: { params: { eventsPerSecond: 10 } },
});

// app-wide state: who is logged in + cached master data
export const S = {
  session: null,
  profile: null,
  refs: { locations: [], items: [], customers: [], suppliers: [], reasons: [], settings: [], bom: [] },
};

// ---------- data access ----------
export async function rpc(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

export async function sel(table, cols = '*', build = (q) => q) {
  const { data, error } = await build(sb.from(table).select(cols));
  if (error) throw new Error(error.message);
  return data;
}

export async function loadRefs() {
  const staff = isStaff();
  const [locations, items, reasons, settings, bom, customers, suppliers] = await Promise.all([
    sel('locations', '*', (q) => q.order('id')),
    sel('items', '*', (q) => q.order('sku')),
    sel('reason_codes', '*', (q) => q.order('code')),
    sel('settings', '*', (q) => q.order('sort')),
    sel('bom', '*'),
    staff ? sel('customers', '*', (q) => q.order('name')) : Promise.resolve([]),
    staff ? sel('suppliers', '*', (q) => q.order('name')) : Promise.resolve([]),
  ]);
  Object.assign(S.refs, { locations, items, reasons, settings, bom, customers, suppliers });
}

export const isStaff = () => ['manager', 'staff'].includes(S.profile?.role);
export const isManager = () => S.profile?.role === 'manager';
export const item = (id) => S.refs.items.find((i) => i.id === id);
export const loc = (id) => S.refs.locations.find((l) => l.id === id);
export const cust = (id) => S.refs.customers.find((c) => c.id === id);
export const sup = (id) => S.refs.suppliers.find((s) => s.id === id);
export const setting = (k) => Number(S.refs.settings.find((s) => s.key === k)?.value ?? 0);
export const stores = () => S.refs.locations.filter((l) => l.kind === 'store');
export const stockLocs = () => S.refs.locations.filter((l) => l.kind !== 'qc');
export const reasons = (kind) => S.refs.reasons.filter((r) => r.kind === kind);
export const bomOf = (parentId) => S.refs.bom.filter((b) => b.parent_id === parentId);

// find an item by scanned barcode or typed SKU
export function itemByCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  return S.refs.items.find((i) => i.barcode === c || i.sku.toUpperCase() === c) || null;
}

// ---------- formatting ----------
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
export const money = (v) => (v == null || isNaN(v) ? '—' : usd.format(Number(v)));
export const money0 = (v) => (v == null || isNaN(v) ? '—' : usd0.format(Number(v)));
export const num = (v, d = 0) =>
  v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const pct = (v, d = 1) => (v == null || isNaN(v) ? '—' : (Number(v) * 100).toFixed(d) + '%');
export const fdate = (d) => {
  if (!d) return '—';
  const x = typeof d === 'string' && d.length === 10 ? new Date(d + 'T12:00:00') : new Date(d);
  return x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
export const fdt = (d) =>
  d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

// today's date in Provo (YYYY-MM-DD)
export function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
}
export const addDays = (iso, n) => {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
export const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const docNo = (prefix, id) => `${prefix}-${id}`;

// ---------- DOM helpers ----------
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export function on(root, event, selector, fn) {
  root.addEventListener(event, (e) => {
    const t = e.target.closest(selector);
    if (t && root.contains(t)) fn(e, t);
  });
}

export function toast(msg, kind = 'ok', ms = 3500) {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = msg;
  box.appendChild(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

// run an async action with button spinner + error toast
export async function act(btn, fn, okMsg) {
  if (btn) { btn.disabled = true; btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="spin"></span>'; }
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'ok');
    return r;
  } catch (e) {
    toast(esc(e.message || e), 'err', 6000);
    throw e;
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = btn.dataset.label; }
  }
}

export function modal({ title, body, okText = 'Save', onOk, wide = false, cancelText = 'Cancel', hideOk = false }) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-bg';
  wrap.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-h"><h3>${title}</h3><button class="icon-btn x" aria-label="Close">✕</button></div>
      <div class="modal-b">${body}</div>
      <div class="modal-f">
        <button class="btn ghost cancel">${cancelText}</button>
        ${hideOk ? '' : `<button class="btn primary ok">${okText}</button>`}
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => { wrap.remove(); document.dispatchEvent(new Event('modal-closed')); };
  $('.x', wrap).onclick = close;
  $('.cancel', wrap).onclick = close;
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  if (!hideOk) {
    $('.ok', wrap).onclick = async (e) => {
      try {
        const keep = await act(e.currentTarget, () => onOk(wrap));
        if (keep !== false) close();
      } catch { /* error already shown */ }
    };
  }
  setTimeout(() => $('input:not([type=hidden]),select', wrap)?.focus(), 30);
  return { el: wrap, close };
}
export const modalOpen = () => !!$('.modal-bg');

// ---------- tables ----------
// cols: [{k:'name', label:'Name', f:(v,row)=>html, cls:'num'}]
export function table(cols, rows, { empty = 'Nothing to show', rowAttr = () => '', foot = '' } = {}) {
  if (!rows?.length) return `<div class="empty">${empty}</div>`;
  return `<div class="tbl-wrap"><table class="tbl">
    <thead><tr>${cols.map((c) => `<th class="${c.cls || ''}">${c.label}</th>`).join('')}</tr></thead>
    <tbody>${rows
      .map((r) => `<tr ${rowAttr(r)}>${cols
        .map((c) => `<td class="${c.cls || ''}">${c.f ? c.f(r[c.k], r) : esc(r[c.k])}</td>`).join('')}</tr>`)
      .join('')}</tbody>${foot}</table></div>`;
}

export function badge(text, kind) {
  const map = {
    placed: 'blue', fulfilled: 'teal', closed: 'gray', cancelled: 'red', draft: 'gray', sent: 'blue',
    partial: 'amber', received: 'teal', planned: 'gray', in_progress: 'amber', completed: 'teal',
    Keep: 'green', Watch: 'amber', Replace: 'red', New: 'gray',
    'Reorder now': 'red', 'Order soon': 'amber', OK: 'green', return: 'blue', exchange: 'violet',
  };
  const label = String(text).replace('_', ' ');
  return `<span class="badge ${kind || map[text] || 'gray'}">${esc(label)}</span>`;
}

export const kpi = (label, value, sub = '', tone = '') =>
  `<div class="kpi ${tone}"><div class="kpi-l">${label}</div><div class="kpi-v">${value}</div><div class="kpi-s">${sub}</div></div>`;

export function tabs(id, list, active) {
  return `<div class="tabs" data-tabs="${id}">${list
    .map(([k, label]) => `<button class="tab ${k === active ? 'on' : ''}" data-tab="${k}">${label}</button>`)
    .join('')}</div>`;
}

export const options = (list, val, labelFn = (x) => x.name, valFn = (x) => x.id) =>
  list.map((x) => `<option value="${esc(valFn(x))}" ${String(valFn(x)) === String(val) ? 'selected' : ''}>${esc(labelFn(x))}</option>`).join('');

export const itemLabel = (i) => `${i.sku} — ${i.name}`;
export const locLabel = (l) => `${l.code} · ${l.name}`;

// ---------- charts (Chart.js) ----------
export const COLORS = {
  s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a', s4: '#eda100', s5: '#e87ba4', s6: '#008300',
  critical: '#d03b3b', muted: '#8a8f98', grid: '#e7eaee', ink: '#1f2937', ink2: '#52514e',
};
const charts = new Map();
export function chart(canvas, config) {
  if (!canvas) return;
  charts.get(canvas.id)?.destroy();
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = COLORS.ink2;
  const c = new Chart(canvas, {
    ...config,
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: (config.data.datasets || []).length > 1, labels: { boxWidth: 12, boxHeight: 12 } } },
      scales: {
        x: { grid: { display: false }, border: { color: COLORS.grid } },
        y: { grid: { color: COLORS.grid }, border: { display: false }, beginAtZero: true },
      },
      ...(config.options || {}),
    },
  });
  charts.set(canvas.id, c);
  return c;
}

// ---------- barcode scanning ----------
// USB scanners type the code + Enter into the focused field
export function scanField(input, onCode) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = input.value.trim();
      input.value = '';
      if (v) onCode(v);
    }
  });
}

// phone / laptop camera scanner
export function cameraScan(onCode, { continuous = false } = {}) {
  const m = modal({
    title: '📷 Scan barcode',
    body: `<div id="cam-reader" class="cam"></div><p class="muted small">Hold the label 6–10 inches from the camera. ${continuous ? 'Keep scanning — each beep adds one.' : ''}</p>`,
    hideOk: true, cancelText: 'Done',
  });
  if (!window.Html5Qrcode) { toast('Camera library failed to load', 'err'); return; }
  const fmts = window.Html5QrcodeSupportedFormats;
  const reader = new Html5Qrcode('cam-reader', {
    formatsToSupport: [fmts.EAN_13, fmts.CODE_128, fmts.UPC_A, fmts.EAN_8, fmts.CODE_39, fmts.QR_CODE],
    verbose: false,
  });
  let last = '', lastAt = 0;
  const stop = () => reader.isScanning && reader.stop().catch(() => {});
  const obs = new MutationObserver(() => { if (!m.el.isConnected) { stop(); obs.disconnect(); } });
  obs.observe(document.body, { childList: true });
  reader
    .start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 280, height: 140 } }, (text) => {
      const now = Date.now();
      if (text === last && now - lastAt < 1500) return;
      last = text; lastAt = now;
      beep();
      onCode(text);
      if (!continuous) { stop(); m.close(); }
    })
    .catch((err) => { toast('Camera unavailable: ' + esc(err), 'err'); m.close(); });
}

let audioCtx;
export function beep() {
  try {
    audioCtx = audioCtx || new AudioContext();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 1400; g.gain.value = 0.08;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.08);
  } catch { /* no audio */ }
}

// ---------- stats ----------
// inverse standard normal CDF (Acklam) — used for sigma level
export function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
// process sigma level from DPMO (with the conventional 1.5 sigma shift)
export const sigmaLevel = (dpmo) => (dpmo <= 0 ? 6 : Math.min(6, normInv(1 - dpmo / 1e6) + 1.5));

// ---------- printing (opens a clean window so receipts/labels print alone) ----------
export function printDoc(title, html, extraCss = '') {
  const w = window.open('', '_blank', 'width=820,height=900');
  if (!w) { toast('Allow pop-ups to print', 'warn'); return; }
  w.document.write(`<!doctype html><html><head><title>${esc(title)}</title>
    <link rel="stylesheet" href="${new URL('css/styles.css', location.href)}">
    <style>body{background:#fff;padding:16px} ${extraCss}</style></head>
    <body>${html}<script>setTimeout(()=>{window.print()},400)<\/script></body></html>`);
  w.document.close();
}

// refresh the current page right away (after this user changes something)
export const refresh = () => window.dispatchEvent(new Event('sssg:refresh'));

// read every [name] field inside an element into an object
export function formVals(el) {
  const o = {};
  el.querySelectorAll('[name]').forEach((i) => (o[i.name] = i.type === 'checkbox' ? i.checked : i.value));
  return o;
}
