// Inventory — on hand by item & location, transfers, adjustments with reason codes,
// cycle counts, scan-to-adjust, backorders + estimated available date, full ledger.
import {
  S, sel, rpc, money, num, esc, act, modal, options, table, badge, tabs, fdate, fdt, item, loc, locLabel,
  itemLabel, reasons, itemByCode, scanField, cameraScan, toast, refresh, $, beep,
} from '../lib.js';

const st = { tab: 'onhand', cat: 'All', q: '', scanned: null, ledgerItem: '', ledgerType: '' };

export async function render(view) {
  view.innerHTML = `${tabs('inv', [['onhand', 'On hand by location'], ['scan', 'Scan to adjust / count'], ['ledger', 'Transaction ledger']], st.tab)}<div id="inv-body"></div>`;
  view.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { st.tab = b.dataset.tab; render(view); }));
  const body = $('#inv-body', view);
  if (st.tab === 'onhand') await onHand(body);
  if (st.tab === 'scan') await scanTab(body);
  if (st.tab === 'ledger') await ledger(body);
}

async function onHand(body) {
  const [inv, back, plan] = await Promise.all([
    sel('inventory', 'item_id,location_id,qty'),
    sel('v_item_backorders', '*'),
    sel('v_item_planning', 'item_id,on_order,rop,stock_status'),
  ]);
  const locs = S.refs.locations;
  const q = {};
  inv.forEach((r) => ((q[r.item_id] ||= {})[r.location_id] = Number(r.qty)));
  const bo = Object.fromEntries(back.map((b) => [b.item_id, b]));
  const pl = Object.fromEntries(plan.map((p) => [p.item_id, p]));
  const cats = ['All', ...new Set(S.refs.items.map((i) => i.category))];
  const rows = S.refs.items.filter((i) => (st.cat === 'All' || i.category === st.cat) &&
    (!st.q || (i.sku + i.name + i.barcode).toLowerCase().includes(st.q.toLowerCase())));
  let totVal = 0;
  const data = rows.map((i) => {
    const byLoc = q[i.id] || {};
    const total = locs.filter((l) => l.kind !== 'qc').reduce((a, l) => a + (byLoc[l.id] || 0), 0);
    const all = locs.reduce((a, l) => a + (byLoc[l.id] || 0), 0);
    totVal += all * Number(i.avg_cost);
    return { ...i, byLoc, total, value: all * Number(i.avg_cost), bo: bo[i.id], pl: pl[i.id] };
  });

  body.innerHTML = `
  <div class="toolbar">
    <div class="chips">${cats.map((c) => `<button class="chip ${c === st.cat ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <input id="inv-q" placeholder="Search SKU, name or barcode" value="${esc(st.q)}" style="max-width:240px;margin:0">
    <span class="grow"></span>
    <button class="btn" id="inv-tr">⇄ Transfer</button>
    <button class="btn" id="inv-adj">± Adjust</button>
    <button class="btn" id="inv-cc">✓ Cycle count</button>
  </div>
  <div class="card">
    ${table([
      { k: 'sku', label: 'SKU', f: (v, r) => `<b>${esc(v)}</b><div class="muted small mono">${esc(r.barcode)}</div>` },
      { k: 'name', label: 'Item', f: (v, r) => `${esc(v)}<div class="muted small">${esc(r.category)}${r.item_type === 'kit' ? ' · made in-house' : r.item_type === 'component' ? ' · component' : ''}</div>` },
      ...locs.map((l) => ({ k: 'byLoc', label: l.code, cls: 'num', f: (v) => {
        const n = v[l.id] || 0;
        return l.kind === 'qc' ? (n ? `<span class="badge amber">${num(n)}</span>` : '<span class="muted">0</span>') : num(n);
      } })),
      { k: 'total', label: 'Total sellable', cls: 'num', f: (v, r) => `<b>${num(v)}</b>` },
      { k: 'pl', label: 'On order', cls: 'num', f: (v) => num(v?.on_order || 0) },
      { k: 'pl', label: 'ROP', cls: 'num', f: (v) => num(v?.rop) },
      { k: 'bo', label: 'Backordered', cls: 'num', f: (v) => (v ? `<span class="neg">${num(v.backordered)}</span>` : '0') },
      { k: 'bo', label: 'Est. available', f: (v) => (v ? fdate(v.est_available) : '—') },
      { k: 'avg_cost', label: 'Avg cost', cls: 'num', f: (v) => money(v) },
      { k: 'value', label: 'Value', cls: 'num', f: (v) => money(v) },
      { k: 'pl', label: '', f: (v) => (v ? badge(v.stock_status) : '') },
    ], data, { rowAttr: (r) => `class="click" data-item="${r.id}"`,
      foot: `<tfoot><tr><td colspan="${locs.length + 8}">Total inventory value (weighted average cost)</td><td class="num">${money(totVal)}</td><td></td></tr></tfoot>` })}
    <p class="muted small">QCH = QC Hold, where quality returns wait for inspection. They aren't sellable and aren't counted in "Total sellable". Click a row for that item's history.</p>
  </div>`;

  body.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => { st.cat = b.dataset.cat; onHand(body); }));
  $('#inv-q', body).oninput = (e) => { st.q = e.target.value; clearTimeout(st._t); st._t = setTimeout(() => onHand(body).then(() => { const i = $('#inv-q'); i.focus(); i.setSelectionRange(99, 99); }), 300); };
  $('#inv-tr', body).onclick = () => transferModal();
  $('#inv-adj', body).onclick = () => adjustModal();
  $('#inv-cc', body).onclick = () => countModal();
  body.querySelectorAll('[data-item]').forEach((r) => (r.onclick = () => itemHistory(Number(r.dataset.item))));
}

export function transferModal(itemId, fromId) {
  modal({
    title: '⇄ Transfer between locations',
    body: `<label>Item<select name="item">${options(S.refs.items, itemId, itemLabel)}</select></label>
      <div class="row2"><label>From<select name="from">${options(S.refs.locations, fromId || 3, locLabel)}</select></label>
      <label>To<select name="to">${options(S.refs.locations, 1, locLabel)}</select></label></div>
      <div class="row2"><label>Quantity<input name="qty" type="number" min="1" value="1"></label>
      <label>Note<input name="note" placeholder="optional"></label></div>
      <p class="note">Tip: moving an item out of QC Hold after it passes inspection puts it back in sellable stock.</p>`,
    okText: 'Transfer',
    onOk: async (el) => {
      const v = (n) => el.querySelector(`[name=${n}]`).value;
      await rpc('transfer_inventory', { p_item: Number(v('item')), p_from: Number(v('from')), p_to: Number(v('to')), p_qty: Number(v('qty')), p_note: v('note') || null });
      toast('Transfer posted'); refresh();
    },
  });
}

export function adjustModal(itemId, locId) {
  modal({
    title: '± Inventory adjustment',
    body: `<label>Item<select name="item">${options(S.refs.items, itemId, itemLabel)}</select></label>
      <div class="row2"><label>Location<select name="loc">${options(S.refs.locations, locId || 1, locLabel)}</select></label>
      <label>Change (+ add / − remove)<input name="qty" type="number" value="-1"></label></div>
      <label>Reason code (required)<select name="reason">${reasons('adjust').filter((r) => !r.code.startsWith('CC-')).map((r) => `<option value="${r.code}">${r.code} — ${esc(r.description)}</option>`).join('')}</select></label>
      <label>Note<input name="note" placeholder="what happened?"></label>`,
    okText: 'Post adjustment',
    onOk: async (el) => {
      const v = (n) => el.querySelector(`[name=${n}]`).value;
      await rpc('adjust_inventory', { p_item: Number(v('item')), p_loc: Number(v('loc')), p_delta: Number(v('qty')), p_reason: v('reason'), p_note: v('note') || null });
      toast('Adjustment posted — value change hits Inventory Write-offs on the P&L'); refresh();
    },
  });
}

export function countModal(itemId, locId) {
  modal({
    title: '✓ Cycle count',
    body: `<label>Item<select name="item">${options(S.refs.items, itemId, itemLabel)}</select></label>
      <div class="row2"><label>Location<select name="loc">${options(S.refs.locations, locId || 1, locLabel)}</select></label>
      <label>Counted quantity<input name="qty" type="number" min="0" value="0"></label></div>
      <p class="note">The system compares your count to on-hand and posts the difference with reason code CC-OVER or CC-SHORT.</p>`,
    okText: 'Post count',
    onOk: async (el) => {
      const v = (n) => el.querySelector(`[name=${n}]`).value;
      const d = await rpc('cycle_count', { p_item: Number(v('item')), p_loc: Number(v('loc')), p_counted: Number(v('qty')) });
      toast(Number(d) === 0 ? 'Count matches the system — no adjustment needed' : `Variance of ${d > 0 ? '+' : ''}${num(d)} posted`); refresh();
    },
  });
}

async function scanTab(body) {
  let inv = [];
  const it = st.scanned ? item(st.scanned) : null;
  if (it) inv = await sel('inventory', 'location_id,qty', (q) => q.eq('item_id', it.id));
  const qty = (l) => Number(inv.find((r) => r.location_id === l)?.qty || 0);
  body.innerHTML = `
  <div class="grid g2">
    <div class="card">
      <h3>Scan an item label</h3>
      <div class="scanbar"><input id="sc-in" placeholder="Scan barcode with USB scanner, or type SKU + Enter"><button class="btn blue" id="sc-cam">📷 Camera</button></div>
      <p class="muted small">Works with the printed labels from <a href="#/labels">Barcode Labels</a>. To receive purchase orders by scan, open the PO in Purchasing → Receive.</p>
      ${it ? `
        <div class="note" style="margin-top:12px"><b style="font-size:15px">${esc(it.name)}</b><br>${esc(it.sku)} · barcode <span class="mono">${esc(it.barcode)}</span> · avg cost ${money(it.avg_cost)}</div>
        ${table([
          { k: 'name', label: 'Location', f: (v, l) => `${esc(l.code)} · ${esc(v)}` },
          { k: 'id', label: 'On hand', cls: 'num', f: (v) => `<b>${num(qty(v))}</b>` },
          { k: 'id', label: 'Quick actions', f: (v) => `<button class="btn sm" data-q="${v}" data-d="1">+1</button> <button class="btn sm" data-q="${v}" data-d="-1">−1</button> <button class="btn sm" data-cc="${v}">Count</button> <button class="btn sm" data-tr="${v}">Transfer</button>` },
        ], S.refs.locations)}
        <label style="margin-top:12px">Reason for ± quick adjustments<select id="sc-reason">${reasons('adjust').filter((r) => !r.code.startsWith('CC-')).map((r) => `<option value="${r.code}">${r.code} — ${esc(r.description)}</option>`).join('')}</select></label>` : '<div class="empty" style="margin-top:12px">Scan something to see it here</div>'}
    </div>
    <div class="card"><h3>Why scanning matters</h3><div class="note">Every movement is keyed by the item's barcode, so there are no typos in SKUs. Cycle counts post only the <b>variance</b>, with a reason code. Each adjustment is valued at weighted-average cost and flows straight to <b>Inventory Write-offs</b> on the P&amp;L, so shrink is visible in dollars.</div></div>
  </div>`;
  const hit = (code) => {
    const i = itemByCode(code);
    if (!i) return toast(`Unknown barcode "${esc(code)}"`, 'err');
    beep(); st.scanned = i.id; scanTab(body).then(() => $('#sc-in')?.focus());
  };
  scanField($('#sc-in', body), hit);
  $('#sc-in', body).focus();
  $('#sc-cam', body).onclick = () => cameraScan(hit);
  body.querySelectorAll('[data-q]').forEach((b) => (b.onclick = (e) => act(e.currentTarget, () =>
    rpc('adjust_inventory', { p_item: it.id, p_loc: Number(b.dataset.q), p_delta: Number(b.dataset.d), p_reason: $('#sc-reason', body).value, p_note: 'Scan adjustment' }), 'Adjusted').then(() => scanTab(body)).catch(() => {})));
  body.querySelectorAll('[data-cc]').forEach((b) => (b.onclick = () => countModal(it.id, Number(b.dataset.cc))));
  body.querySelectorAll('[data-tr]').forEach((b) => (b.onclick = () => transferModal(it.id, Number(b.dataset.tr))));
}

async function ledger(body) {
  const rows = await sel('inventory_txns', '*', (q) => {
    q = q.order('ts', { ascending: false }).order('id', { ascending: false }).limit(300);
    if (st.ledgerItem) q = q.eq('item_id', Number(st.ledgerItem));
    if (st.ledgerType) q = q.eq('txn_type', st.ledgerType);
    return q;
  });
  const types = ['sale', 'return', 'receipt', 'transfer_in', 'transfer_out', 'adjust', 'prod_issue', 'prod_receipt', 'opening'];
  body.innerHTML = `
  <div class="toolbar">
    <select id="lg-item" style="max-width:320px;margin:0"><option value="">All items</option>${options(S.refs.items, st.ledgerItem, itemLabel)}</select>
    <select id="lg-type" style="max-width:200px;margin:0"><option value="">All movement types</option>${types.map((t) => `<option ${t === st.ledgerType ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <span class="muted small">Latest 300 movements</span>
  </div>
  <div class="card">${table([
    { k: 'ts', label: 'When', f: (v) => fdt(v) },
    { k: 'item_id', label: 'Item', f: (v) => esc(item(v)?.sku) },
    { k: 'location_id', label: 'Loc', f: (v) => esc(loc(v)?.code) },
    { k: 'txn_type', label: 'Type', f: (v) => badge(v, v.includes('in') || ['receipt', 'return', 'prod_receipt'].includes(v) ? 'teal' : v === 'adjust' ? 'amber' : 'gray') },
    { k: 'qty', label: 'Qty', cls: 'num', f: (v) => (v > 0 ? `<span class="pos-v">+${num(v)}</span>` : `<span class="neg">${num(v)}</span>`) },
    { k: 'unit_cost', label: 'Unit cost', cls: 'num', f: (v) => money(v) },
    { k: 'qty', label: 'Value', cls: 'num', f: (v, r) => money(v * r.unit_cost) },
    { k: 'reason_code', label: 'Reason', f: (v) => esc(v || '') },
    { k: 'ref_type', label: 'Reference', f: (v, r) => (v ? `${esc(v)}${r.ref_id ? ' #' + r.ref_id : ''}` : '') },
    { k: 'user_email', label: 'By', f: (v) => `<span class="muted small">${esc(v)}</span>` },
  ], rows)}</div>`;
  $('#lg-item', body).onchange = (e) => { st.ledgerItem = e.target.value; ledger(body); };
  $('#lg-type', body).onchange = (e) => { st.ledgerType = e.target.value; ledger(body); };
}

function itemHistory(id) {
  st.ledgerItem = String(id); st.ledgerType = ''; st.tab = 'ledger';
  refresh();
}
