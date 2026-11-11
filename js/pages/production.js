// Production orders — issue components per BOM, complete with good / scrap / rework,
// rolled-up cost, and a production + quality report over any date range.
import {
  S, sel, rpc, money, num, pct, esc, act, modal, options, table, badge, tabs, fdate, fdt, docNo, item, loc, locLabel,
  itemLabel, reasons, bomOf, today, addDays, kpi, chart, COLORS, refresh, $, sigmaLevel,
} from '../lib.js';

const st = { tab: 'orders', status: 'open', from: addDays(today(), -89), to: today() };

export async function render(view) {
  view.innerHTML = `${tabs('wo', [['orders', 'Production orders'], ['boms', 'Bills of material'], ['report', 'Production report']], st.tab)}<div id="wo-body"></div>`;
  view.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { st.tab = b.dataset.tab; render(view); }));
  const body = $('#wo-body', view);
  if (st.tab === 'orders') await orders(body);
  if (st.tab === 'boms') await boms(body);
  if (st.tab === 'report') await report(body);
}

const kits = () => S.refs.items.filter((i) => bomOf(i.id).length);
const hrs = (a, b) => (a && b ? (new Date(b) - new Date(a)) / 3600000 : null);

async function orders(body) {
  const rows = await sel('production_orders', '*', (q) => {
    q = q.order('id', { ascending: false }).limit(150);
    if (st.status === 'open') q = q.in('status', ['planned', 'in_progress']);
    else if (st.status !== 'all') q = q.eq('status', st.status);
    return q;
  });
  body.innerHTML = `
  <div class="toolbar">
    <div class="chips">${[['open', 'Open'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['all', 'All']]
      .map(([k, l]) => `<button class="chip ${k === st.status ? 'on' : ''}" data-st="${k}">${l}</button>`).join('')}</div>
    <span class="grow"></span><button class="btn primary" id="wo-new">+ New production order</button>
  </div>
  <div class="card">${table([
    { k: 'id', label: 'WO', f: (v, r) => `<b>${docNo('WO', v)}</b>${r.auto ? ' <span class="badge gray">kitted at POS</span>' : ''}` },
    { k: 'item_id', label: 'Item', f: (v) => esc(item(v).name) },
    { k: 'location_id', label: 'Loc', f: (v) => esc(loc(v)?.code) },
    { k: 'qty_planned', label: 'Planned', cls: 'num', f: (v) => num(v) },
    { k: 'qty_started', label: 'Started', cls: 'num', f: (v) => num(v) },
    { k: 'qty_good', label: 'Good', cls: 'num', f: (v) => num(v) },
    { k: 'qty_scrap', label: 'Scrap', cls: 'num', f: (v, r) => (v > 0 ? `<span class="neg">${num(v)}</span> <span class="muted small">${esc(r.scrap_reason)}</span>` : '0') },
    { k: 'qty_rework', label: 'Rework', cls: 'num', f: (v, r) => (v > 0 ? `${num(v)} <span class="muted small">${esc(r.rework_reason)}</span>` : '0') },
    { k: 'unit_cost', label: 'Unit cost', cls: 'num', f: (v, r) => (r.status === 'completed' ? money(v) : '—') },
    { k: 'due_date', label: 'Due', f: (v) => fdate(v) },
    { k: 'so_id', label: 'For order', f: (v) => (v ? docNo('SO', v) : '<span class="muted">stock</span>') },
    { k: 'status', label: 'Status', f: (v) => badge(v) },
  ], rows, { rowAttr: (r) => `class="click" data-wo="${r.id}"`, empty: 'No production orders here' })}</div>`;
  body.querySelectorAll('[data-st]').forEach((b) => (b.onclick = () => { st.status = b.dataset.st; orders(body); }));
  $('#wo-new', body).onclick = () => newWO();
  body.querySelectorAll('[data-wo]').forEach((r) => (r.onclick = () => openWO(Number(r.dataset.wo))));
}

export function newWO(preset = {}) {
  modal({
    title: 'New production order',
    body: `<label>Item to make / kit<select name="item">${options(kits(), preset.item, itemLabel)}</select></label>
      <div class="row3"><label>Location<select name="loc">${options(S.refs.locations.filter((l) => l.kind !== 'qc'), preset.loc || 3, locLabel)}</select></label>
      <label>Quantity<input name="qty" type="number" min="1" value="${preset.qty || 10}"></label>
      <label>Due date<input name="due" type="date" value="${preset.due || addDays(today(), 2)}"></label></div>
      <label>Notes<input name="notes" placeholder="optional"></label>`,
    okText: 'Create',
    onOk: async (el) => {
      const v = (n) => el.querySelector(`[name=${n}]`).value;
      const id = await rpc('create_production_order', { p_item: Number(v('item')), p_loc: Number(v('loc')), p_qty: Number(v('qty')), p_due: v('due'), p_notes: v('notes') || null });
      refresh(); setTimeout(() => openWO(id), 300);
    },
  });
}

