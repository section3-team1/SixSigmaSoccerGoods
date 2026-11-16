// Planning & MRP
//  • Reorder points with lead-time demand + safety stock, EOQ from sales history
//  • Periodic review (order-up-to level)
//  • MRP: confirmed sales orders x BOM -> net requirements -> order-by dates (4 weekly buckets)
import {
  S, sel, rpc, money, num, esc, act, table, badge, tabs, fdate, item, sup, setting, today, addDays, daysBetween,
  toast, refresh, $, bomOf, docNo, cust,
} from '../lib.js';
import { newPO } from './purchasing.js';
import { newWO } from './production.js';
import { runMRP, ltWeeks } from '../mrp.js';

const st = { tab: 'mrp', filter: 'action', weeks: 6 };

export async function render(view) {
  view.innerHTML = `${tabs('pl', [['mrp', 'MRP: material requirements'], ['rop', 'Reorder points & EOQ'], ['periodic', 'Periodic review']], st.tab)}<div id="pl-body"></div>`;
  view.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { st.tab = b.dataset.tab; render(view); }));
  const body = $('#pl-body', view);
  if (st.tab === 'rop') await rop(body);
  if (st.tab === 'periodic') await periodic(body);
  if (st.tab === 'mrp') await mrp(body);
}

// group suggested buys by supplier and open a pre-filled PO for each
function createPOs(rows, qtyKey) {
  const bySup = {};
  rows.filter((r) => r.item_type !== 'kit' && r[qtyKey] > 0).forEach((r) => (bySup[r.supplier_id] ||= []).push({ item_id: r.item_id, qty: Math.ceil(r[qtyKey]) }));
  const sups = Object.keys(bySup);
  if (!sups.length) return toast('Nothing to buy in that selection', 'warn');
  newPO({ supplier: Number(sups[0]), lines: bySup[sups[0]], notes: 'From planning suggestion' });
  if (sups.length > 1) toast(`Opened the PO for ${esc(sup(Number(sups[0])).name)}. ${sups.length - 1} more supplier(s) also need orders; create them after this one.`, 'warn', 8000);
}

