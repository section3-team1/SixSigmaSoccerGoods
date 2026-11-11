// =====================================================================
//  SSSG ERP — app shell: login, navigation, live updates
// =====================================================================
import { sb, S, loadRefs, isStaff, isManager, $, esc, toast, modalOpen, sel, rpc } from './lib.js';

const ROUTES = {
  dashboard:  { label: 'Dashboard',        icon: '◧', group: 'Overview', mod: './pages/dashboard.js' },
  pos:        { label: 'Point of Sale',    icon: '⌁', group: 'Sell',     mod: './pages/pos.js' },
  orders:     { label: 'Sales Orders',     icon: '☰', group: 'Sell',     mod: './pages/orders.js' },
  returns:    { label: 'Returns & Exchanges', icon: '↺', group: 'Sell',  mod: './pages/returns.js' },
  inventory:  { label: 'Inventory',        icon: '▦', group: 'Operate',  mod: './pages/inventory.js' },
  production: { label: 'Production',       icon: '⚙', group: 'Operate',  mod: './pages/production.js' },
  purchasing: { label: 'Purchasing & Suppliers', icon: '⇣', group: 'Operate', mod: './pages/purchasing.js' },
  planning:   { label: 'Planning & MRP',   icon: '◷', group: 'Operate',  mod: './pages/planning.js' },
  finance:    { label: 'Financials',       icon: '$', group: 'Analyze',  mod: './pages/finance.js' },
  reports:    { label: 'Reports',          icon: '▤', group: 'Analyze',  mod: './pages/reports.js' },
  quality:    { label: 'Six Sigma Quality', icon: 'σ', group: 'Analyze', mod: './pages/quality.js' },
  items:      { label: 'Items & BOMs',     icon: '◫', group: 'Admin',    mod: './pages/items.js' },
  labels:     { label: 'Barcode Labels',   icon: '▥', group: 'Admin',    mod: './pages/labels.js' },
  settings:   { label: 'Settings & Users', icon: '⚑', group: 'Admin',    mod: './pages/settings.js' },
  about:      { label: 'System Info',      icon: 'ⓘ', group: 'Admin',    mod: './pages/about.js' },
};

let current = null;      // { name, mod }
let rendering = false;
let dirty = false;

// ---------------------------------------------------------------- auth
async function boot() {
  if (window.SSSG_CONFIG.SUPABASE_URL.includes('YOUR-PROJECT')) {
    $('#app').innerHTML = `<div class="setup-card"><h2>Almost there</h2>
      <p>Open <code>js/config.js</code> and paste your Supabase <b>Project URL</b> and <b>anon public key</b>.</p></div>`;
    return;
  }
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  sb.auth.onAuthStateChange((evt, session) => {
    const changed = (session?.user?.id || null) !== (S.session?.user?.id || null);
    S.session = session;
    if (changed) start();
  });
  start();
}

async function start() {
  if (!S.session) return renderLogin();
  try {
    S.profile = (await sel('profiles', '*', (q) => q.eq('id', S.session.user.id)))[0] || null;
    if (!S.profile) {   // trigger may lag a moment right after sign-up
      await new Promise((r) => setTimeout(r, 800));
      S.profile = (await sel('profiles', '*', (q) => q.eq('id', S.session.user.id)))[0] || { role: 'customer' };
    }
    await loadRefs();
  } catch (e) {
    $('#app').innerHTML = `<div class="setup-card"><h2>Can't reach the database</h2><p>${esc(e.message)}</p>
      <p>Check <code>js/config.js</code> and that both SQL files were run.</p>
      <button class="btn" onclick="location.reload()">Retry</button></div>`;
    return;
  }
  if (isStaff()) renderShell();
  else {
    const portal = await import('./pages/portal.js');
    portal.mount($('#app'));
  }
  subscribeLive();
}