export async function openWO(id) {
  const [w] = await sel('production_orders', '*', (q) => q.eq('id', id));
  const it = item(w.item_id);
  const b = bomOf(w.item_id);
  const inv = await sel('inventory', 'item_id,qty', (q) => q.eq('location_id', w.location_id).in('item_id', b.map((x) => x.component_id)));
  const oh = Object.fromEntries(inv.map((r) => [r.item_id, Number(r.qty)]));
  const qty = w.status === 'planned' ? w.qty_planned : w.qty_started;
  const canBuild = Math.min(...b.map((x) => Math.floor((oh[x.component_id] || 0) / x.qty)));
  const m = modal({
    title: `${docNo('WO', w.id)} · ${esc(it.name)}`, wide: true, hideOk: true, cancelText: 'Close',
    body: `
    <div class="kpis">
      ${kpi('Status', badge(w.status))}
      ${kpi('Quantity', num(qty), w.status === 'planned' ? 'planned' : 'started')}
      ${kpi('Location', esc(loc(w.location_id).code), esc(loc(w.location_id).name))}
      ${kpi('Due', fdate(w.due_date), w.so_id ? 'for ' + docNo('SO', w.so_id) : 'make to stock')}
      ${w.status === 'completed' ? kpi('Rolled-up unit cost', money(w.unit_cost), `${money(w.component_cost)} ÷ ${num(w.qty_good)} good`) : ''}
    </div>
    <h4 style="margin-bottom:8px">Bill of material: components ${w.status === 'planned' ? 'to issue' : 'issued'}</h4>
    ${table([
      { k: 'component_id', label: 'Component', f: (v) => `${esc(item(v).sku)} — ${esc(item(v).name)}` },
      { k: 'qty', label: 'Per unit', cls: 'num', f: (v) => num(v, 2) },
      { k: 'qty', label: 'Required', cls: 'num', f: (v) => num(v * qty) },
      { k: 'component_id', label: `On hand @ ${esc(loc(w.location_id).code)}`, cls: 'num', f: (v, r) => { const n = oh[v] || 0; return n < r.qty * qty && w.status === 'planned' ? `<span class="neg">${num(n)}</span>` : num(n); } },
      { k: 'component_id', label: 'Avg cost', cls: 'num', f: (v) => money(item(v).avg_cost) },
      { k: 'qty', label: 'Extended', cls: 'num', f: (v, r) => money(v * qty * item(r.component_id).avg_cost) },
    ], b)}
    ${w.status === 'planned' ? `
      <div class="inline" style="margin-top:14px">
        <label>Quantity to start<input id="wo-start-q" type="number" min="1" value="${w.qty_planned}"></label>
        <button class="btn primary" id="wo-start">Start: issue components</button>
        <button class="btn danger" id="wo-cancel">Cancel WO</button>
      </div>
      <p class="muted small">Components here support up to <b>${num(canBuild)}</b> units. Starting consumes them from inventory at weighted-average cost.</p>` : ''}
    ${w.status === 'in_progress' ? `
      <h4 style="margin:14px 0 8px">Complete: record results</h4>
      <div class="row3">
        <label>Good units<input id="wo-good" type="number" min="0" value="${w.qty_started}"></label>
        <label>Scrapped units<input id="wo-scrap" type="number" min="0" value="0"></label>
        <label>Of the good, reworked<input id="wo-rew" type="number" min="0" value="0"></label>
      </div>
      <div class="row2">
        <label>Scrap reason<select id="wo-sr"><option value="">—</option>${reasons('scrap').map((r) => `<option value="${r.code}">${r.code} — ${esc(r.description)}</option>`).join('')}</select></label>
        <label>Rework reason<select id="wo-rr"><option value="">—</option>${reasons('rework').map((r) => `<option value="${r.code}">${r.code} — ${esc(r.description)}</option>`).join('')}</select></label>
      </div>
      <p class="note">Good + scrapped must equal the ${num(w.qty_started)} started. Scrap cost is absorbed by the good units, so <b>unit cost = component cost ÷ good units</b>.</p>
      <button class="btn primary" id="wo-done">Complete & receive to inventory</button>` : ''}
    ${w.status === 'completed' ? `<div class="note" style="margin-top:12px">Started ${fdt(w.started_at)} · Finished ${fdt(w.finished_at)} · Cycle time ${num(hrs(w.started_at, w.finished_at), 1)} h ·
      Yield ${pct(w.qty_good / w.qty_started)} · First-pass yield ${pct((w.qty_good - w.qty_rework) / w.qty_started)} · Scrap cost ${money(w.scrap_cost)}${w.notes ? '<br>' + esc(w.notes) : ''}</div>` : ''}`,
  });
  const reopen = () => { m.close(); refresh(); setTimeout(() => openWO(id), 300); };
  $('#wo-start', m.el)?.addEventListener('click', (e) => act(e.currentTarget, () => rpc('start_production', { p_wo: id, p_qty_started: Number($('#wo-start-q', m.el).value) }), 'Components issued — WO in progress').then(reopen).catch(() => {}));
  $('#wo-cancel', m.el)?.addEventListener('click', (e) => act(e.currentTarget, () => rpc('cancel_production', { p_wo: id }), 'Cancelled').then(reopen).catch(() => {}));
  const good = $('#wo-good', m.el), scrap = $('#wo-scrap', m.el);
  if (good) {
    good.oninput = () => (scrap.value = Math.max(0, w.qty_started - Number(good.value)));
    scrap.oninput = () => (good.value = Math.max(0, w.qty_started - Number(scrap.value)));
  }
  $('#wo-done', m.el)?.addEventListener('click', (e) => act(e.currentTarget, () => rpc('complete_production', {
    p_wo: id, p_good: Number(good.value), p_scrap: Number(scrap.value), p_rework: Number($('#wo-rew', m.el).value),
    p_scrap_reason: $('#wo-sr', m.el).value || null, p_rework_reason: $('#wo-rr', m.el).value || null,
  }), 'Completed — finished goods received at rolled-up cost').then(reopen).catch(() => {}));
}

