// Sales Orders — Order Placed -> Fulfilled -> Closed (or Cancelled).
// Made-to-order items (custom jerseys) automatically release work orders.
import {
  S, sel, rpc, money, num, esc, act, modal, options, table, badge, tabs, fdate, fdt, docNo, today, addDays,
  item, cust, loc, locLabel, itemLabel, refresh, $, on,
} from '../lib.js';
import { showReceipt } from './pos.js';

const st = { status: 'placed' };

export async function render(view) {
  const orders = await sel('sales_orders', '*', (q) => {
    q = q.order('requested_date', { ascending: st.status === 'placed' }).order('id', { ascending: false }).limit(200);
    return st.status === 'all' ? q : q.eq('status', st.status);
  });
  const ids = orders.map((o) => o.id);
  const lines = ids.length ? await sel('v_so_lines', '*', (q) => q.in('so_id', ids)) : [];
  const by = {};
  lines.forEach((l) => (by[l.so_id] ||= []).push(l));

  view.innerHTML = `
  <div class="toolbar">
    ${tabs('so', [['placed', 'Order placed'], ['fulfilled', 'Fulfilled'], ['closed', 'Closed'], ['cancelled', 'Cancelled'], ['all', 'All']], st.status)}
    <span class="grow"></span>
    <button class="btn primary" id="so-new">+ New sales order</button>
  </div>
  <div class="card">
    ${table([
      { k: 'id', label: 'Order', f: (v) => `<b>${docNo('SO', v)}</b>` },
      { k: 'customer_id', label: 'Customer', f: (v) => esc(cust(v)?.name || '—') },
      { k: 'location_id', label: 'Pickup / ship from', f: (v) => esc(loc(v)?.code) },
      { k: 'ts', label: 'Placed', f: (v) => fdate(v) },
      { k: 'requested_date', label: 'Requested', f: (v, r) => `${fdate(v)}${r.status === 'placed' && v < today() ? ' <span class="badge red">past due</span>' : ''}` },
      { k: 'channel', label: 'Channel', f: (v) => (v === 'portal' ? badge('Customer portal', 'violet') : badge('Staff', 'gray')) },
      { k: 'id', label: 'Items', cls: 'num', f: (v) => num((by[v] || []).reduce((a, l) => a + Number(l.qty), 0)) },
      { k: 'id', label: 'Value', cls: 'num', f: (v) => money((by[v] || []).reduce((a, l) => a + l.qty * l.unit_price, 0)) },
      { k: 'id', label: 'Availability', f: (v, r) => {
          if (r.status !== 'placed') return '';
          const b = (by[v] || []).filter((l) => l.backordered > 0);
          if (!b.length) return badge('Ready to fulfil', 'green');
          const est = b.map((l) => l.est_available).sort().pop();
          return `${badge('Backordered', 'amber')} <span class="muted small">est. ${fdate(est)}</span>`;
        } },
      { k: 'status', label: 'Status', f: (v) => badge(v) },
    ], orders, { rowAttr: (r) => `class="click" data-so="${r.id}"`, empty: 'No orders in this status' })}
  </div>`;

  view.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { st.status = b.dataset.tab; render(view); }));
  $('#so-new', view).onclick = () => newOrder();
  view.querySelectorAll('[data-so]').forEach((r) => (r.onclick = () => openOrder(Number(r.dataset.so))));
}

function lineRow(ix, l = {}) {
  const items = S.refs.items.filter((i) => i.sellable && i.active);
  return `<tr data-ix="${ix}">
    <td><select class="ln-item"><option value="">Select item…</option>${options(items, l.item_id, itemLabel)}</select></td>
    <td class="w80"><input class="ln-qty" type="number" min="1" value="${l.qty || 1}"></td>
    <td class="w80"><input class="ln-price" type="number" step="0.01" value="${l.price ?? ''}" placeholder="list"></td>
    <td><button class="icon-btn ln-rm">✕</button></td></tr>`;
}

export function newOrder(preset = {}) {
  const m = modal({
    title: 'New sales order', wide: true, okText: 'Place order',
    body: `
      <div class="row3">
        <label>Customer<select name="cust">${options(S.refs.customers, preset.customer)}</select></label>
        <label>Pickup / ship-from location<select name="loc">${options(S.refs.locations.filter((l) => l.kind !== 'qc'), preset.loc, locLabel)}</select></label>
        <label>Requested date<input name="date" type="date" value="${preset.date || addDays(today(), 7)}"></label>
      </div>
      <table class="tbl"><thead><tr><th>Item</th><th>Qty</th><th>Unit price</th><th></th></tr></thead><tbody id="so-lines">${lineRow(0)}</tbody></table>
      <button class="btn sm" id="so-add" style="margin-top:8px">+ Add line</button>
      <label style="margin-top:12px">Notes<input name="notes" placeholder="e.g. Team uniform order — numbers 1-18"></label>
      <p class="note">Custom jerseys are <b>made to order</b>: if finished stock is short, the system releases a production order for the shortfall automatically.</p>`,
    onOk: async (el) => {
      const ls = [...el.querySelectorAll('#so-lines tr')].map((tr) => ({
        item_id: Number($('.ln-item', tr).value), qty: Number($('.ln-qty', tr).value),
        unit_price: $('.ln-price', tr).value ? Number($('.ln-price', tr).value) : undefined,
      })).filter((l) => l.item_id && l.qty > 0);
      if (!ls.length) throw new Error('Add at least one item');
      const id = await rpc('create_sales_order', {
        p_customer: Number(el.querySelector('[name=cust]').value), p_location: Number(el.querySelector('[name=loc]').value),
        p_requested: el.querySelector('[name=date]').value, p_lines: ls, p_notes: el.querySelector('[name=notes]').value || null,
      });
      refresh();
      setTimeout(() => openOrder(id), 300);
    },
  });
  let n = 1;
  $('#so-add', m.el).onclick = () => $('#so-lines', m.el).insertAdjacentHTML('beforeend', lineRow(n++));
  on(m.el, 'click', '.ln-rm', (e, b) => b.closest('tr').remove());
  on(m.el, 'change', '.ln-item', (e, s) => {
    const it = item(Number(s.value));
    const p = s.closest('tr').querySelector('.ln-price');
    if (it && !p.value) p.placeholder = Number(it.price).toFixed(2);
  });
}