function renderLogin() {
  $('#app').innerHTML = `
  <div class="login">
    <div class="login-brand">
      <div class="logo big">σ</div>
      <h1>Six Sigma Soccer Goods</h1>
      <p>Provo · Orem · Warehouse &amp; Print Shop</p>
      <ul class="login-points"><li>Point of sale, orders &amp; returns</li><li>Inventory, production &amp; MRP</li>
      <li>Purchasing, suppliers &amp; financials</li><li>Six Sigma quality analytics</li></ul>
    </div>
    <div class="login-card">
      <div class="seg"><button class="on" data-m="in">Sign in</button><button data-m="up">Create account</button></div>
      <form id="auth-form">
        <label class="up">Full name<input name="full_name" autocomplete="name"></label>
        <label>Email<input name="email" type="email" required autocomplete="email"></label>
        <label>Password<input name="password" type="password" required minlength="6" autocomplete="current-password"></label>
        <div class="up">
          <label>Account type
            <select name="kind"><option value="customer">Customer (coach / player)</option>
              <option value="staff">SSSG employee</option><option value="manager">SSSG manager</option></select></label>
          <label class="code-row hidden">Staff code<input name="staff_code" placeholder="Ask your manager"></label>
        </div>
        <button class="btn primary block" type="submit">Sign in</button>
        <p class="muted small center">Customers: use the email your team has on file to see your orders.</p>
      </form>
    </div>
  </div>`;
  let mode = 'in';
  const form = $('#auth-form');
  const setMode = (m) => {
    mode = m;
    document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    form.querySelectorAll('.up').forEach((x) => x.style.display = m === 'up' ? '' : 'none');
    form.querySelector('[type=submit]').textContent = m === 'up' ? 'Create account' : 'Sign in';
  };
  setMode('in');
  document.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => setMode(b.dataset.m)));
  form.kind.onchange = () => form.querySelector('.code-row').classList.toggle('hidden', form.kind.value === 'customer');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    const f = Object.fromEntries(new FormData(form));
    try {
      if (mode === 'in') {
        const { error } = await sb.auth.signInWithPassword({ email: f.email, password: f.password });
        if (error) throw error;
      } else {
        const meta = { full_name: f.full_name || f.email.split('@')[0] };
        if (f.kind !== 'customer') { meta.staff_code = f.staff_code; meta.role = f.kind; }
        const { data, error } = await sb.auth.signUp({ email: f.email, password: f.password, options: { data: meta } });
        if (error) throw error;
        if (!data.session) toast('Account created. Check your email to confirm, then sign in.', 'ok', 7000);
      }
    } catch (err) {
      toast(esc(err.message), 'err', 6000);
    } finally { btn.disabled = false; }
  };
}

// ---------------------------------------------------------------- shell
function renderShell() {
  const groups = {};
  Object.entries(ROUTES).forEach(([k, r]) => (groups[r.group] ||= []).push([k, r]));
  const initials = (S.profile.full_name || S.profile.email || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  $('#app').innerHTML = `
  <div class="shell">
    <aside class="side" id="side">
      <div class="brand"><div class="logo">σ</div><div><b>SSSG</b><span>Six Sigma Soccer Goods</span></div></div>
      <nav>${Object.entries(groups).map(([g, list]) => `
        <div class="nav-g">${g}</div>
        ${list.map(([k, r]) => `<a href="#/${k}" data-r="${k}"><i>${r.icon}</i>${r.label}</a>`).join('')}`).join('')}
      </nav>
      <div class="side-foot"><span class="live-dot" id="live-dot"></span><span id="live-txt">Connecting…</span></div>
    </aside>
    <div class="main">
      <header class="top">
        <button class="icon-btn menu" id="menu-btn" aria-label="Menu">☰</button>
        <h2 id="page-title"></h2>
        <div class="top-r">
          <div class="user"><span class="avatar">${esc(initials)}</span>
            <span class="u-txt"><b>${esc(S.profile.full_name || S.profile.email)}</b><small>${esc(S.profile.role)}</small></span></div>
          <button class="btn ghost sm" id="logout">Sign out</button>
        </div>
      </header>
      <main id="view" class="view"></main>
    </div>
  </div>`;
  $('#logout').onclick = () => sb.auth.signOut();
  $('#menu-btn').onclick = () => $('#side').classList.toggle('open');
  window.onhashchange = route;
  route();
}

async function route() {
  if (!isStaff()) return;
  const name = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'dashboard';
  const r = ROUTES[name] || ROUTES.dashboard;
  document.querySelectorAll('.side nav a').forEach((a) => a.classList.toggle('on', a.dataset.r === name));
  $('#side')?.classList.remove('open');
  $('#page-title').textContent = r.label;
  const mod = await import(r.mod);
  current = { name, mod };
  await renderCurrent(true);
}

// Each page navigation gets a fresh container. If the user clicks away while a slow page is
// still loading, that page finishes into a detached container and can't overwrite the new one.
let host = null, gen = 0;
async function renderCurrent(first = false) {
  if (!current) return;
  if (first || !host) {
    gen++;
    host = document.createElement('div');
    host.innerHTML = '<div class="loading"><span class="spin"></span> Loading…</div>';
    $('#view').replaceChildren(host);
    rendering = false; dirty = false;
  } else if (rendering) { dirty = true; return; }
  const myGen = gen, myHost = host, mod = current.mod;
  rendering = true;
  try {
    await mod.render(myHost, { first });
  } catch (e) {
    console.error(e);
    if (myGen === gen) myHost.innerHTML = `<div class="setup-card"><h3>Something went wrong</h3><p>${esc(e.message)}</p></div>`;
  } finally {
    if (myGen === gen) {
      rendering = false;
      if (dirty) { dirty = false; renderCurrent(); }
    }
  }
}
// pages call this after they change data so the screen refreshes immediately
window.addEventListener('sssg:refresh', () => renderCurrent());

// ---------------------------------------------------------------- live updates
let channel = null, pollTimer = null, refreshTimer = null, lowStock = null;
const TABLE_LABEL = {
  sales: 'sale recorded', inventory: 'inventory changed', sales_orders: 'sales order updated',
  purchase_orders: 'purchase order updated', production_orders: 'work order updated', returns: 'return processed',
  items: 'item master updated', settings: 'settings changed', suppliers: 'supplier updated', customers: 'customer updated',
};

function subscribeLive() {
  if (channel) sb.removeChannel(channel);
  clearInterval(pollTimer);
  channel = sb.channel('sssg-live');
  Object.keys(TABLE_LABEL).forEach((t) =>
    channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => onChange(t)));
  let ok = false;
  channel.subscribe((status) => {
    ok = status === 'SUBSCRIBED';
    setLive(ok ? 'live' : 'poll');
  });
  // safety net: if realtime is blocked (some networks), poll instead
  pollTimer = setInterval(() => { if (!ok) onChange(null); }, 20000);
  if (isStaff()) checkLowStock(true);
}