async function rop(body) {
  const rows = await sel('v_item_planning', '*', (q) => q.order('sku'));
  const shown = rows.filter((r) => st.filter === 'all' || r.stock_status !== 'OK');
  const S_ = setting('ordering_cost'), H = setting('holding_cost_pct'), z = setting('service_z'), win = setting('history_days');
  body.innerHTML = `
  <div class="grid g2">
    <div class="note"><b>Continuous review (Q, R) policy</b>
      <div class="formula">avg daily usage d̄ = units sold + used in production over the last ${Math.floor(win / 7) * 7} days ÷ days<br>
      safety stock SS = z × σ<sub>daily</sub> × √LT  (z = ${z})<br>
      reorder point ROP = d̄ × LT + SS   ← lead-time demand + buffer<br>
      EOQ = √(2 × D × S ÷ H)  with D = d̄ × 365, S = ${money(S_)}/order, H = ${(H * 100).toFixed(0)}% × unit cost/yr<br>
      inventory position = on hand + on order − committed to open sales orders</div></div>
    <div class="note"><b>How to read it</b><br>When <b>inventory position ≤ ROP</b>, order the EOQ (or enough to clear the ROP). Otherwise the
      <b>order-by date</b> projects when the position will hit the ROP at today's usage rate. Kits are <b>built</b> on a production order, not bought.
      Change S, H or z in <a href="#/settings">Settings</a> and every number here recalculates.</div>
  </div>
  <div class="toolbar" style="margin-top:14px">
    <div class="chips"><button class="chip ${st.filter === 'action' ? 'on' : ''}" data-f="action">Needs action</button><button class="chip ${st.filter === 'all' ? 'on' : ''}" data-f="all">All items</button></div>
    <span class="grow"></span><button class="btn primary" id="rop-po">Create POs for "Reorder now" items</button>
  </div>
  <div class="card">${table([
    { k: 'sku', label: 'SKU', f: (v, r) => `<b>${esc(v)}</b><div class="muted small">${esc(r.name)}</div>` },
    { k: 'avg_daily', label: 'd̄ /day', cls: 'num', f: (v) => num(v, 2) },
    { k: 'sd_daily', label: 'σ daily', cls: 'num', f: (v) => num(v, 2) },
    { k: 'lead_time_days', label: 'LT (d)', cls: 'num' },
    { k: 'lead_time_demand', label: 'LT demand', cls: 'num', f: (v) => num(v, 1) },
    { k: 'safety_stock', label: 'SS', cls: 'num', f: (v) => num(v, 1) },
    { k: 'rop', label: 'ROP', cls: 'num', f: (v, r) => `<b>${num(v)}</b>${r.rop_override != null ? ' <span class="badge gray">manual</span>' : ''}` },
    { k: 'eoq_units', label: 'EOQ', cls: 'num', f: (v) => num(v) },
    { k: 'on_hand', label: 'On hand', cls: 'num', f: (v) => num(v) },
    { k: 'on_order', label: 'On order', cls: 'num', f: (v) => num(v) },
    { k: 'committed', label: 'Committed', cls: 'num', f: (v) => num(v) },
    { k: 'inv_position', label: 'Position', cls: 'num', f: (v, r) => `<span class="${v <= r.rop ? 'neg' : ''}">${num(v)}</span>` },
    { k: 'stock_status', label: 'Status', f: (v) => badge(v) },
    { k: 'suggested_qty', label: 'Suggested', cls: 'num', f: (v, r) => (v > 0 ? `<b>${num(v)}</b> ${r.item_type === 'kit' ? 'build' : 'buy'}` : '—') },
    { k: 'order_by', label: 'Order by', f: (v) => fdate(v) },
    { k: 'item_id', label: '', f: (v, r) => (r.suggested_qty > 0 ? `<button class="btn sm" data-act="${v}">${r.item_type === 'kit' ? 'Build' : 'Buy'}</button>` : '') },
  ], shown)}</div>`;
  body.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { st.filter = b.dataset.f; rop(body); }));
  $('#rop-po', body).onclick = () => createPOs(rows.filter((r) => r.stock_status === 'Reorder now'), 'suggested_qty');
  body.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => {
    const r = rows.find((x) => x.item_id === Number(b.dataset.act));
    if (r.item_type === 'kit') newWO({ item: r.item_id, qty: r.suggested_qty });
    else newPO({ supplier: r.supplier_id, lines: [{ item_id: r.item_id, qty: r.suggested_qty }] });
  }));
}

async function periodic(body) {
  const rows = (await sel('v_item_planning', '*', (q) => q.order('sku'))).filter((r) => r.item_type !== 'kit');
  const R = setting('review_period_days'), z = setting('service_z');
  const due = rows.filter((r) => r.review_due);
  body.innerHTML = `
  <div class="note"><b>Periodic review (R, S) policy</b>: every <b>${R} days</b> a buyer reviews each item and orders up to a target level.
    <div class="formula">order-up-to level S = d̄ × (R + LT) + z × σ<sub>daily</sub> × √(R + LT)<br>order quantity = S − inventory position</div>
    ${due.length} of ${rows.length} items are due for review (not reviewed in the last ${R} days).</div>
  <div class="toolbar" style="margin-top:14px"><span class="grow"></span>
    <button class="btn" id="pr-mark">Mark selected reviewed</button><button class="btn primary" id="pr-po">Create PO for selected</button></div>
  <div class="card">${table([
    { k: 'item_id', label: '<input type="checkbox" id="pr-all">', f: (v, r) => `<input type="checkbox" class="pr-c" value="${v}" ${r.review_due && r.periodic_qty > 0 ? 'checked' : ''}>` },
    { k: 'sku', label: 'SKU', f: (v, r) => `<b>${esc(v)}</b><div class="muted small">${esc(r.name)}</div>` },
    { k: 'supplier_name', label: 'Supplier' },
    { k: 'last_reviewed_at', label: 'Last reviewed', f: (v, r) => `${fdate(v)} ${r.review_due ? badge('due', 'amber') : ''}` },
    { k: 'avg_daily', label: 'd̄ /day', cls: 'num', f: (v) => num(v, 2) },
    { k: 'lead_time_days', label: 'LT', cls: 'num' },
    { k: 'order_up_to', label: 'Order-up-to (S)', cls: 'num', f: (v) => num(v, 0) },
    { k: 'inv_position', label: 'Position', cls: 'num', f: (v) => num(v) },
    { k: 'periodic_qty', label: 'Order qty', cls: 'num', f: (v) => (v > 0 ? `<b>${num(v)}</b>` : '0') },
    { k: 'unit_cost', label: 'Est. cost', cls: 'num', f: (v, r) => money(v * r.periodic_qty) },
  ], rows, { rowAttr: (r) => (r.review_due ? 'class="hl"' : '') })}</div>`;
  const picked = () => [...body.querySelectorAll('.pr-c:checked')].map((c) => Number(c.value));
  $('#pr-all', body).onchange = (e) => body.querySelectorAll('.pr-c').forEach((c) => (c.checked = e.target.checked));
  $('#pr-mark', body).onclick = (e) => act(e.currentTarget, () => rpc('mark_reviewed', { p_items: picked() }), 'Marked reviewed').then(() => refresh()).catch(() => {});
  $('#pr-po', body).onclick = async () => {
    const ids = picked();
    createPOs(rows.filter((r) => ids.includes(r.item_id)), 'periodic_qty');
    await rpc('mark_reviewed', { p_items: ids }).catch(() => {});
  };
}