async function boms(body) {
  const inv = await sel('inventory', 'item_id,location_id,qty');
  const oh = (i, l) => Number(inv.find((r) => r.item_id === i && r.location_id === l)?.qty || 0);
  body.innerHTML = `<div class="grid g2">${kits().map((k) => {
    const b = bomOf(k.id);
    const cost = b.reduce((a, x) => a + x.qty * item(x.component_id).avg_cost, 0);
    const build = (l) => Math.min(...b.map((x) => Math.floor(oh(x.component_id, l) / x.qty)));
    return `<div class="card"><h3>${esc(k.name)} <span class="r">${k.auto_assemble ? badge('kit at counter or warehouse', 'teal') : badge('made to order: print shop', 'violet')}</span></h3>
      ${table([
        { k: 'component_id', label: 'Component', f: (v) => `${esc(item(v).sku)} — ${esc(item(v).name)}` },
        { k: 'qty', label: 'Qty / unit', cls: 'num', f: (v) => num(v) },
        { k: 'component_id', label: 'Lead time', cls: 'num', f: (v) => item(v).lead_time_days + ' d' },
        { k: 'component_id', label: 'Avg cost', cls: 'num', f: (v) => money(item(v).avg_cost) },
        { k: 'qty', label: 'Extended', cls: 'num', f: (v, r) => money(v * item(r.component_id).avg_cost) },
      ], b, { foot: `<tfoot><tr><td colspan="4">Rolled-up material cost</td><td class="num">${money(cost)}</td></tr></tfoot>` })}
      <p class="muted small" style="margin:8px 0 0">Price ${money(k.price)} · margin ${money(k.price - cost)} (${num(((k.price - cost) / k.price) * 100, 0)}%) ·
      can build now: ${S.refs.locations.filter((l) => l.kind !== 'qc').map((l) => `${l.code} ${build(l.id)}`).join(' · ')}</p></div>`;
  }).join('')}</div>`;
}