export async function openOrder(id) {
  const [o] = await sel('sales_orders', '*', (q) => q.eq('id', id));
  const lines = await sel('v_so_lines', '*', (q) => q.eq('so_id', id).order('id'));
  const wos = await sel('production_orders', '*', (q) => q.eq('so_id', id).order('id'));
  const total = lines.reduce((a, l) => a + l.qty * l.unit_price, 0);
  const anyBack = lines.some((l) => l.backordered > 0);
  const m = modal({
    title: `${docNo('SO', o.id)} · ${esc(cust(o.customer_id)?.name)}`, wide: true, hideOk: true, cancelText: 'Close',
    body: `
      <div class="kpis">
        <div class="kpi"><div class="kpi-l">Status</div><div class="kpi-v">${badge(o.status)}</div><div class="kpi-s">${o.channel === 'portal' ? 'Placed on customer portal' : 'Placed by ' + esc(o.created_by || 'staff')}</div></div>
        <div class="kpi"><div class="kpi-l">Location</div><div class="kpi-v" style="font-size:16px">${esc(loc(o.location_id)?.name)}</div><div class="kpi-s">Placed ${fdt(o.ts)}</div></div>
        <div class="kpi"><div class="kpi-l">Requested</div><div class="kpi-v" style="font-size:16px">${fdate(o.requested_date)}</div><div class="kpi-s">${o.fulfilled_at ? 'Fulfilled ' + fdt(o.fulfilled_at) : ''}</div></div>
        <div class="kpi"><div class="kpi-l">Order value</div><div class="kpi-v">${money(total)}</div><div class="kpi-s">before tax</div></div>
      </div>
      ${o.notes ? `<p class="note">${esc(o.notes)}</p>` : ''}
      ${table([
        { k: 'sku', label: 'SKU', f: (v) => `<b>${esc(v)}</b>` },
        { k: 'name', label: 'Item' },
        { k: 'qty', label: 'Qty', cls: 'num', f: (v) => num(v) },
        { k: 'unit_price', label: 'Price', cls: 'num', f: (v) => money(v) },
        { k: 'on_hand_loc', label: `On hand @ ${esc(loc(o.location_id)?.code)}`, cls: 'num', f: (v) => num(v) },
        { k: 'backordered', label: 'Backordered', cls: 'num', f: (v) => (v > 0 ? `<span class="neg">${num(v)}</span>` : '0') },
        { k: 'est_available', label: 'Est. available', f: (v, r) => (r.backordered > 0 ? fdate(v) : '—') },
      ], lines)}
      ${wos.length ? `<h4 style="margin:14px 0 8px">Linked production orders</h4>${table([
        { k: 'id', label: 'WO', f: (v) => docNo('WO', v) },
        { k: 'item_id', label: 'Item', f: (v) => esc(item(v).name) },
        { k: 'qty_planned', label: 'Planned', cls: 'num', f: (v) => num(v) },
        { k: 'qty_good', label: 'Good', cls: 'num', f: (v) => num(v) },
        { k: 'due_date', label: 'Due', f: (v) => fdate(v) },
        { k: 'status', label: 'Status', f: (v) => badge(v) },
      ], wos)}` : ''}
      <div class="toolbar" style="margin-top:14px">
        ${o.status === 'placed' ? `<button class="btn primary" id="so-ful" ${anyBack ? 'title="Some lines are backordered"' : ''}>Fulfil order (ship / ready for pickup)</button>
          <button class="btn danger" id="so-can">Cancel order</button>` : ''}
        ${o.status === 'fulfilled' ? '<button class="btn primary" id="so-close">Close (customer picked up)</button>' : ''}
        ${o.sale_id ? `<button class="btn" id="so-inv">View invoice ${docNo('S', o.sale_id)}</button>` : ''}
      </div>
      ${o.status === 'placed' && anyBack ? '<p class="note">⚠ Backordered lines must be in stock at this location before the order can be fulfilled. Receive a PO, finish the work order, or transfer stock in.</p>' : ''}`,
  });
  const after = () => { m.close(); refresh(); setTimeout(() => openOrder(id), 300); };
  $('#so-ful', m.el)?.addEventListener('click', (e) => act(e.currentTarget, () => rpc('fulfill_sales_order', { p_so: id }), 'Order fulfilled — inventory reduced and revenue recorded').then(after).catch(() => {}));
  $('#so-can', m.el)?.addEventListener('click', (e) => act(e.currentTarget, () => rpc('cancel_sales_order', { p_so: id }), 'Order cancelled').then(after).catch(() => {}));
  $('#so-close', m.el)?.addEventListener('click', (e) => act(e.currentTarget, () => rpc('close_sales_order', { p_so: id }), 'Order closed').then(after).catch(() => {}));
  $('#so-inv', m.el)?.addEventListener('click', () => { m.close(); showReceipt(o.sale_id); });
}
