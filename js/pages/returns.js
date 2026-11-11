// Returns & Exchanges — reverse revenue + COGS, put stock back (quality failures go to QC Hold).
import {
  S, sel, rpc, money, num, esc, act, options, table, badge, fdate, fdt, docNo, item, cust, loc, locLabel,
  reasons, setting, itemByCode, scanField, cameraScan, toast, refresh, $, itemLabel,
} from '../lib.js';

const st = { saleId: null, newLines: [], loc: null };

export async function render(view) {
  const recent = await sel('returns', '*', (q) => q.order('id', { ascending: false }).limit(25));
  let sale = null, lines = [];
  if (st.saleId) {
    [sale] = await sel('sales', '*', (q) => q.eq('id', st.saleId));
    if (sale) lines = await sel('sale_lines', '*', (q) => q.eq('sale_id', st.saleId).order('id'));
    if (sale && !st.loc) st.loc = sale.location_id;
  }
  const rcodes = reasons('return');

  view.innerHTML = `
  <div class="grid g3">
    <div class="card span2">
      <h3>1 · Find the original sale</h3>
      <div class="scanbar">
        <input id="rt-find" placeholder="Scan receipt barcode or type sale # (e.g. S-3940)" value="${sale ? 'S-' + sale.id : ''}">
        <button class="btn blue" id="rt-cam">📷</button><button class="btn" id="rt-go">Look up</button>
      </div>
      <p class="muted small" style="margin:8px 0 0">Recent: ${(await sel('sales', 'id,total,customer_id', (q) => q.order('id', { ascending: false }).limit(5)))
        .map((s) => `<a href="javascript:void 0" data-pick="${s.id}">S-${s.id}</a> (${money(s.total)})`).join(' · ')}</p>
      ${st.saleId && !sale ? '<div class="empty" style="margin-top:12px">Sale not found</div>' : ''}
      ${sale ? `
      <div class="note" style="margin:14px 0">
        <b>${docNo('S', sale.id)}</b> · ${fdt(sale.ts)} · ${esc(loc(sale.location_id)?.name)} · ${esc(cust(sale.customer_id)?.name || 'Walk-in')} ·
        total ${money(sale.total)} (tax ${money(sale.tax)})</div>
      <h3>2 · Choose items coming back</h3>
      ${table([
        { k: 'item_id', label: 'Item', f: (v) => `<b>${esc(item(v).name)}</b><div class="muted small">${esc(item(v).sku)}</div>` },
        { k: 'qty', label: 'Sold', cls: 'num', f: (v) => num(v) },
        { k: 'returned_qty', label: 'Already returned', cls: 'num', f: (v) => num(v) },
        { k: 'line_total', label: 'Paid (net)', cls: 'num', f: (v, r) => `${money(v / r.qty)} ea` },
        { k: 'id', label: 'Return qty', cls: 'w80', f: (v, r) => `<input type="number" class="rt-q" data-line="${v}" data-max="${r.qty - r.returned_qty}" data-unit="${r.line_total / r.qty}" data-cost="${r.unit_cost}" min="0" max="${r.qty - r.returned_qty}" value="0" ${r.qty - r.returned_qty <= 0 ? 'disabled' : ''}>` },
      ], lines)}
      <div class="row2" style="margin-top:12px">
        <label>Reason code<select id="rt-reason">${rcodes.map((r) => `<option value="${r.code}" data-q="${r.is_quality}">${esc(r.code)} — ${esc(r.description)}</option>`).join('')}</select></label>
        <label>Returned at<select id="rt-loc">${options(S.refs.locations.filter((l) => l.kind === 'store' || l.kind === 'warehouse'), st.loc, locLabel)}</select></label>
      </div>
      <p class="note" id="rt-disp"></p>

      <h3 style="margin-top:16px">3 · Exchange? Add replacement items (optional)</h3>
      <div class="scanbar">
        <select id="rt-newitem"><option value="">Add item…</option>${options(S.refs.items.filter((i) => i.sellable), '', itemLabel)}</select>
        <input id="rt-newscan" placeholder="or scan" style="max-width:180px">
      </div>
      ${st.newLines.length ? table([
        { k: 'id', label: 'Replacement item', f: (v) => esc(item(v).name) },
        { k: 'qty', label: 'Qty', cls: 'num' },
        { k: 'id', label: 'Price', cls: 'num', f: (v) => money(item(v).price) },
        { k: 'ix', label: '', f: (v) => `<button class="icon-btn" data-rmn="${v}">✕</button>` },
      ], st.newLines.map((l, ix) => ({ ...l, ix }))) : ''}
      ` : ''}
    </div>
    <div class="card">
      <h3>Summary</h3>
      <div id="rt-sum" class="totals"><div class="empty">Look up a sale to begin</div></div>
      ${sale ? '<button class="btn primary block lg" id="rt-submit" style="margin-top:14px">Process</button>' : ''}
      <div class="note" style="margin-top:14px"><b>What happens</b><br>
        • Revenue is reversed at the price the customer actually paid (after discounts), and their tax is refunded.<br>
        • COGS is reversed at the original unit cost, and the item goes back into inventory at that cost.<br>
        • <b>Quality-failure</b> reasons send the item to <b>QC Hold</b> (not sellable) for inspection; others go back on the shelf.<br>
        • An exchange is posted as a new sale, and the customer pays or receives the difference.</div>
    </div>
  </div>
  <div class="card">
    <h3>Recent returns & exchanges</h3>
    ${table([
      { k: 'id', label: 'RMA', f: (v) => `<b>${docNo('RMA', v)}</b>` },
      { k: 'ts', label: 'Date', f: (v) => fdt(v) },
      { k: 'sale_id', label: 'Original sale', f: (v) => docNo('S', v) },
      { k: 'kind', label: 'Type', f: (v) => badge(v) },
      { k: 'reason_code', label: 'Reason', f: (v) => { const r = S.refs.reasons.find((x) => x.code === v); return `${esc(v)} ${r?.is_quality ? badge('quality', 'red') : ''}`; } },
      { k: 'location_id', label: 'At', f: (v) => esc(loc(v)?.code) },
      { k: 'refund_total', label: 'Revenue reversed', cls: 'num', f: (v) => money(v) },
      { k: 'cogs_reversed', label: 'COGS reversed', cls: 'num', f: (v) => money(v) },
      { k: 'net_due', label: 'Customer pays / (refund)', cls: 'num', f: (v) => (v < 0 ? `(${money(-v)})` : money(v)) },
    ], recent)}
  </div>`;

  const find = (code) => {
    const n = Number(String(code).replace(/^S-?/i, '').trim());
    if (!n) return toast('Enter a sale number like S-1234', 'warn');
    st.saleId = n; st.newLines = []; st.loc = null;
    render(view);
  };
  scanField($('#rt-find', view), find);
  $('#rt-go', view).onclick = () => find($('#rt-find', view).value);
  $('#rt-cam', view).onclick = () => cameraScan(find);
  view.querySelectorAll('[data-pick]').forEach((a) => (a.onclick = () => find(a.dataset.pick)));
  if (!sale) return;

  const taxRate = sale.subtotal - sale.discount_total > 0 ? sale.tax / (sale.subtotal - sale.discount_total) : setting('tax_rate');
  const summarize = () => {
    let refund = 0, cogs = 0, units = 0;
    view.querySelectorAll('.rt-q').forEach((i) => {
      const q = Math.min(Number(i.value) || 0, Number(i.dataset.max));
      refund += Math.round(q * Number(i.dataset.unit) * 100) / 100; cogs += q * Number(i.dataset.cost); units += q;
    });
    const taxRef = Math.round(refund * taxRate * 100) / 100;
    const newSub = st.newLines.reduce((a, l) => a + l.qty * Number(item(l.id).price), 0);
    const newTot = newSub + Math.round(newSub * setting('tax_rate') * 100) / 100;
    const net = newTot - (refund + taxRef);
    const q = $('#rt-reason', view).selectedOptions[0]?.dataset.q === 'true';
    $('#rt-disp', view).innerHTML = q
      ? '🔍 <b>Quality failure:</b> the returned units go to <b>QC Hold</b> for inspection, and the defect is counted in the Six Sigma Pareto.'
      : '↩ Units go back into sellable stock at the location above.';
    $('#rt-sum', view).innerHTML = `
      <div><span>Units returned</span><span>${num(units)}</span></div>
      <div><span>Revenue reversed</span><span>−${money(refund)}</span></div>
      <div><span>Tax refunded</span><span>−${money(taxRef)}</span></div>
      <div><span>COGS reversed (back to inventory)</span><span>${money(cogs)}</span></div>
      ${st.newLines.length ? `<div><span>Replacement items (incl. tax)</span><span>${money(newTot)}</span></div>` : ''}
      <div class="grand"><span>${net >= 0 ? 'Customer pays' : 'Refund to customer'}</span><span>${money(Math.abs(net))}</span></div>`;
    $('#rt-submit', view).textContent = st.newLines.length ? 'Process exchange' : 'Process return';
  };
  view.querySelectorAll('.rt-q').forEach((i) => (i.oninput = summarize));
  $('#rt-reason', view).onchange = summarize;
  $('#rt-loc', view).onchange = (e) => (st.loc = Number(e.target.value));
  const addNew = (id) => {
    const it = typeof id === 'number' ? item(id) : itemByCode(id);
    if (!it?.sellable) return toast('Unknown item', 'err');
    const ex = st.newLines.find((l) => l.id === it.id);
    if (ex) ex.qty++; else st.newLines.push({ id: it.id, qty: 1 });
    keepQty(() => render(view));
  };
  // keep typed return quantities when re-rendering for exchange lines
  const keepQty = (fn) => {
    const saved = [...view.querySelectorAll('.rt-q')].map((i) => [i.dataset.line, i.value]);
    const reason = $('#rt-reason', view).value;
    fn().then?.(() => {
      saved.forEach(([l, v]) => { const i = view.querySelector(`.rt-q[data-line="${l}"]`); if (i) i.value = v; });
      $('#rt-reason', view).value = reason; summarize();
    });
  };
  $('#rt-newitem', view).onchange = (e) => e.target.value && addNew(Number(e.target.value));
  scanField($('#rt-newscan', view), addNew);
  view.querySelectorAll('[data-rmn]').forEach((b) => (b.onclick = () => { st.newLines.splice(Number(b.dataset.rmn), 1); keepQty(() => render(view)); }));
  summarize();

  $('#rt-submit', view).onclick = (e) => {
    const ls = [...view.querySelectorAll('.rt-q')].map((i) => ({ sale_line_id: Number(i.dataset.line), qty: Number(i.value) || 0 })).filter((l) => l.qty > 0);
    if (!ls.length) return toast('Enter a return quantity for at least one item', 'warn');
    act(e.currentTarget, async () => {
      const id = await rpc('process_return', {
        p_sale: sale.id, p_lines: ls, p_reason: $('#rt-reason', view).value, p_location: Number($('#rt-loc', view).value),
        p_new_lines: st.newLines.length ? st.newLines.map((l) => ({ item_id: l.id, qty: l.qty })) : null,
      });
      const [r] = await sel('returns', '*', (q) => q.eq('id', id));
      toast(`${docNo('RMA', id)} processed — ${r.net_due < 0 ? 'refund ' + money(-r.net_due) : 'customer pays ' + money(r.net_due)}`, 'ok', 6000);
      st.saleId = null; st.newLines = [];
      refresh();
    }).catch(() => {});
  };
}
