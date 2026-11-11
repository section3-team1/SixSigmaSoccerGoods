// Dashboard — the manager's morning view. Every number is queried live.
import { sel, rpc, money, money0, num, pct, kpi, table, badge, esc, today, addDays, chart, COLORS, fdate, docNo, item } from '../lib.js';

export async function render(view) {
  const t = today();
  const mStart = t.slice(0, 8) + '01';
  const [salesToday, pnlMtd, inv, plan, sos, pos, wos, weekly, top, qc] = await Promise.all([
    rpc('sales_by_period', { p_from: t, p_to: t, p_grain: 'day' }),
    rpc('pnl', { p_from: mStart, p_to: t }),
    rpc('inventory_metrics', { p_from: addDays(t, -89), p_to: t }),
    sel('v_item_planning', 'item_id,sku,name,item_type,stock_status,inv_position,rop,suggested_qty,order_by,supplier_name'),
    sel('v_so_lines', 'so_id,backordered,requested_date,status', (q) => q.eq('status', 'placed')),
    sel('v_po_summary', 'id,supplier_name,status,expected_date,overdue,amount_owed,due_date', (q) => q.in('status', ['sent', 'partial', 'received', 'closed'])),
    sel('production_orders', 'id,status', (q) => q.in('status', ['planned', 'in_progress'])),
    rpc('sales_by_period', { p_from: addDays(t, -7 * 12), p_to: t, p_grain: 'week' }),
    rpc('top_items', { p_from: addDays(t, -29), p_to: t, p_limit: 6 }),
    sel('inventory', 'qty,location_id,locations!inner(kind)', (q) => q.eq('locations.kind', 'qc').gt('qty', 0)),
  ]);
  const td = salesToday[0] || { orders: 0, revenue: 0 };
  const reorder = plan.filter((p) => p.stock_status === 'Reorder now');
  const openSO = new Set(sos.map((s) => s.so_id));
  const backSO = new Set(sos.filter((s) => s.backordered > 0).map((s) => s.so_id));
  const openPO = pos.filter((p) => ['sent', 'partial'].includes(p.status));
  const latePO = openPO.filter((p) => p.overdue);
  const owed = pos.reduce((a, p) => a + Number(p.amount_owed || 0), 0);
  const dueSoon = pos.filter((p) => p.amount_owed > 0 && p.due_date && p.due_date <= addDays(t, 7));
  const qcUnits = qc.reduce((a, r) => a + Number(r.qty), 0);

  view.innerHTML = `
  <div class="kpis">
    ${kpi("Today's sales", money(td.revenue), `${num(td.orders)} transactions`)}
    ${kpi('Month-to-date revenue', money0(pnlMtd.net_revenue), `Gross margin ${pct(pnlMtd.gross_margin)}`)}
    ${kpi('MTD operating income', money0(pnlMtd.operating_income), 'after opex & write-offs', pnlMtd.operating_income >= 0 ? 'good' : 'bad')}
    ${kpi('Inventory value', money0(inv.current_value), 'weighted average cost')}
    ${kpi('Inventory turnover', num(inv.annualized_turnover, 1) + '×', `annualized · ${num(inv.days_on_hand, 0)} days on hand`)}
    ${kpi('Items to reorder', num(reorder.length), 'at or below reorder point', reorder.length ? 'warn' : 'good')}
    ${kpi('Open sales orders', num(openSO.size), `${backSO.size} with backorders`, backSO.size ? 'warn' : '')}
    ${kpi('Open purchase orders', num(openPO.length), `${latePO.length} past expected date`, latePO.length ? 'bad' : '')}
    ${kpi('Accounts payable', money0(owed), `${dueSoon.length} bills due in 7 days`)}
    ${kpi('Open work orders', num(wos.length), `${wos.filter((w) => w.status === 'in_progress').length} in progress`)}
  </div>
  <div class="grid g3">
    <div class="card span2">
      <h3>Weekly net sales <span class="r muted small">last 12 weeks</span></h3>
      <div class="chart-box"><canvas id="dash-weekly"></canvas></div>
    </div>
    <div class="card">
      <h3>Top sellers <span class="r muted small">last 30 days</span></h3>
      ${table([
        { k: 'name', label: 'Item' },
        { k: 'units', label: 'Units', cls: 'num', f: (v) => num(v) },
        { k: 'revenue', label: 'Revenue', cls: 'num', f: (v) => money0(v) },
      ], top)}
    </div>
  </div>
  <div class="grid g2">
    <div class="card">
      <h3>⚠ Reorder now <span class="r"><a href="#/planning">Open planning →</a></span></h3>
      ${table([
        { k: 'sku', label: 'SKU', f: (v) => `<b>${esc(v)}</b>` },
        { k: 'name', label: 'Item' },
        { k: 'inv_position', label: 'Position', cls: 'num', f: (v) => num(v) },
        { k: 'rop', label: 'ROP', cls: 'num', f: (v) => num(v) },
        { k: 'suggested_qty', label: 'Suggest', cls: 'num', f: (v, r) => `${num(v)} ${r.item_type === 'kit' ? 'build' : 'buy'}` },
      ], reorder.slice(0, 8), { empty: 'Everything is above its reorder point 👍' })}
    </div>
    <div class="card">
      <h3>Attention</h3>
      ${table([
        { k: 'what', label: 'What', f: (v) => v },
        { k: 'detail', label: 'Detail', f: (v) => v },
        { k: 'go', label: '', f: (v) => v },
      ], [
        ...latePO.map((p) => ({ what: `${docNo('PO', p.id)} late`, detail: `${esc(p.supplier_name)} — expected ${fdate(p.expected_date)}`, go: '<a href="#/purchasing">View</a>' })),
        ...dueSoon.slice(0, 4).map((p) => ({ what: `Pay ${docNo('PO', p.id)}`, detail: `${money(p.amount_owed)} to ${esc(p.supplier_name)} by ${fdate(p.due_date)}`, go: '<a href="#/purchasing">Pay</a>' })),
        ...[...backSO].slice(0, 4).map((id) => ({ what: `${docNo('SO', id)} backordered`, detail: 'Not enough stock to fulfil', go: '<a href="#/orders">View</a>' })),
        ...(qcUnits ? [{ what: 'QC Hold', detail: `${num(qcUnits)} returned unit(s) awaiting inspection`, go: '<a href="#/inventory">Inspect</a>' }] : []),
      ], { empty: 'All clear' })}
    </div>
  </div>`;

  chart(document.getElementById('dash-weekly'), {
    type: 'bar',
    data: {
      labels: weekly.map((w) => fdate(w.period).replace(/, \d{4}/, '')),
      datasets: [{ label: 'Net sales', data: weekly.map((w) => Number(w.revenue)), backgroundColor: COLORS.s1, borderRadius: 4, maxBarThickness: 34 }],
    },
    options: {
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ' ' + money(c.raw) } } },
      scales: { x: { grid: { display: false } }, y: { grid: { color: COLORS.grid }, ticks: { callback: (v) => money0(v) } } },
    },
  });
}
