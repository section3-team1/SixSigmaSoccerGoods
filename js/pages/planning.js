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

const st = { tab: 'mrp', filter: 'action', weeks: 4 };

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
  const [rows, soLines, openPOs] = await Promise.all([
    rpc('mrp_plan', { p_weeks: st.weeks }),
    sel('v_so_lines', 'so_id,item_id,remaining,requested_date,status,customer_id', (q) => q.eq('status', 'placed').lt('requested_date', addDays(t, 7 * st.weeks)).order('requested_date')),
    sel('v_po_summary', 'id,supplier_name,expected_date,status', (q) => q.in('status', ['sent', 'partial'])),
  ]);
  const by = {};
  rows.forEach((r) => (by[r.item_id] ||= { ...r, weeks: [] }).weeks.push(r));
  const bucket = (d) => Math.min(st.weeks, Math.max(1, Math.floor(daysBetween(t, d) / 7) + 1));
  const planned = rows.filter((r) => r.net_req > 0).map((r) => ({
    ...r, late: r.order_by < t, slack: daysBetween(t, r.order_by), release_week: bucket(r.order_by),
  })).sort((a, b) => (a.order_by < b.order_by ? -1 : 1));
  const items = Object.values(by).filter((x) => st.filter === 'all' || x.weeks.some((w) => w.net_req > 0));
  const weeksHdr = rows.filter((r) => r.item_id === rows[0]?.item_id);

  body.innerHTML = `
  <div class="grid g2">
    <div class="note"><b>How this MRP works</b> (single-level BOMs, lot-for-lot, weekly buckets)
      <div class="formula">1. Gross requirements: parent quantities on confirmed (placed) sales orders<br>
      2. Net parents: − on hand − open work orders → planned build orders<br>
      3. Explode: planned builds × BOM qty per unit → component gross requirements<br>
      4. Net components: − on hand − open PO quantities (scheduled receipts)<br>
      5. Order-by date = need date − item lead time</div></div>
    <div class="kpis" style="margin:0;align-content:start">
      <div class="kpi"><div class="kpi-l">Confirmed SO lines in horizon</div><div class="kpi-v">${soLines.length}</div><div class="kpi-s">next ${st.weeks} weeks</div></div>
      <div class="kpi ${planned.length ? 'warn' : 'good'}"><div class="kpi-l">Planned orders</div><div class="kpi-v">${planned.length}</div><div class="kpi-s">net requirements to cover</div></div>
      <div class="kpi ${planned.some((p) => p.late) ? 'bad' : 'good'}"><div class="kpi-l">Expedite</div><div class="kpi-v">${planned.filter((p) => p.late).length}</div><div class="kpi-s">order-by date already passed</div></div>
      <div class="kpi"><div class="kpi-l">Open POs (scheduled receipts)</div><div class="kpi-v">${openPOs.length}</div><div class="kpi-s">${openPOs.filter((p) => p.expected_date < t).length} past expected date</div></div>
    </div>
  </div>

  <div class="card"><h3>Planned order report <span class="r"><button class="btn sm primary" id="mrp-po">Create all purchase orders</button></span></h3>
  ${table([
    { k: 'sku', label: 'Item', f: (v, r) => `<b>${esc(v)}</b> <span class="muted small">${esc(r.name)}</span>` },
    { k: 'mrp_level', label: 'Level', cls: 'num', f: (v, r) => (r.item_type === 'kit' ? '0 · parent' : v === 1 ? '1 · component' : '0 · product') },
    { k: 'net_req', label: 'Net requirement', cls: 'num', f: (v) => `<b>${num(v)}</b>` },
    { k: 'need_date', label: 'Needed by', f: (v) => fdate(v) },
    { k: 'lead_time_days', label: 'Lead time', cls: 'num', f: (v) => v + ' d' },
    { k: 'order_by', label: 'Order / release by', f: (v, r) => `<b>${fdate(v)}</b>` },
    { k: 'slack', label: 'Status', f: (v, r) => (r.late ? badge(`expedite: ${-v} d late`, 'red') : v <= 3 ? badge(`release in ${v} d`, 'amber') : badge(`${v} days slack`, 'green')) },
    { k: 'supplier_name', label: 'Source', f: (v, r) => (r.item_type === 'kit' ? 'Build: print shop / kitting' : esc(v || '')) },
    { k: 'item_id', label: '', f: (v, r) => `<button class="btn sm" data-po="${v}" data-q="${r.net_req}">${r.item_type === 'kit' ? 'Create WO' : 'Create PO'}</button>` },
  ], planned, { empty: 'No net requirements: on hand and open orders cover every confirmed sales order 👍' })}</div>

  <div class="toolbar" style="margin-top:16px">
    <h3 style="font-size:15px">Time-phased records</h3>
    <div class="chips"><button class="chip ${st.filter === 'action' ? 'on' : ''}" data-f="action">Items with net requirements</button><button class="chip ${st.filter === 'all' ? 'on' : ''}" data-f="all">All items with demand or receipts</button></div>
  </div>
  ${items.map((x) => {
    const rel = Array(st.weeks).fill(0);
    x.weeks.filter((w) => w.net_req > 0).forEach((w) => (rel[bucket(w.order_by) - 1] += Number(w.net_req)));
    const cell = (v, cls = '') => `<td class="num ${cls}">${Number(v) ? num(v) : '<span class="muted">·</span>'}</td>`;
    const parents = S.refs.bom.filter((b) => b.component_id === x.item_id).map((b) => item(b.parent_id).sku);
    return `<div class="card mrp">
      <div class="mrp-h"><b>${esc(x.sku)} · ${esc(x.name)}</b>
        <span class="muted small">Level ${x.mrp_level} · LT ${x.lead_time_days} d · on hand ${num(x.on_hand)} · lot-for-lot${parents.length ? ' · used in ' + parents.join(', ') : ''}${x.item_type === 'kit' ? ' · BOM: ' + bomOf(x.item_id).map((b) => `${num(b.qty)}× ${item(b.component_id).sku}`).join(', ') : ''}</span></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Week of</th>${x.weeks.map((w) => `<th class="num">${fdate(w.week_start).replace(/, \d{4}/, '')}</th>`).join('')}</tr></thead><tbody>
        <tr><td>Gross requirements</td>${x.weeks.map((w) => cell(w.gross)).join('')}</tr>
        <tr><td>Scheduled receipts</td>${x.weeks.map((w) => cell(w.sched_receipts)).join('')}</tr>
        <tr><td>Projected on hand</td>${x.weeks.map((w) => `<td class="num">${num(w.projected_oh)}</td>`).join('')}</tr>
        <tr><td><b>Net requirements</b></td>${x.weeks.map((w) => cell(w.net_req, w.net_req > 0 ? 'neg' : '')).join('')}</tr>
        <tr><td>Planned order receipts</td>${x.weeks.map((w) => cell(w.net_req)).join('')}</tr>
        <tr><td><b>Planned order releases</b></td>${rel.map((v) => cell(v, v > 0 ? 'pos-v' : '')).join('')}</tr>
      </tbody></table></div></div>`;
  }).join('') || '<div class="empty">Nothing to show</div>'}

  <div class="card"><h3>Where the demand comes from: confirmed sales orders in the horizon</h3>${table([
    { k: 'so_id', label: 'SO', f: (v) => `<a href="#/orders">${docNo('SO', v)}</a>` },
    { k: 'customer_id', label: 'Customer', f: (v) => esc(cust(v)?.name || '') },
    { k: 'item_id', label: 'Item', f: (v) => `${esc(item(v).sku)} — ${esc(item(v).name)}` },
    { k: 'remaining', label: 'Qty', cls: 'num', f: (v) => num(v) },
    { k: 'requested_date', label: 'Requested', f: (v) => fdate(v) },
    { k: 'item_id', label: 'Explodes into', f: (v, r) => bomOf(v).map((b) => `${num(b.qty * r.remaining)} ${item(b.component_id).sku}`).join(', ') || '<span class="muted">(no BOM, bought finished)</span>' },
  ], soLines)}</div>`;

  body.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { st.filter = b.dataset.f; mrp(body); }));
  $('#mrp-po', body).onclick = () => createPOs(planned.filter((p) => p.item_type !== 'kit').map((p) => ({ ...p, supplier_id: item(p.item_id).supplier_id })), 'net_req');
  body.querySelectorAll('[data-po]').forEach((b) => (b.onclick = () => {
    const it = item(Number(b.dataset.po));
    if (it.item_type === 'kit') newWO({ item: it.id, qty: Number(b.dataset.q), loc: 3 });
    else newPO({ supplier: it.supplier_id, lines: [{ item_id: it.id, qty: Math.ceil(Number(b.dataset.q)) }], notes: 'MRP planned order' });
  }));
}