function setLive(state) {
  const dot = $('#live-dot'), txt = $('#live-txt');
  if (!dot) return;
  dot.className = 'live-dot ' + state;
  txt.textContent = state === 'live' ? 'Live — syncing all users' : 'Auto-refresh every 20s';
}

// remember when the user last typed/changed something on the page, so a live update
// never wipes a half-filled form (it waits until they've been idle for a bit)
let lastInput = 0;
['input', 'change'].forEach((ev) => document.addEventListener(ev, (e) => {
  if (e.target.closest?.('#view') && e.target.matches('input,select,textarea')) lastInput = Date.now();
}, true));
const IDLE_MS = 30000;

const pending = new Set();
function onChange(table) {
  if (table) pending.add(table);
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const tables = [...pending];
    pending.clear();
    if (tables.some((t) => ['items', 'settings', 'suppliers', 'customers'].includes(t)) || !table) {
      await loadRefs().catch(() => {});
    }
    const portal = window.__portalRefresh;
    if (portal) return portal();
    if (tables.length) flashLive(tables);
    // never wipe a form someone is filling in: wait for the dialog to close / typing to stop
    const idleRender = () => {
      if (modalOpen()) return document.addEventListener('modal-closed', idleRender, { once: true });
      const wait = IDLE_MS - (Date.now() - lastInput);
      if (wait > 0) { clearTimeout(idleRender._t); idleRender._t = setTimeout(idleRender, wait); return; }
      renderCurrent();
    };
    idleRender();
    if (tables.includes('inventory') || !table) checkLowStock();
  }, 600);
}

function flashLive(tables) {
  const dot = $('#live-dot');
  if (dot) { dot.classList.add('pulse'); setTimeout(() => dot.classList.remove('pulse'), 1200); }
  const t = $('#live-txt');
  if (t) {
    t.textContent = 'Updated: ' + tables.map((x) => TABLE_LABEL[x]).join(', ');
    clearTimeout(t._t);
    t._t = setTimeout(() => setLive(channel?.state === 'joined' ? 'live' : 'poll'), 4000);
  }
}

// alert every user the moment something drops below its reorder point
async function checkLowStock(initial = false) {
  try {
    const rows = await sel('v_item_planning', 'item_id,sku,name,item_type,stock_status,inv_position,rop', (q) => q.eq('stock_status', 'Reorder now'));
    const now = new Set(rows.map((r) => r.item_id));
    if (!initial && lowStock) {
      rows.filter((r) => !lowStock.has(r.item_id)).forEach((r) =>
        toast(`⚠ <b>${esc(r.sku)}</b> just fell to its reorder point (position ${Number(r.inv_position)} ≤ ROP ${Number(r.rop)}). <a href="#/planning">Plan it →</a>`, 'warn', 9000));
    }
    lowStock = now;
  } catch { /* ignore */ }
}

boot();