async function mrp(body) {
  const t = today();
  const W = st.weeks;
  const wkStart = (w) => addDays(t, 7 * (w - 1));
  const wkOf = (d) => Math.floor(daysBetween(t, d) / 7) + 1;          // <= 0 means already past due
  const short = (d) => fdate(d).replace(/, \d{4}/, '');
  const [inv, soLines, poLines, wos] = await Promise.all([
    sel('inventory', 'item_id,qty,locations!inner(kind)', (q) => q.neq('locations.kind', 'qc')),
    sel('v_so_lines', 'so_id,item_id,remaining,requested_date,status,customer_id', (q) => q.eq('status', 'placed').order('requested_date')),
    sel('po_lines', 'po_id,item_id,qty_ordered,qty_received,purchase_orders!inner(status,expected_date)', (q) => q.in('purchase_orders.status', ['sent', 'partial'])),
    sel('production_orders', 'id,item_id,status,qty_planned,qty_started,due_date', (q) => q.in('status', ['planned', 'in_progress'])),
  ]);

  // ---------- 1. Inventory status file
  const parents = new Set(S.refs.bom.map((b) => b.parent_id));
  const children = new Set(S.refs.bom.map((b) => b.component_id));
  const onHand = {};
  inv.forEach((r) => (onHand[r.item_id] = (onHand[r.item_id] || 0) + Number(r.qty)));
  const items = S.refs.items.filter((i) => i.active).map((i) => ({
    id: i.id, sku: i.sku, name: i.name, level: children.has(i.id) && !parents.has(i.id) ? 1 : 0,
    lt: ltWeeks(i.lead_time_days), ltDays: i.lead_time_days, rule: i.lot_rule || 'L4L', foq: Number(i.lot_size || 0),
    onHand: onHand[i.id] || 0, isParent: parents.has(i.id),
  }));
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));

  // ---------- 2. Master production schedule = confirmed sales orders by week (past due -> week 1)
  const gross = soLines.filter((l) => wkOf(l.requested_date) <= W && l.remaining > 0)
    .map((l) => ({ item_id: l.item_id, week: Math.max(1, wkOf(l.requested_date)), qty: Number(l.remaining), source: `SO-${l.so_id}` }));

  // ---------- 3. Scheduled receipts = open POs + open work orders; planned WOs are firm parent releases
  const sr = [], firm = [];
  poLines.forEach((l) => {
    const w = wkOf(l.purchase_orders.expected_date);
    const q = Number(l.qty_ordered) - Number(l.qty_received);
    if (q > 0 && w <= W) sr.push({ item_id: l.item_id, week: Math.max(1, w), qty: q, source: `PO-${l.po_id}` });
  });
  wos.forEach((w) => {
    const due = Math.max(1, wkOf(w.due_date || t));
    const q = Number(w.status === 'planned' ? w.qty_planned : w.qty_started);
    if (due <= W) sr.push({ item_id: w.item_id, week: due, qty: q, source: `WO-${w.id}` });
    if (w.status === 'planned' && byId[w.item_id]) firm.push({ item_id: w.item_id, week: due - byId[w.item_id].lt, qty: q, source: `WO-${w.id}` });
  });

  const rec = runMRP({ items, bom: S.refs.bom.map((b) => ({ ...b, qty: Number(b.qty) })), gross, sr, firm }, W);
  const active = Object.values(rec).filter((r) => r.gr.some((v) => v) || r.sr.some((v) => v) || r.porc.some((v) => v));
  const planned = active.flatMap((r) => r.planned.map((p) => ({ ...p, item: r.item })))
    .sort((a, b) => a.releaseWeek - b.releaseWeek || a.item.level - b.item.level);
  const shown = active.filter((r) => st.filter === 'all' || r.planned.length)
    .sort((a, b) => a.item.level - b.item.level || a.item.sku.localeCompare(b.item.sku));
  const mpsItems = [...new Set(gross.map((g) => g.item_id))].map((id) => byId[id]).filter(Boolean)
    .sort((a, b) => (b.isParent - a.isParent) || a.sku.localeCompare(b.sku));
  const weeks = Array.from({ length: W }, (_, i) => i + 1);
  const qLabel = (it) => (it.rule === 'FOQ' ? `FOQ ${it.foq}` : 'L4L');
  const n = (v) => (Number(v) ? num(v) : '');

  body.innerHTML = `
  <div class="toolbar">
    <div class="chips">${[4, 6, 8].map((w) => `<button class="chip ${w === W ? 'on' : ''}" data-w="${w}">${w}-week horizon</button>`).join('')}</div>
    <span class="muted small">Week 1 starts today (${short(t)}). Lead times are rounded up to whole weeks.</span>
  </div>

  <div class="mrp-flow">
    <div class="mrp-box">Bill of Materials</div><div class="mrp-box">Master Production Schedule</div><div class="mrp-box">Inventory Status File</div>
    <div class="mrp-arrow">↓ ↓ ↓</div><div class="mrp-box sys">MRP System → planned order releases</div>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="kpi-l">MPS lines in horizon</div><div class="kpi-v">${gross.length}</div><div class="kpi-s">confirmed sales orders</div></div>
    <div class="kpi ${planned.length ? 'warn' : 'good'}"><div class="kpi-l">Planned orders</div><div class="kpi-v">${planned.length}</div><div class="kpi-s">net requirements to cover</div></div>
    <div class="kpi ${planned.some((p) => p.releaseWeek < 1) ? 'bad' : 'good'}"><div class="kpi-l">Past-due releases</div><div class="kpi-v">${planned.filter((p) => p.releaseWeek < 1).length}</div><div class="kpi-s">expedite these</div></div>
    <div class="kpi"><div class="kpi-l">Releases this week</div><div class="kpi-v">${planned.filter((p) => p.releaseWeek === 1).length}</div><div class="kpi-s">order / start in week 1</div></div>
  </div>

  <div class="card"><h3>1 · Master Production Schedule <span class="r muted small">gross requirements for level-0 items, from confirmed sales orders</span></h3>
    ${mpsItems.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Item</th>${weeks.map((w) => `<th class="num">${w}<div class="muted small">${short(wkStart(w))}</div></th>`).join('')}<th class="num">Total</th></tr></thead><tbody>
      ${mpsItems.map((it) => { const r = rec[it.id]; return `<tr><td><b>${esc(it.sku)}</b> <span class="muted small">${esc(it.name)}</span></td>${weeks.map((w) => `<td class="num" title="${esc(r.grSources[w].filter((x) => x.startsWith('SO')).join(', '))}">${n(gross.filter((g) => g.item_id === it.id && g.week === w).reduce((a, g) => a + g.qty, 0))}</td>`).join('')}<td class="num"><b>${num(gross.filter((g) => g.item_id === it.id).reduce((a, g) => a + g.qty, 0))}</b></td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="empty">No confirmed sales orders in the horizon</div>'}
  </div>

  <div class="card"><h3>2 · Bill of Materials <span class="r muted small">Q = quantity per parent · L = lead time · lot rule</span></h3>
    <div class="bom-trees">${S.refs.items.filter((i) => parents.has(i.id)).map((p) => {
      const pi = byId[p.id];
      return `<div class="bom-tree"><div class="lvl">Level 0</div>
        <div class="node parent"><b>${esc(p.name)}</b><span>${qLabel(pi)} · L=${pi.lt} wk</span></div>
        <div class="kids">${bomOf(p.id).map((b) => { const c = byId[b.component_id]; return `<div class="node"><b>${esc(c.name)}</b><span>Q=${num(b.qty)} · L=${c.lt} wk · ${qLabel(c)}</span></div>`; }).join('')}</div>
        <div class="lvl">Level 1</div></div>`;
    }).join('')}</div>
  </div>

  <div class="card"><h3>3 · Inventory Status File <span class="r muted small">items in this plan</span></h3>
    ${table([
      { k: 'sku', label: 'Item', f: (v, r) => `<b>${esc(v)}</b> <span class="muted small">${esc(r.name)}</span>` },
      { k: 'level', label: 'BOM level', cls: 'num' },
      { k: 'onHand', label: 'Beginning on hand', cls: 'num', f: (v) => num(v) },
      { k: 'id', label: 'Scheduled receipts', f: (v) => sr.filter((x) => x.item_id === v).map((x) => `${num(x.qty)} in wk ${x.week} <span class="muted small">(${x.source})</span>`).join('<br>') || '<span class="muted">none</span>' },
      { k: 'lt', label: 'Lead time', cls: 'num', f: (v, r) => `${v} wk <span class="muted small">(${r.ltDays} d)</span>` },
      { k: 'rule', label: 'Order quantity', f: (v, r) => (v === 'FOQ' ? `FOQ ${r.foq}` : 'Lot for lot') },
    ], active.map((r) => r.item).sort((a, b) => a.level - b.level || a.sku.localeCompare(b.sku)))}
  </div>

  <div class="card"><h3>4 · Planned order report <span class="r"><button class="btn sm primary" id="mrp-po">Create all purchase orders</button></span></h3>
  ${table([
    { k: 'item', label: 'Item', f: (v) => `<b>${esc(v.sku)}</b> <span class="muted small">${esc(v.name)}</span>` },
    { k: 'item', label: 'Level', cls: 'num', f: (v) => v.level },
    { k: 'net', label: 'Net req.', cls: 'num', f: (v) => num(v) },
    { k: 'qty', label: 'Order qty', cls: 'num', f: (v, r) => `<b>${num(v)}</b> <span class="muted small">${qLabel(r.item)}</span>` },
    { k: 'needWeek', label: 'Receive in', f: (v) => `wk ${v} <span class="muted small">(${short(wkStart(v))})</span>` },
    { k: 'item', label: 'LT', cls: 'num', f: (v) => `${v.lt} wk` },
    { k: 'releaseWeek', label: 'Release in', f: (v) => (v >= 1 ? `<b>wk ${v}</b> <span class="muted small">(${short(wkStart(v))})</span>` : '<b class="neg">past due</b>') },
    { k: 'releaseWeek', label: 'Status', f: (v) => (v < 1 ? badge('expedite', 'red') : v === 1 ? badge('release now', 'amber') : badge(`${v - 1} wk slack`, 'green')) },
    { k: 'item', label: '', f: (v, r) => `<button class="btn sm" data-po="${v.id}" data-q="${r.qty}">${v.isParent ? 'Create WO' : 'Create PO'}</button>` },
  ], planned, { empty: 'No net requirements: on hand and scheduled receipts cover every confirmed order 👍' })}</div>

  <div class="toolbar" style="margin-top:16px">
    <h3 style="font-size:15px">5 · MRP records</h3>
    <div class="chips"><button class="chip ${st.filter === 'action' ? 'on' : ''}" data-f="action">Items with planned orders</button><button class="chip ${st.filter === 'all' ? 'on' : ''}" data-f="all">All items in the plan</button></div>
  </div>
  <div class="grid g2">${shown.map((r) => {
    const it = r.item;
    const lbl = (txt) => `<tr class="lbl"><td>${txt}</td>${'<td></td>'.repeat(W + 1)}</tr>`;
    const row = (name, arr, start = '', cls = '') => `<tr class="${cls}"><td>${name}</td><td class="num start">${start}</td>${weeks.map((w) => `<td class="num" ${name === 'Gross Requirements' && r.grSources[w].length ? `title="${esc(r.grSources[w].join('\n'))}"` : ''}>${n(arr[w])}</td>`).join('')}</tr>`;
    return `<div class="card mrp-rec">
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th></th><th class="num">Start</th>${weeks.map((w) => `<th class="num">${w}</th>`).join('')}</tr></thead><tbody>
        ${lbl(`<b>${esc(it.sku)}</b> <span class="muted small">${esc(it.name)}</span>`)}
        ${lbl(`LT = ${it.lt}`)}
        ${lbl(`Q: ${qLabel(it)}`)}
        ${lbl('&nbsp;')}
        ${row('Gross Requirements', r.gr)}
        ${row('Scheduled receipts', r.sr)}
        <tr><td>Projected on hand</td><td class="num start"><b>${num(r.poh[0])}</b></td>${weeks.map((w) => `<td class="num">${num(r.poh[w])}</td>`).join('')}</tr>
        ${row('Net Requirements', r.nr, '', 'nr')}
        ${row('Planned order receipts', r.porc)}
        ${row('Planned order releases', r.porl, r.porl[0] ? `<span class="neg" title="past due: expedite">${num(r.porl[0])}</span>` : '', 'rel')}
      </tbody></table></div>
      <p class="muted small" style="margin:6px 0 0">Level ${it.level}${it.isParent ? ' parent: releases explode into ' + bomOf(it.id).map((b) => `${num(b.qty)}× ${esc(byId[b.component_id].sku)}`).join(', ') : ' · gross requirements = ' + S.refs.bom.filter((b) => b.component_id === it.id).map((b) => `${esc(byId[b.parent_id].sku)} releases × ${num(b.qty)}`).join(' + ') + (gross.some((g) => g.item_id === it.id) ? ' + its own sales orders' : '')}. Hover a gross requirement to see where it comes from.</p>
    </div>`;
  }).join('') || '<div class="empty">Nothing to show</div>'}</div>

  <div class="card"><h3>Definitions <span class="r muted small">as used in GSCM 401</span></h3><div class="formula">
    Gross requirements: quantity needed each week. Level 1 = parent's planned order releases × quantity per parent<br>
    Scheduled receipts: already ordered (open PO / work order), arriving at the start of the week<br>
    Projected on hand = prior on hand + scheduled receipts + planned order receipts − gross requirements<br>
    Net requirements = gross requirements − scheduled receipts − prior projected on hand (never below 0)<br>
    Planned order receipts: L4L = the net requirement; FOQ = enough lots of the fixed quantity to cover it<br>
    Planned order releases: the planned receipt moved earlier by the lead time. Once placed it becomes a scheduled receipt</div></div>`;

  body.querySelectorAll('[data-w]').forEach((b) => (b.onclick = () => { st.weeks = Number(b.dataset.w); mrp(body); }));
  body.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { st.filter = b.dataset.f; mrp(body); }));
  $('#mrp-po', body).onclick = () => createPOs(planned.filter((p) => !p.item.isParent).map((p) => ({ item_id: p.item.id, item_type: 'buy', supplier_id: item(p.item.id).supplier_id, qty: p.qty })), 'qty');
  body.querySelectorAll('[data-po]').forEach((b) => (b.onclick = () => {
    const it = item(Number(b.dataset.po));
    if (bomOf(it.id).length) newWO({ item: it.id, qty: Number(b.dataset.q), loc: 3 });
    else newPO({ supplier: it.supplier_id, lines: [{ item_id: it.id, qty: Math.ceil(Number(b.dataset.q)) }], notes: 'MRP planned order' });
  }));
}
