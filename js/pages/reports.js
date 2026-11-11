// Manager reports — sales by day/week, top sellers, low stock with order-by dates,
// inventory by location, supplier lead-time performance, sales by store.
import { S, sel, rpc, money, money0, num, pct, esc, table, badge, tabs, today, addDays, fdate, chart, COLORS, $, item, loc } from '../lib.js';

const st = { tab: 'sales', grain: 'day', from: addDays(today(), -29), to: today() };

export async function render(view) {
  view.innerHTML = `${tabs('rp', [['sales', 'Sales'], ['top', 'Top sellers'], ['low', 'Low stock & reorder'], ['loc', 'Inventory by location'], ['sup', 'Supplier performance']], st.tab)}
  <div class="toolbar" id="rp-range">
    <label style="margin:0">From<input type="date" id="rp-from" value="${st.from}"></label>
    <label style="margin:0">To<input type="date" id="rp-to" value="${st.to}"></label>
    <div class="chips">${[['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['182', '6 months']].map(([d, l]) => `<button class="chip" data-d="${d}">${l}</button>`).join('')}</div>
  </div><div id="rp-body"></div>`;
  view.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { st.tab = b.dataset.tab; render(view); }));
  $('#rp-from', view).onchange = (e) => { st.from = e.target.value; render(view); };
  $('#rp-to', view).onchange = (e) => { st.to = e.target.value; render(view); };
  view.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => { st.from = addDays(today(), -(Number(b.dataset.d) - 1)); st.to = today(); render(view); }));
  if (['low', 'loc'].includes(st.tab)) $('#rp-range', view).classList.add('hidden');
  const body = $('#rp-body', view);
  await ({ sales, top, low, locs, sup })[{ sales: 'sales', top: 'top', low: 'low', loc: 'locs', sup: 'sup' }[st.tab]](body);
}

async function sales(body) {
  const [rows, byStore] = await Promise.all([
    rpc('sales_by_period', { p_from: st.from, p_to: st.to, p_grain: st.grain }),
    sel('sales', 'location_id,subtotal,discount_total,cogs', (q) => q.gte('ts', st.from + 'T00:00:00-07:00').lte('ts', st.to + 'T23:59:59-07:00').limit(20000)),
  ]);
  const tot = rows.reduce((a, r) => ({ o: a.o + Number(r.orders), u: a.u + Number(r.units), rev: a.rev + Number(r.revenue), gp: a.gp + Number(r.gross_profit) }), { o: 0, u: 0, rev: 0, gp: 0 });
  const st2 = {};
  byStore.forEach((s) => { const x = (st2[s.location_id] ||= { location_id: s.location_id, n: 0, rev: 0, gp: 0 }); x.n++; x.rev += s.subtotal - s.discount_total; x.gp += s.subtotal - s.discount_total - s.cogs; });
  body.innerHTML = `
  <div class="kpis">
    <div class="kpi"><div class="kpi-l">Transactions</div><div class="kpi-v">${num(tot.o)}</div><div class="kpi-s">avg ticket ${money(tot.rev / (tot.o || 1))}</div></div>
    <div class="kpi"><div class="kpi-l">Units sold</div><div class="kpi-v">${num(tot.u)}</div></div>
    <div class="kpi"><div class="kpi-l">Net sales</div><div class="kpi-v">${money0(tot.rev)}</div></div>
    <div class="kpi"><div class="kpi-l">Gross profit</div><div class="kpi-v">${money0(tot.gp)}</div><div class="kpi-s">margin ${pct(tot.gp / (tot.rev || 1))}</div></div>
  </div>
  <div class="card"><h3>Net sales by ${st.grain} <span class="r chips">${['day', 'week', 'month'].map((g) => `<button class="chip ${g === st.grain ? 'on' : ''}" data-g="${g}">${g}</button>`).join('')}</span></h3>
    <div class="chart-box tall"><canvas id="rp-sales"></canvas></div></div>
  <div class="grid g2">
    <div class="card"><h3>By store / location</h3>${table([
      { k: 'location_id', label: 'Location', f: (v) => esc(loc(v)?.name) },
      { k: 'n', label: 'Transactions', cls: 'num', f: (v) => num(v) },
      { k: 'rev', label: 'Net sales', cls: 'num', f: (v) => money(v) },
      { k: 'gp', label: 'Gross profit', cls: 'num', f: (v) => money(v) },
    ], Object.values(st2))}</div>
    <div class="card"><h3>Detail</h3><div class="scroll" style="max-height:300px">${table([
      { k: 'period', label: st.grain === 'day' ? 'Date' : 'Starting', f: (v) => fdate(v) },
      { k: 'orders', label: 'Txns', cls: 'num', f: (v) => num(v) },
      { k: 'units', label: 'Units', cls: 'num', f: (v) => num(v) },
      { k: 'revenue', label: 'Net sales', cls: 'num', f: (v) => money(v) },
      { k: 'gross_profit', label: 'Gross profit', cls: 'num', f: (v) => money(v) },
    ], [...rows].reverse())}</div></div>
  </div>`;
  body.querySelectorAll('[data-g]').forEach((b) => (b.onclick = () => { st.grain = b.dataset.g; sales(body); }));
  chart($('#rp-sales', body), {
    type: 'bar',
    data: { labels: rows.map((r) => fdate(r.period).replace(/, \d{4}/, '')),
      datasets: [{ label: 'Net sales', data: rows.map((r) => Number(r.revenue)), backgroundColor: COLORS.s1, borderRadius: 4, maxBarThickness: 30 }] },
    options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ' ' + money(c.raw) } } }, scales: { x: { grid: { display: false } }, y: { grid: { color: COLORS.grid }, ticks: { callback: (v) => money0(v) } } } },
  });
}