async function report(body) {
  const rows = await sel('production_orders', '*', (q) => q.eq('status', 'completed').eq('auto', false)
    .gte('finished_at', st.from + 'T00:00:00').lte('finished_at', st.to + 'T23:59:59').order('finished_at', { ascending: false }));
  const sum = (k) => rows.reduce((a, r) => a + Number(r[k]), 0);
  const started = sum('qty_started'), good = sum('qty_good'), scrap = sum('qty_scrap'), rework = sum('qty_rework');
  const opps = rows.reduce((a, r) => a + r.qty_started * item(r.item_id).defect_opportunities, 0);
  const dpmo = opps ? ((scrap + rework) / opps) * 1e6 : 0;
  const cyc = rows.map((r) => hrs(r.started_at, r.finished_at)).filter((x) => x != null);
  const onTime = rows.filter((r) => r.due_date && r.finished_at.slice(0, 10) <= r.due_date).length;
  const byItem = {};
  rows.forEach((r) => { const x = (byItem[r.item_id] ||= { item_id: r.item_id, orders: 0, started: 0, good: 0, scrap: 0, rework: 0, cost: 0 });
    x.orders++; x.started += +r.qty_started; x.good += +r.qty_good; x.scrap += +r.qty_scrap; x.rework += +r.qty_rework; x.cost += +r.component_cost; });

  body.innerHTML = `
  <div class="toolbar">
    <label style="margin:0">From<input type="date" id="pr-from" value="${st.from}"></label>
    <label style="margin:0">To<input type="date" id="pr-to" value="${st.to}"></label>
    <span class="muted small">Completed work orders in range (excludes bundles kitted at the counter)</span>
  </div>
  <div class="kpis">
    ${kpi('Work orders completed', num(rows.length), `${num(good)} good units`)}
    ${kpi('Yield', pct(started ? good / started : null), 'good ÷ started')}
    ${kpi('First-pass yield', pct(started ? (good - rework) / started : null), 'right first time')}
    ${kpi('Scrap rate', pct(started ? scrap / started : null), `${num(scrap)} units · ${money(sum('scrap_cost'))}`, 'warn')}
    ${kpi('Rework rate', pct(started ? rework / started : null), `${num(rework)} units`)}
    ${kpi('Avg cycle time', num(cyc.length ? cyc.reduce((a, b) => a + b, 0) / cyc.length : null, 1) + ' h', 'start → finish')}
    ${kpi('On-time completion', pct(rows.length ? onTime / rows.length : null), 'finished by due date')}
    ${kpi('DPMO / Sigma', `${num(dpmo)} / ${num(sigmaLevel(dpmo), 2)}σ`, 'defects per million opportunities')}
  </div>
  <div class="card"><h3>By item</h3>${table([
    { k: 'item_id', label: 'Item', f: (v) => esc(item(v).name) },
    { k: 'orders', label: 'WOs', cls: 'num' },
    { k: 'started', label: 'Started', cls: 'num', f: (v) => num(v) },
    { k: 'good', label: 'Good', cls: 'num', f: (v) => num(v) },
    { k: 'scrap', label: 'Scrap', cls: 'num', f: (v) => num(v) },
    { k: 'rework', label: 'Rework', cls: 'num', f: (v) => num(v) },
    { k: 'good', label: 'Yield', cls: 'num', f: (v, r) => pct(v / r.started) },
    { k: 'cost', label: 'Avg unit cost', cls: 'num', f: (v, r) => money(v / r.good) },
  ], Object.values(byItem))}</div>
  <div class="card"><h3>Work orders <span class="r muted small">${rows.length} orders</span></h3><div class="scroll">${table([
    { k: 'id', label: 'WO', f: (v) => docNo('WO', v) },
    { k: 'item_id', label: 'Item', f: (v) => esc(item(v).sku) },
    { k: 'started_at', label: 'Started', f: (v) => fdt(v) },
    { k: 'finished_at', label: 'Finished', f: (v) => fdt(v) },
    { k: 'qty_started', label: 'Started', cls: 'num', f: (v) => num(v) },
    { k: 'qty_good', label: 'Good', cls: 'num', f: (v) => num(v) },
    { k: 'qty_scrap', label: 'Scrap', cls: 'num', f: (v, r) => `${num(v)} ${v > 0 ? `<span class="muted small">${esc(r.scrap_reason)}</span>` : ''}` },
    { k: 'qty_rework', label: 'Rework', cls: 'num', f: (v) => num(v) },
    { k: 'unit_cost', label: 'Unit cost', cls: 'num', f: (v) => money(v) },
    { k: 'notes', label: 'Notes', f: (v) => `<span class="muted small">${esc(v || '')}</span>` },
  ], rows)}</div></div>`;
  $('#pr-from', body).onchange = (e) => { st.from = e.target.value; report(body); };
  $('#pr-to', body).onchange = (e) => { st.to = e.target.value; report(body); };
}
