// Customer portal — coaches & players log in, see live availability by store, order for pickup.
import { S, sb, sel, rpc, money, num, esc, act, options, table, badge, fdate, fdt, docNo, today, addDays, stores, item, loc, toast, $, bomOf } from '../lib.js';

const st = { view: 'shop', cat: 'All', cart: [], store: null, date: null };
let root;

export function mount(el) {
  root = el;
  window.__portalRefresh = () => draw();
  draw();
}

async function draw() {
  if (!st.store) st.store = stores()[0]?.id;
  if (!st.date) st.date = addDays(today(), 1);
  const me = S.profile;
  const [inv, myCust] = await Promise.all([
    sel('inventory', 'item_id,location_id,qty'),
    me.customer_id ? sel('customers', '*', (q) => q.eq('id', me.customer_id)) : Promise.resolve([]),
  ]);
  const oh = (i, l) => Number(inv.find((r) => r.item_id === i && r.location_id === l)?.qty || 0);
  const kitAvail = (it, l) => oh(it.id, l) + (it.auto_assemble ? Math.min(...bomOf(it.id).map((b) => Math.floor(oh(b.component_id, l) / b.qty))) : 0);
  const wh = S.refs.locations.find((l) => l.kind === 'warehouse');
  root.innerHTML = `
  <div class="portal-top"><div class="logo">σ</div><b>SSSG Team Store</b>
    <nav><a href="javascript:void 0" data-v="shop" class="${st.view === 'shop' ? 'on' : ''}">Shop & availability</a>
    <a href="javascript:void 0" data-v="orders" class="${st.view === 'orders' ? 'on' : ''}">My orders</a></nav>
    <span class="small">${esc(myCust[0]?.name || me.full_name || me.email)}</span><button class="btn sm" id="pt-out">Sign out</button></div>
  <main class="view" id="pt-body"></main>`;
  root.querySelectorAll('[data-v]').forEach((a) => (a.onclick = () => { st.view = a.dataset.v; draw(); }));
  $('#pt-out', root).onclick = () => sb.auth.signOut();
  const body = $('#pt-body', root);

  if (st.view === 'orders') {
    const orders = await sel('sales_orders', '*', (q) => q.order('id', { ascending: false }));
    const lines = orders.length ? await sel('so_lines', '*', (q) => q.in('so_id', orders.map((o) => o.id))) : [];
    body.innerHTML = `<div class="card"><h3>My orders</h3>${table([
      { k: 'id', label: 'Order', f: (v) => `<b>${docNo('SO', v)}</b>` },
      { k: 'ts', label: 'Placed', f: (v) => fdate(v) },
      { k: 'location_id', label: 'Pickup at', f: (v) => esc(loc(v)?.name) },
      { k: 'requested_date', label: 'Pickup date', f: (v) => fdate(v) },
      { k: 'id', label: 'Items', f: (v) => lines.filter((l) => l.so_id === v).map((l) => `${num(l.qty)}× ${esc(item(l.item_id)?.name || 'item')}`).join('<br>') },
      { k: 'id', label: 'Total', cls: 'num', f: (v) => money(lines.filter((l) => l.so_id === v).reduce((a, l) => a + l.qty * l.unit_price, 0)) },
      { k: 'status', label: 'Status', f: (v) => badge(v === 'fulfilled' ? 'ready for pickup' : v, v === 'fulfilled' ? 'green' : undefined) },
      { k: 'id', label: '', f: (v, r) => (r.status === 'placed' ? `<button class="btn sm danger" data-cancel="${v}">Cancel</button>` : '') },
    ], orders, { empty: 'No orders yet' })}</div>`;
    body.querySelectorAll('[data-cancel]').forEach((b) => (b.onclick = (e) => act(e.currentTarget, () => rpc('cancel_sales_order', { p_so: Number(b.dataset.cancel) }), 'Order cancelled').then(draw).catch(() => {})));
    return;
  }

  const sellable = S.refs.items.filter((i) => i.sellable);
  const cats = ['All', ...new Set(sellable.map((i) => i.category))];
  const total = st.cart.reduce((a, l) => a + l.qty * item(l.id).price, 0);
  body.innerHTML = `
  <div class="grid g3">
    <div class="span2">
      <div class="toolbar"><div class="chips">${cats.map((c) => `<button class="chip ${c === st.cat ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div></div>
      <div class="shop">${sellable.filter((i) => st.cat === 'All' || i.category === st.cat).map((i) => `
        <div class="shop-card"><b>${esc(i.name)}</b><span class="muted small">${esc(i.description || '')}</span><b>${money(i.price)}</b>
          ${stores().map((s) => { const a = kitAvail(i, s.id); return `<div class="avail ${a <= 0 ? 'out' : ''}"><span>📍 ${esc(s.name)}</span><span>${a > 0 ? num(a) + ' in stock' : 'out of stock'}</span></div>`; }).join('')}
          <div class="avail"><span>🏭 ${esc(wh?.name || 'Warehouse')}</span><span>${num(kitAvail(i, wh?.id))}</span></div>
          <button class="btn sm primary" data-add="${i.id}">Add to order</button></div>`).join('')}</div>
    </div>
    <div class="card" style="align-self:start;position:sticky;top:16px">
      <h3>Pickup order</h3>
      ${st.cart.length ? st.cart.map((l, ix) => `<div class="cart-line" style="grid-template-columns:1fr 60px 70px 24px"><span>${esc(item(l.id).name)}</span>
        <input type="number" min="1" value="${l.qty}" data-q="${ix}"><span class="num">${money(l.qty * item(l.id).price)}</span><button class="icon-btn" data-rm="${ix}">✕</button></div>`).join('') : '<div class="empty">Add items from the catalog</div>'}
      <label style="margin-top:12px">Pick up at<select id="pt-store">${options(stores(), st.store)}</select></label>
      <label>Pickup date<input id="pt-date" type="date" min="${today()}" value="${st.date}"></label>
      <div class="totals"><div class="grand"><span>Estimated total</span><span>${money(total)}</span></div><div class="muted small">plus sales tax · pay at pickup</div></div>
      <button class="btn primary block" id="pt-place" style="margin-top:10px" ${st.cart.length ? '' : 'disabled'}>Place pickup order</button>
      <p class="muted small">Item not in stock at your store? Order anyway. We'll transfer it from the warehouse or tell you when it arrives.</p>
    </div>
  </div>`;
  body.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => { st.cat = b.dataset.cat; draw(); }));
  body.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => {
    const id = Number(b.dataset.add); const ex = st.cart.find((l) => l.id === id);
    if (ex) ex.qty++; else st.cart.push({ id, qty: 1 });
    draw();
  }));
  body.querySelectorAll('[data-q]').forEach((i) => (i.onchange = () => { st.cart[i.dataset.q].qty = Math.max(1, Number(i.value) || 1); draw(); }));
  body.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { st.cart.splice(Number(b.dataset.rm), 1); draw(); }));
  $('#pt-store', body).onchange = (e) => (st.store = Number(e.target.value));
  $('#pt-date', body).onchange = (e) => (st.date = e.target.value);
  $('#pt-place', body).onclick = (e) => act(e.currentTarget, async () => {
    const id = await rpc('place_pickup_order', { p_location: st.store, p_requested: st.date, p_lines: st.cart.map((l) => ({ item_id: l.id, qty: l.qty })) });
    st.cart = []; st.view = 'orders';
    toast(`Order ${docNo('SO', id)} placed! We'll have it ready at ${esc(loc(st.store).name)}.`, 'ok', 6000);
    draw();
  }).catch(() => {});
}