async function top(body) {
  const rows = await rpc('top_items', { p_from: st.from, p_to: st.to, p_limit: 15 });
  body.innerHTML = `<div class="grid g2">
    <div class="card"><h3>Top 15 by revenue</h3>${table([
      { k: 'sku', label: '#', f: (v, r) => rows.indexOf(r) + 1 },
      { k: 'name', label: 'Item', f: (v, r) => `<b>${esc(v)}</b><div class="muted small">${esc(r.category)}</div>` },
      { k: 'units', label: 'Units', cls: 'num', f: (v) => num(v) },
      { k: 'revenue', label: 'Revenue', cls: 'num', f: (v) => money(v) },
      { k: 'gross_profit', label: 'Gross profit', cls: 'num', f: (v) => money(v) },
      { k: 'gross_profit', label: 'Margin', cls: 'num', f: (v, r) => pct(v / r.revenue) },
    ], rows)}</div>
    <div class="card"><h3>Revenue by item</h3><div class="chart-box" style="height:${Math.max(300, rows.length * 26)}px"><canvas id="rp-top"></canvas></div></div></div>`;
  chart($('#rp-top', body), {
    type: 'bar',
    data: { labels: rows.map((r) => r.name), datasets: [{ label: 'Revenue', data: rows.map((r) => Number(r.revenue)), backgroundColor: COLORS.s1, borderRadius: 4, maxBarThickness: 18 }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ' ' + money(c.raw) } } },
      scales: { x: { grid: { color: COLORS.grid }, ticks: { callback: (v) => money0(v) } }, y: { grid: { display: false } } } },
  });
}

async function low(body) {
  const rows = (await sel('v_item_planning', '*', (q) => q.order('order_by'))).filter((r) => r.stock_status !== 'OK');
  body.innerHTML = `<div class="card"><h3>Low stock: suggested order quantities and order-by dates <span class="r"><a href="#/planning">Act on these in Planning →</a></span></h3>${table([
    { k: 'sku', label: 'SKU', f: (v) => `<b>${esc(v)}</b>` },
    { k: 'name', label: 'Item' },
    { k: 'supplier_name', label: 'Source', f: (v, r) => (r.item_type === 'kit' ? 'Build in-house' : esc(v)) },
    { k: 'on_hand', label: 'On hand', cls: 'num', f: (v) => num(v) },
    { k: 'inv_position', label: 'Position', cls: 'num', f: (v) => num(v) },
    { k: 'rop', label: 'ROP', cls: 'num', f: (v) => num(v) },
    { k: 'days_of_supply', label: 'Days of supply', cls: 'num', f: (v) => num(v, 1) },
    { k: 'suggested_qty', label: 'Suggested qty', cls: 'num', f: (v, r) => `<b>${num(v || r.eoq_units)}</b>` },
    { k: 'order_by', label: 'Order by', f: (v) => fdate(v) },
    { k: 'stock_status', label: 'Status', f: (v) => badge(v) },
  ], rows, { empty: 'No items are low' })}</div>`;
}

