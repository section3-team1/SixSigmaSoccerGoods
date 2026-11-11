// Point of Sale — scan or tap items, discounts, tax, receipt.
// Completing a sale calls post_sale(): reduces inventory, records revenue + COGS.
import {
  S, sel, rpc, money, num, esc, toast, act, options, stores, locLabel, itemByCode, item, setting,
  scanField, cameraScan, beep, modal, printDoc, docNo, fdt, cust, refresh, $, bomOf,
} from '../lib.js';

// kept between re-renders so live updates never wipe the cart
const st = { loc: null, customer: '', cat: 'All', search: '', cart: [], orderDisc: 0, pay: 'card' };

export async function render(view) {
  if (!st.loc) st.loc = stores()[0]?.id;
  const inv = await sel('inventory', 'item_id,qty', (q) => q.eq('location_id', st.loc));
  const oh = Object.fromEntries(inv.map((r) => [r.item_id, Number(r.qty)]));
  // bundles can be kitted at the counter: how many could we build right now?
  const buildable = (it) => {
    const b = bomOf(it.id);
    if (!it.auto_assemble || !b.length) return 0;
    return Math.min(...b.map((x) => Math.floor((oh[x.component_id] || 0) / Number(x.qty))));
  };
  const avail = (it) => (oh[it.id] || 0) + buildable(it);

  const sellable = S.refs.items.filter((i) => i.sellable && i.active);
  const cats = ['All', ...new Set(sellable.map((i) => i.category))];
  const shown = sellable.filter((i) =>
    (st.cat === 'All' || i.category === st.cat) &&
    (!st.search || (i.name + ' ' + i.sku).toLowerCase().includes(st.search.toLowerCase())));

  const taxRate = setting('tax_rate');
  const lines = st.cart.map((l) => {
    const gross = l.qty * l.price;
    const net = gross * (1 - l.disc / 100) * (1 - st.orderDisc / 100);
    return { ...l, gross, net: Math.round(net * 100) / 100 };
  });
  const sub = lines.reduce((a, l) => a + l.gross, 0);
  const netSum = lines.reduce((a, l) => a + l.net, 0);
  const tax = Math.round(netSum * taxRate * 100) / 100;

  view.innerHTML = `
  <div class="pos">
    <div class="card">
      <div class="toolbar">
        <label style="margin:0;min-width:200px">Store / location
          <select id="pos-loc">${options(S.refs.locations.filter((l) => l.kind !== 'qc'), st.loc, locLabel)}</select></label>
        <label style="margin:0;flex:1;min-width:200px">Customer
          <select id="pos-cust"><option value="">Walk-in customer</option>${options(S.refs.customers, st.customer)}</select></label>
      </div>
      <div class="scanbar">
        <input id="pos-scan" placeholder="Scan barcode (USB scanner) or type SKU + Enter" autocomplete="off">
        <button class="btn blue" id="pos-cam">📷 Camera</button>
      </div>
      <div class="toolbar" style="margin-top:12px">
        <div class="chips">${cats.map((c) => `<button class="chip ${c === st.cat ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
        <input id="pos-search" class="grow" style="max-width:220px;margin:0" placeholder="Search…" value="${esc(st.search)}">
      </div>
      <div class="prod-grid">
        ${shown.map((i) => {
          const a = avail(i);
          return `<button class="prod" data-add="${i.id}">
            <b>${esc(i.name)}</b><span class="muted small">${esc(i.sku)}</span>
            <span class="p">${money(i.price)}</span>
            <span class="oh ${a <= 0 ? 'zero' : ''}">${a <= 0 ? 'Out of stock here' : `${num(oh[i.id] || 0)} on hand${buildable(i) ? ` · +${buildable(i)} can kit` : ''}`}</span>
          </button>`;
        }).join('')}
      </div>
    </div>

    <div class="card">
      <h3>Current sale <span class="r muted small">${esc(S.refs.locations.find((l) => l.id === st.loc)?.name || '')}</span></h3>
      <div class="cart-line muted small" style="padding-top:0"><span>Item</span><span class="num">Price</span><span class="num">Qty</span><span class="num">Disc %</span><span></span></div>
      ${lines.length ? lines.map((l, ix) => `
        <div class="cart-line">
          <div><b>${esc(item(l.id).name)}</b><div class="muted small">${money(l.net)}${avail(item(l.id)) < l.qty ? ' · <span class="neg">only ' + avail(item(l.id)) + ' here</span>' : ''}</div></div>
          <span class="num">${money(l.price)}</span>
          <input type="number" min="1" step="1" value="${l.qty}" data-qty="${ix}">
          <input type="number" min="0" max="100" step="1" value="${l.disc}" data-disc="${ix}">
          <button class="icon-btn" data-rm="${ix}" aria-label="Remove">✕</button>
        </div>`).join('') : '<div class="empty">Scan or tap an item to start a sale</div>'}
      <div class="row2" style="margin-top:12px">
        <label>Order discount %<input type="number" id="pos-odisc" min="0" max="100" value="${st.orderDisc}"></label>
        <label>Payment<select id="pos-pay">${options([{ id: 'card', name: 'Card' }, { id: 'cash', name: 'Cash' }, { id: 'invoice', name: 'Invoice (team account)' }], st.pay)}</select></label>
      </div>
      <div class="totals">
        <div><span>Subtotal</span><span>${money(sub)}</span></div>
        <div><span>Discounts</span><span>−${money(sub - netSum)}</span></div>
        <div><span>Sales tax (${(taxRate * 100).toFixed(2)}%)</span><span>${money(tax)}</span></div>
        <div class="grand"><span>Total</span><span>${money(netSum + tax)}</span></div>
      </div>
      <div class="row2" style="margin-top:14px">
        <button class="btn ghost" id="pos-clear" ${lines.length ? '' : 'disabled'}>Clear</button>
        <button class="btn primary lg" id="pos-done" ${lines.length ? '' : 'disabled'}>Complete sale</button>
      </div>
    </div>
  </div>`;

  const add = (code) => {
    const it = typeof code === 'number' ? item(code) : itemByCode(code);
    if (!it) return toast(`No item with barcode/SKU "${esc(code)}"`, 'err');
    if (!it.sellable) return toast(`${esc(it.name)} is a component, not sold at the register`, 'warn');
    const ex = st.cart.find((l) => l.id === it.id);
    if (ex) ex.qty += 1; else st.cart.push({ id: it.id, qty: 1, price: Number(it.price), disc: 0 });
    beep();
    render(view).then(() => $('#pos-scan')?.focus());
  };

  scanField($('#pos-scan', view), add);
  $('#pos-scan', view).focus();
  $('#pos-cam', view).onclick = () => cameraScan(add, { continuous: true });
  $('#pos-loc', view).onchange = (e) => { st.loc = Number(e.target.value); render(view); };
  $('#pos-cust', view).onchange = (e) => { st.customer = e.target.value; };
  $('#pos-pay', view).onchange = (e) => { st.pay = e.target.value; };
  $('#pos-odisc', view).onchange = (e) => { st.orderDisc = Math.min(100, Math.max(0, Number(e.target.value) || 0)); render(view); };
  $('#pos-search', view).oninput = (e) => {
    st.search = e.target.value;
    clearTimeout(st._t);
    st._t = setTimeout(() => render(view).then(() => { const s = $('#pos-search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }), 250);
  };
  view.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => { st.cat = b.dataset.cat; render(view); }));
  view.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => add(Number(b.dataset.add))));
  view.querySelectorAll('[data-qty]').forEach((i) => (i.onchange = () => { st.cart[i.dataset.qty].qty = Math.max(1, Math.round(Number(i.value) || 1)); render(view); }));
  view.querySelectorAll('[data-disc]').forEach((i) => (i.onchange = () => { st.cart[i.dataset.disc].disc = Math.min(100, Math.max(0, Number(i.value) || 0)); render(view); }));
  view.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { st.cart.splice(Number(b.dataset.rm), 1); render(view); }));
  $('#pos-clear', view).onclick = () => { st.cart = []; st.orderDisc = 0; render(view); };
  $('#pos-done', view).onclick = (e) =>
    act(e.currentTarget, async () => {
      const id = await rpc('post_sale', {
        p_location: st.loc, p_customer: st.customer ? Number(st.customer) : null,
        p_lines: st.cart.map((l) => ({ item_id: l.id, qty: l.qty, unit_price: l.price, discount_pct: l.disc })),
        p_order_discount_pct: st.orderDisc, p_payment: st.pay,
      });
      st.cart = []; st.orderDisc = 0;
      await showReceipt(id);
      refresh();
    }).catch(() => {});
}

export async function showReceipt(saleId) {
  const [s] = await sel('sales', '*', (q) => q.eq('id', saleId));
  const lines = await sel('sale_lines', '*', (q) => q.eq('sale_id', saleId).order('id'));
  const l = S.refs.locations.find((x) => x.id === s.location_id);
  const html = `<div class="receipt">
    <div class="c"><b style="font-size:15px">SIX SIGMA SOCCER GOODS</b><br>${esc(l.name)}<br>${esc(l.address || '')}</div><hr>
    <div class="r"><span>Receipt ${docNo('S', s.id)}</span><span>${fdt(s.ts)}</span></div>
    <div class="r"><span>Customer</span><span>${esc(cust(s.customer_id)?.name || 'Walk-in')}</span></div>
    <div class="r"><span>Cashier</span><span>${esc(s.cashier || '')}</span></div><hr>
    ${lines.map((x) => `<div>${esc(item(x.item_id).name)}</div>
      <div class="r"><span>&nbsp; ${num(x.qty)} × ${money(x.unit_price)}${Number(x.discount_pct) ? ` (−${num(x.discount_pct)}%)` : ''}</span><span>${money(x.line_total)}</span></div>`).join('')}
    <hr>
    <div class="r"><span>Subtotal</span><span>${money(s.subtotal)}</span></div>
    <div class="r"><span>Discounts${Number(s.order_discount_pct) ? ` (incl. ${num(s.order_discount_pct)}% order)` : ''}</span><span>−${money(s.discount_total)}</span></div>
    <div class="r"><span>Tax</span><span>${money(s.tax)}</span></div>
    <div class="r"><b>TOTAL</b><b>${money(s.total)}</b></div>
    <div class="r"><span>Paid by</span><span>${esc(s.payment_method)}</span></div><hr>
    <div class="c"><svg id="rcpt-bc"></svg><br><small>Returns within 30 days with receipt.<br>Thank you — see you on the pitch! ⚽</small></div>
  </div>`;
  const m = modal({ title: `Receipt ${docNo('S', s.id)}`, body: html, okText: '🖨 Print', onOk: () => { printDoc(`Receipt S-${s.id}`, m.el.querySelector('.receipt').outerHTML); return false; } });
  try { JsBarcode(m.el.querySelector('#rcpt-bc'), 'S-' + s.id, { format: 'CODE128', height: 40, width: 1.6, fontSize: 12 }); } catch { /* ignore */ }
}
