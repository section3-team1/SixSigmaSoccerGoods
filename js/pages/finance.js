// Financials — P&L, inventory valuation (weighted average), inventory turnover. All live.
import { S, sel, rpc, money, money0, num, pct, esc, table, kpi, today, addDays, fdate, chart, COLORS, $, loc } from '../lib.js';

const st = { preset: '30', from: null, to: null };

function range() {
  const t = today();
  if (st.preset === 'custom') return [st.from, st.to];
  if (st.preset === 'mtd') return [t.slice(0, 8) + '01', t];
  if (st.preset === 'ytd') return [addDays(t, -182), t];
  return [addDays(t, -(Number(st.preset) - 1)), t];
}

export async function render(view) {
  const [from, to] = range();
  st.from = from; st.to = to;
  const [p, im, trend, val] = await Promise.all([
    rpc('pnl', { p_from: from, p_to: to }),
    rpc('inventory_metrics', { p_from: from, p_to: to }),
    rpc('turnover_trend', { p_months: 6 }),
    sel('v_inventory_valuation', '*'),
  ]);
  const byLoc = {}, byCat = {};
  val.forEach((v) => { byLoc[v.location_code] = (byLoc[v.location_code] || 0) + Number(v.value); byCat[v.category] = (byCat[v.category] || 0) + Number(v.value); });
  const itemVal = {};
  val.forEach((v) => { const x = (itemVal[v.item_id] ||= { sku: v.sku, name: v.name, category: v.category, qty: 0, avg_cost: v.avg_cost, value: 0 }); x.qty += Number(v.qty); x.value += Number(v.value); });
  const total = Object.values(byLoc).reduce((a, b) => a + b, 0);
  const line = (label, v, cls = '', note = '') => `<tr class="${cls}"><td>${label}${note ? ` <span class="muted small">${note}</span>` : ''}</td><td class="num">${v}</td></tr>`;

  view.innerHTML = `
  <div class="toolbar">
    <div class="chips">${[['mtd', 'Month to date'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['ytd', 'Last 6 months'], ['custom', 'Custom']]
      .map(([k, l]) => `<button class="chip ${k === st.preset ? 'on' : ''}" data-p="${k}">${l}</button>`).join('')}</div>
    <input type="date" id="f-from" value="${from}" style="max-width:160px;margin:0"><span>→</span><input type="date" id="f-to" value="${to}" style="max-width:160px;margin:0">
    <span class="muted small">${p.days} days</span>
  </div>
  <div class="kpis">
    ${kpi('Net revenue', money0(p.net_revenue), `${fdate(from)} – ${fdate(to)}`)}
    ${kpi('Gross profit', money0(p.gross_profit), `margin ${pct(p.gross_margin)}`)}
    ${kpi('Operating income', money0(p.operating_income), 'after opex & write-offs', p.operating_income >= 0 ? 'good' : 'bad')}
    ${kpi('Inventory value', money0(im.current_value), 'now, weighted average cost')}
    ${kpi('Inventory turnover', num(im.annualized_turnover, 2) + '×', `annualized · ${num(im.turnover, 2)}× in period`)}
    ${kpi('Days of inventory', num(im.days_on_hand, 0), 'period days ÷ turns')}
  </div>
  <div class="grid g2">
    <div class="card"><h3>Profit & Loss statement</h3>
      <div class="tbl-wrap"><table class="tbl"><tbody>
        ${line('Gross sales', money(p.gross_sales))}
        ${line('&nbsp;&nbsp;Less: discounts', `(${money(p.discounts)})`)}
        ${line('&nbsp;&nbsp;Less: returns & allowances', `(${money(p.returns)})`)}
        ${line('<b>Net revenue</b>', `<b>${money(p.net_revenue)}</b>`)}
        ${line('Cost of goods sold', money(p.cogs))}
        ${line('&nbsp;&nbsp;Less: COGS reversed on returns', `(${money(p.cogs_returns)})`)}
        ${line('<b>Net COGS</b>', `<b>${money(p.net_cogs)}</b>`)}
        ${line('<b>Gross profit</b>', `<b>${money(p.gross_profit)}</b>`, '', pct(p.gross_margin) + ' margin')}
        ${line('Inventory write-offs', money(p.inventory_writeoffs), '', 'damage, shrink, QC scrap, count variances')}
        ${line('Rent', money(p.opex_rent), '', 'prorated from monthly setting')}
        ${line('Wages', money(p.opex_wages))}
        ${line('Utilities, software & other', money(p.opex_other))}
        ${line('<b>Operating income</b>', `<b class="${p.operating_income < 0 ? 'neg' : 'pos-v'}">${money(p.operating_income)}</b>`)}
      </tbody></table></div>
      <p class="muted small">Memo: sales tax collected ${money(p.tax_collected)} (a liability, not revenue) · production scrap cost absorbed into finished goods ${money(p.scrap_cost_memo)}.
      COGS uses the weighted-average cost at the moment of each sale.</p>
    </div>
    <div class="card"><h3>Inventory turnover</h3>
      <div class="formula">turnover = net COGS ÷ average inventory value<br>
        = ${money(im.cogs)} ÷ ((${money(im.begin_value)} begin + ${money(im.end_value)} end) ÷ 2)<br>
        = ${money(im.cogs)} ÷ ${money(im.avg_value)} = <b>${num(im.turnover, 2)}×</b> in ${im.days} days → <b>${num(im.annualized_turnover, 2)}× / year</b></div>
      <div class="chart-box" style="margin-top:12px"><canvas id="f-turn"></canvas></div>
      <p class="muted small">Annualized turnover by month. Inventory values are rebuilt from the transaction ledger, so any past date can be valued.</p>
    </div>
  </div>
  <div class="grid g2">
    <div class="card"><h3>Inventory valuation by location</h3>${table([
      { k: 'k', label: 'Location', f: (v) => { const l = S.refs.locations.find((x) => x.code === v); return `${esc(v)} · ${esc(l?.name)}`; } },
      { k: 'v', label: 'Value', cls: 'num', f: (v) => money(v) },
      { k: 'v', label: 'Share', cls: 'num', f: (v) => pct(v / total) },
    ], Object.entries(byLoc).map(([k, v]) => ({ k, v })), { foot: `<tfoot><tr><td>Total</td><td class="num">${money(total)}</td><td></td></tr></tfoot>` })}
    <h3 style="margin-top:16px">By category</h3>${table([
      { k: 'k', label: 'Category' }, { k: 'v', label: 'Value', cls: 'num', f: (v) => money(v) }, { k: 'v', label: 'Share', cls: 'num', f: (v) => pct(v / total) },
    ], Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k, v })))}</div>
    <div class="card"><h3>Valuation by item <span class="r muted small">qty × weighted average cost</span></h3><div class="scroll">${table([
      { k: 'sku', label: 'SKU', f: (v) => `<b>${esc(v)}</b>` }, { k: 'name', label: 'Item' },
      { k: 'qty', label: 'Qty', cls: 'num', f: (v) => num(v) }, { k: 'avg_cost', label: 'Avg cost', cls: 'num', f: (v) => money(v) },
      { k: 'value', label: 'Value', cls: 'num', f: (v) => money(v) },
    ], Object.values(itemVal).sort((a, b) => b.value - a.value))}</div></div>
  </div>`;

  view.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => { st.preset = b.dataset.p; render(view); }));
  $('#f-from', view).onchange = (e) => { st.preset = 'custom'; st.from = e.target.value; render(view); };
  $('#f-to', view).onchange = (e) => { st.preset = 'custom'; st.to = e.target.value; render(view); };
  chart($('#f-turn', view), {
    type: 'line',
    data: { labels: trend.map((t) => new Date(t.month + 'T12:00:00').toLocaleDateString('en-US', { month: 'short' })),
      datasets: [{ label: 'Annualized turnover', data: trend.map((t) => Number(t.annualized_turnover)), borderColor: COLORS.s1, backgroundColor: COLORS.s1, borderWidth: 2, pointRadius: 4, tension: 0.25 }] },
    options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${num(c.raw, 2)}× per year` } } } },
  });
}