async function locs(body) {
  const inv = await sel('v_inventory_valuation', '*');
  const L = S.refs.locations;
  const it = {};
  inv.forEach((r) => ((it[r.item_id] ||= { sku: r.sku, name: r.name, cat: r.category })[r.location_id] = Number(r.qty)));
  const totals = L.map((l) => inv.filter((r) => r.location_id === l.id).reduce((a, r) => a + Number(r.value), 0));
  const units = L.map((l) => inv.filter((r) => r.location_id === l.id).reduce((a, r) => a + Number(r.qty), 0));
  body.innerHTML = `<div class="kpis">${L.map((l, i) => `<div class="kpi"><div class="kpi-l">${esc(l.name)}</div><div class="kpi-v">${money0(totals[i])}</div><div class="kpi-s">${num(units[i])} units</div></div>`).join('')}</div>
  <div class="card">${table([
    { k: 'sku', label: 'SKU', f: (v) => `<b>${esc(v)}</b>` }, { k: 'name', label: 'Item' }, { k: 'cat', label: 'Category' },
    ...L.map((l) => ({ k: l.id, label: l.code, cls: 'num', f: (v) => (v ? num(v) : '<span class="muted">0</span>') })),
  ], Object.values(it).sort((a, b) => a.sku.localeCompare(b.sku)))}</div>`;
}

async function sup(body) {
  const [sc, pos] = await Promise.all([
    sel('v_supplier_scorecard', '*', (q) => q.order('score', { ascending: false })),
    sel('v_po_summary', '*', (q) => q.not('first_receipt_at', 'is', null).gte('order_date', st.from).lte('order_date', st.to).order('order_date', { ascending: false })),
  ]);
  body.innerHTML = `<div class="card"><h3>Supplier performance (all history)</h3>${table([
    { k: 'name', label: 'Supplier', f: (v) => `<b>${esc(v)}</b>` },
    { k: 'quoted_lead_days', label: 'Quoted LT', cls: 'num', f: (v) => v + ' d' },
    { k: 'avg_actual_lead_days', label: 'Actual LT (avg)', cls: 'num', f: (v, r) => `<span class="${v > r.quoted_lead_days ? 'neg' : ''}">${num(v, 1)} d</span>` },
    { k: 'avg_actual_lead_days', label: 'Variance', cls: 'num', f: (v, r) => `${v - r.quoted_lead_days > 0 ? '+' : ''}${num(v - r.quoted_lead_days, 1)} d` },
    { k: 'on_time_rate', label: 'On-time', cls: 'num', f: (v) => pct(v, 0) },
    { k: 'fill_rate', label: 'Fill rate', cls: 'num', f: (v) => pct(v, 1) },
    { k: 'score', label: 'Score', cls: 'num', f: (v) => `<b>${v}</b>` },
    { k: 'rating', label: 'Rating', f: (v) => badge(v) },
  ], sc)}</div>
  <div class="card"><h3>Deliveries for POs sent in the selected range</h3><div class="scroll">${table([
    { k: 'id', label: 'PO', f: (v) => 'PO-' + v }, { k: 'supplier_name', label: 'Supplier' },
    { k: 'order_date', label: 'Sent', f: (v) => fdate(v) }, { k: 'expected_date', label: 'Expected', f: (v) => fdate(v) },
    { k: 'first_receipt_at', label: 'Received', f: (v) => fdate(v) },
    { k: 'actual_lead_days', label: 'Actual / quoted', cls: 'num', f: (v, r) => `${v} / ${r.quoted_lead_days} d` },
    { k: 'on_time', label: '', f: (v) => (v ? badge('on time', 'green') : badge('late', 'red')) },
    { k: 'qty_received', label: 'Fill', cls: 'num', f: (v, r) => pct(v / r.qty_ordered, 0) },
  ], pos)}</div></div>`;
}
