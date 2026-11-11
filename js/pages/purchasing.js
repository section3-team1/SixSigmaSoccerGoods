// Purchasing & Suppliers — POs (Draft -> Order Sent -> Received -> Closed), receiving by scan,
// payments against terms, supplier master, and the computed supplier scorecard.
import {
  S, sel, rpc, money, money0, num, pct, esc, act, modal, options, table, badge, tabs, fdate, fdt, docNo, item, loc, locLabel,
  itemLabel, sup, setting, formVals, sb, loadRefs, itemByCode, scanField, cameraScan, toast, refresh, $, on, beep, today, addDays, chart, COLORS,
} from '../lib.js';

const st = { tab: 'pos', status: 'open' };

export async function render(view) {
  view.innerHTML = `${tabs('pu', [['pos', 'Purchase orders'], ['scorecard', 'Supplier scorecard'], ['suppliers', 'Suppliers']], st.tab)}<div id="pu-body"></div>`;
  view.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { st.tab = b.dataset.tab; render(view); }));
  const body = $('#pu-body', view);
  if (st.tab === 'pos') await poList(body);
  if (st.tab === 'scorecard') await scorecard(body);
  if (st.tab === 'suppliers') await suppliers(body);
}

async function poList(body) {
  const rows = await sel('v_po_summary', '*', (q) => {
    q = q.order('id', { ascending: false }).limit(200);
    if (st.status === 'open') q = q.in('status', ['draft', 'sent', 'partial']);
    else if (st.status === 'unpaid') q = q.gt('amount_owed', 0);
    else if (st.status !== 'all') q = q.eq('status', st.status);
    return q;
  });
  body.innerHTML = `
  <div class="toolbar">
    <div class="chips">${[['open', 'Open'], ['received', 'Received'], ['closed', 'Closed'], ['unpaid', 'Amount owed'], ['all', 'All']]
      .map(([k, l]) => `<button class="chip ${k === st.status ? 'on' : ''}" data-st="${k}">${l}</button>`).join('')}</div>
    <span class="grow"></span><button class="btn primary" id="po-new">+ New purchase order</button>
  </div>
  <div class="card">${table([
    { k: 'id', label: 'PO', f: (v) => `<b>${docNo('PO', v)}</b>` },
    { k: 'supplier_name', label: 'Supplier' },
    { k: 'order_date', label: 'Sent', f: (v) => fdate(v) },
    { k: 'expected_date', label: 'Expected', f: (v, r) => `${fdate(v)}${r.overdue ? ' <span class="badge red">late</span>' : ''}` },
    { k: 'first_receipt_at', label: 'Received', f: (v) => (v ? fdate(v) : '—') },
    { k: 'actual_lead_days', label: 'Lead time (act / quoted)', cls: 'num', f: (v, r) => (v != null ? `${v} / ${r.quoted_lead_days} d` : r.quoted_lead_days != null ? `— / ${r.quoted_lead_days} d` : '—') },
    { k: 'on_time', label: 'On time', f: (v) => (v === true ? badge('on time', 'green') : v === false ? badge('late', 'red') : '') },
    { k: 'ordered_value', label: 'Ordered', cls: 'num', f: (v) => money(v) },
    { k: 'qty_received', label: 'Fill', cls: 'num', f: (v, r) => (r.first_receipt_at ? pct(v / r.qty_ordered, 0) : '—') },
    { k: 'amount_owed', label: 'Owed', cls: 'num', f: (v) => (v > 0 ? money(v) : '—') },
    { k: 'due_date', label: 'Due', f: (v, r) => (r.amount_owed > 0 ? `${fdate(v)}${v < today() ? ' <span class="badge red">overdue</span>' : ''}` : '') },
    { k: 'status', label: 'Status', f: (v) => badge(v === 'sent' ? 'order sent' : v, { sent: 'blue' }[v]) },
  ], rows, { rowAttr: (r) => `class="click" data-po="${r.id}"`, empty: 'No purchase orders here' })}</div>`;
  body.querySelectorAll('[data-st]').forEach((b) => (b.onclick = () => { st.status = b.dataset.st; poList(body); }));
  $('#po-new', body).onclick = () => newPO();
  body.querySelectorAll('[data-po]').forEach((r) => (r.onclick = () => openPO(Number(r.dataset.po))));
}

const poLine = (l = {}, supplierId) => {
  const list = S.refs.items.filter((i) => i.item_type !== 'kit' && (!supplierId || i.supplier_id === supplierId));
  return `<tr><td><select class="pl-item"><option value="">Select…</option>${options(list, l.item_id, itemLabel)}</select></td>
    <td class="w80"><input class="pl-qty" type="number" min="1" value="${l.qty || ''}"></td>
    <td class="w80"><input class="pl-cost" type="number" step="0.01" value="${l.unit_cost ?? (l.item_id ? Number(item(l.item_id).unit_cost).toFixed(2) : '')}"></td>
    <td><button class="icon-btn pl-rm">✕</button></td></tr>`;
};

// preset: { supplier, lines:[{item_id, qty}] } — used by Planning/MRP "Create PO"
export function newPO(preset = {}) {
  const supId = preset.supplier || S.refs.suppliers[0]?.id;
  const m = modal({
    title: 'New purchase order', wide: true, okText: 'Create & send to supplier',
    body: `<div class="row3">
        <label>Supplier<select name="sup">${options(S.refs.suppliers, supId)}</select></label>
        <label>Receive into<select name="loc">${options(S.refs.locations.filter((l) => l.kind !== 'qc'), preset.loc || 3, locLabel)}</select></label>
        <label>Expected receipt<input name="exp" disabled></label></div>
      <table class="tbl"><thead><tr><th>Item</th><th>Qty</th><th>Unit cost</th><th></th></tr></thead>
        <tbody id="po-lines">${(preset.lines?.length ? preset.lines : [{}]).map((l) => poLine(l, supId)).join('')}</tbody></table>
      <button class="btn sm" id="po-add" style="margin-top:8px">+ Add line</button>
      <div class="row2" style="margin-top:12px"><label>Notes<input name="notes" value="${esc(preset.notes || '')}"></label>
      <label class="chk" style="margin-top:22px"><input type="checkbox" name="send" checked> Send now (otherwise saved as draft)</label></div>
      <p class="note" id="po-terms"></p>`,
    onOk: async (el) => {
      const ls = [...el.querySelectorAll('#po-lines tr')].map((tr) => ({ item_id: Number($('.pl-item', tr).value), qty: Number($('.pl-qty', tr).value), unit_cost: Number($('.pl-cost', tr).value) || undefined }))
        .filter((l) => l.item_id && l.qty > 0);
      if (!ls.length) throw new Error('Add at least one line');
      const id = await rpc('create_purchase_order', { p_supplier: Number(el.querySelector('[name=sup]').value), p_location: Number(el.querySelector('[name=loc]').value),
        p_lines: ls, p_send: el.querySelector('[name=send]').checked, p_notes: el.querySelector('[name=notes]').value || null });
      toast(`${docNo('PO', id)} created`); refresh(); setTimeout(() => openPO(id), 300);
    },
  });
  const supSel = m.el.querySelector('[name=sup]');
  const showTerms = () => {
    const s = sup(Number(supSel.value));
    m.el.querySelector('[name=exp]').value = fdate(addDays(today(), s.lead_time_days));
    $('#po-terms', m.el).innerHTML = `<b>${esc(s.name)}</b> quotes a <b>${s.lead_time_days}-day</b> lead time, so the expected receipt is <b>${fdate(addDays(today(), s.lead_time_days))}</b>. Terms are <b>${esc(s.payment_terms)}</b>: payment is due ${s.terms_days} days after receipt. Contact: ${esc(s.contact_name || '')} ${esc(s.email || '')}`;
  };
  supSel.onchange = () => { showTerms(); $('#po-lines', m.el).innerHTML = poLine({}, Number(supSel.value)); };
  showTerms();
  $('#po-add', m.el).onclick = () => $('#po-lines', m.el).insertAdjacentHTML('beforeend', poLine({}, Number(supSel.value)));
  on(m.el, 'click', '.pl-rm', (e, b) => b.closest('tr').remove());
  on(m.el, 'change', '.pl-item', (e, s) => { const c = s.closest('tr').querySelector('.pl-cost'); if (s.value) c.value = Number(item(Number(s.value)).unit_cost).toFixed(2); });
}

export async function openPO(id) {
  const [p] = await sel('v_po_summary', '*', (q) => q.eq('id', id));
  const [lines, receipts, pays] = await Promise.all([
    sel('po_lines', '*', (q) => q.eq('po_id', id).order('id')),
    sel('po_receipts', '*', (q) => q.eq('po_id', id).order('ts')),
    sel('po_payments', '*', (q) => q.eq('po_id', id).order('ts')),
  ]);
  const m = modal({
    title: `${docNo('PO', p.id)} · ${esc(p.supplier_name)}`, wide: true, hideOk: true, cancelText: 'Close',
    body: `
    <div class="kpis">
      <div class="kpi"><div class="kpi-l">Status</div><div class="kpi-v">${badge(p.status === 'sent' ? 'order sent' : p.status, { sent: 'blue' }[p.status])}</div><div class="kpi-s">created by ${esc(p.created_by || '')}</div></div>
      <div class="kpi"><div class="kpi-l">Sent → expected</div><div class="kpi-v" style="font-size:15px">${fdate(p.order_date)} → ${fdate(p.expected_date)}</div><div class="kpi-s">quoted lead time ${p.quoted_lead_days ?? '—'} days</div></div>
      <div class="kpi ${p.on_time === false ? 'bad' : p.on_time ? 'good' : ''}"><div class="kpi-l">Actual receipt</div><div class="kpi-v" style="font-size:15px">${p.first_receipt_at ? fdate(p.first_receipt_at) : 'not yet'}</div><div class="kpi-s">${p.actual_lead_days != null ? `actual lead ${p.actual_lead_days} d · ${p.on_time ? 'on time' : 'LATE by ' + (p.actual_lead_days - p.quoted_lead_days) + ' d'}` : p.overdue ? 'past expected date' : ''}</div></div>
      <div class="kpi"><div class="kpi-l">Ordered / received value</div><div class="kpi-v" style="font-size:16px">${money(p.ordered_value)} / ${money(p.received_value)}</div><div class="kpi-s">fill ${p.qty_ordered ? pct(p.qty_received / p.qty_ordered, 0) : '—'}</div></div>
      <div class="kpi ${p.amount_owed > 0 && p.due_date < today() ? 'bad' : ''}"><div class="kpi-l">Owed (${esc(p.payment_terms)})</div><div class="kpi-v">${money(p.amount_owed)}</div><div class="kpi-s">${p.due_date ? 'due ' + fdate(p.due_date) : 'due date set at receipt'} · paid ${money(p.paid_total)}</div></div>
    </div>
    ${table([
      { k: 'item_id', label: 'Item', f: (v) => `${esc(item(v).sku)} — ${esc(item(v).name)}<div class="muted small mono">${esc(item(v).barcode)}</div>` },
      { k: 'qty_ordered', label: 'Ordered', cls: 'num', f: (v) => num(v) },
      { k: 'qty_received', label: 'Received', cls: 'num', f: (v) => num(v) },
      { k: 'unit_cost', label: 'Unit cost', cls: 'num', f: (v) => money(v) },
      { k: 'id', label: ['sent', 'partial'].includes(p.status) ? 'Receive now' : 'Open', cls: 'w80', f: (v, r) => (['sent', 'partial'].includes(p.status)
        ? `<input type="number" class="rc-q" data-line="${v}" data-item="${r.item_id}" min="0" max="${r.qty_ordered - r.qty_received}" value="0">` : num(r.qty_ordered - r.qty_received)) },
    ], lines)}
    ${['sent', 'partial'].includes(p.status) ? `
      <div class="inline" style="margin-top:12px">
        <div class="scanbar" style="flex:1"><input id="rc-scan" placeholder="Scan each item to receive it (+1 per scan)"><button class="btn blue" id="rc-cam">📷</button></div>
        <button class="btn" id="rc-all">Fill all remaining</button>
        <label>Receive into<select id="rc-loc">${options(S.refs.locations.filter((l) => l.kind !== 'qc'), p.location_id, locLabel)}</select></label>
        <button class="btn primary" id="rc-go">Post receipt</button>
      </div>` : ''}
    ${receipts.length ? `<h4 style="margin:14px 0 8px">Receipts</h4>${table([
      { k: 'ts', label: 'Date', f: (v) => fdt(v) },
      { k: 'po_line_id', label: 'Item', f: (v) => esc(item(lines.find((l) => l.id === v).item_id).sku) },
      { k: 'qty', label: 'Qty', cls: 'num', f: (v) => num(v) },
      { k: 'location_id', label: 'Into', f: (v) => esc(loc(v).code) },
      { k: 'received_by', label: 'By' },
    ], receipts)}` : ''}
    ${pays.length ? `<h4 style="margin:14px 0 8px">Payments</h4>${table([{ k: 'ts', label: 'Date', f: (v) => fdt(v) }, { k: 'amount', label: 'Amount', cls: 'num', f: (v) => money(v) }, { k: 'method', label: 'Method' }], pays)}` : ''}
    <div class="toolbar" style="margin-top:14px">
      ${p.status === 'draft' ? '<button class="btn blue" id="po-send">Send to supplier</button>' : ''}
      ${p.amount_owed > 0 ? `<input id="pay-amt" type="number" step="0.01" value="${p.amount_owed}" style="max-width:130px;margin:0"><button class="btn" id="po-pay">Record payment</button>` : ''}
      ${['sent', 'partial', 'received'].includes(p.status) ? `<button class="btn" id="po-close">${p.status === 'received' ? 'Close PO' : 'Close PO (short-close remaining)'}</button>` : ''}
      ${['draft', 'sent'].includes(p.status) && !p.first_receipt_at ? '<button class="btn danger" id="po-cancel">Cancel PO</button>' : ''}
    </div>`,
  });
  const reopen = () => { m.close(); refresh(); setTimeout(() => openPO(id), 300); };
  const scanAdd = (code) => {
    const it = itemByCode(code);
    const inp = it && m.el.querySelector(`.rc-q[data-item="${it.id}"]`);
    if (!inp) return toast(`${esc(code)} is not on this PO`, 'err');
    if (Number(inp.value) >= Number(inp.max)) return toast(`All ${inp.max} of ${esc(it.sku)} already counted`, 'warn');
    inp.value = Number(inp.value) + 1; beep();
    inp.closest('tr').classList.add('hl');
  };
  if ($('#rc-scan', m.el)) {
    scanField($('#rc-scan', m.el), scanAdd);
    $('#rc-cam', m.el).onclick = () => cameraScan(scanAdd, { continuous: true });
    $('#rc-all', m.el).onclick = () => m.el.querySelectorAll('.rc-q').forEach((i) => (i.value = i.max));
    $('#rc-go', m.el).onclick = (e) => {
      const ls = [...m.el.querySelectorAll('.rc-q')].map((i) => ({ po_line_id: Number(i.dataset.line), qty: Number(i.value) || 0 })).filter((l) => l.qty > 0);
      if (!ls.length) return toast('Enter or scan quantities to receive', 'warn');
      act(e.currentTarget, () => rpc('receive_purchase_order', { p_po: id, p_lines: ls, p_location: Number($('#rc-loc', m.el).value) }), 'Receipt posted — inventory increased').then(reopen).catch(() => {});
    };
  }
  $('#po-send', m.el)?.addEventListener('click', (e) => act(e.currentTarget, () => rpc('send_purchase_order', { p_po: id }), 'Sent — expected date set from lead time').then(reopen).catch(() => {}));
  $('#po-pay', m.el)?.addEventListener('click', (e) => act(e.currentTarget, () => rpc('pay_purchase_order', { p_po: id, p_amount: Number($('#pay-amt', m.el).value) }), 'Payment recorded').then(reopen).catch(() => {}));
  $('#po-close', m.el)?.addEventListener('click', (e) => act(e.currentTarget, () => rpc('close_purchase_order', { p_po: id }), 'PO closed').then(reopen).catch(() => {}));
  $('#po-cancel', m.el)?.addEventListener('click', (e) => act(e.currentTarget, () => rpc('cancel_purchase_order', { p_po: id }), 'PO cancelled').then(reopen).catch(() => {}));
}

async function scorecard(body) {
  const rows = await sel('v_supplier_scorecard', '*', (q) => q.order('score', { ascending: false }));
  const w = [setting('score_w_ontime'), setting('score_w_fill'), setting('score_w_lead')];
  const tw = w.reduce((a, b) => a + b, 0) || 1;
  const meter = (v) => `<div class="meter"><i style="width:${Math.max(0, Math.min(100, (v || 0) * 100))}%"></i></div>`;
  body.innerHTML = `
  <div class="note" style="margin-bottom:14px">Every measure is computed from purchase-order history. Nothing is typed in.
    <b>Score</b> = ${num((w[0] / tw) * 100)}% on-time rate + ${num((w[1] / tw) * 100)}% fill rate + ${num((w[2] / tw) * 100)}% lead-time accuracy (quoted ÷ actual, capped at 100%).
    <b>Keep</b> ≥ ${setting('score_keep')} · <b>Watch</b> ≥ ${setting('score_watch')} · otherwise <b>Replace</b>. Change the weights and thresholds in Settings.</div>
  <div class="sc">${rows.map((r) => `
    <div class="sc-card">
      <div class="sc-top"><div><b style="font-size:15px">${esc(r.name)}</b><div class="muted small">${esc(r.contact_name || '')} · ${esc(r.payment_terms)}</div></div>
        <div style="text-align:right"><div class="sc-score">${r.score ?? '—'}</div>${badge(r.rating)}</div></div>
      <div class="sc-row"><span>On-time delivery</span><b>${pct(r.on_time_rate, 0)}</b></div>${meter(r.on_time_rate)}
      <div class="sc-row"><span>Fill rate (received ÷ ordered)</span><b>${pct(r.fill_rate, 1)}</b></div>${meter(r.fill_rate)}
      <div class="sc-row"><span>Avg actual vs quoted lead time</span><b>${num(r.avg_actual_lead_days, 1)} vs ${r.quoted_lead_days} d</b></div>${meter(r.lead_time_accuracy)}
      <div class="sc-row" style="margin-top:6px"><span>POs / delivered</span><span>${r.po_count} / ${r.delivered_count}</span></div>
      <div class="sc-row"><span>Total spend received</span><span>${money0(r.spend)}</span></div>
      <div class="sc-row"><span>Amount owed</span><span>${money(r.amount_owed)}${r.next_due_date ? ` · next due ${fdate(r.next_due_date)}` : ''}</span></div>
      <div class="sc-row"><span>Overdue to supplier</span><span class="${r.amount_overdue > 0 ? 'neg' : ''}">${money(r.amount_overdue)}</span></div>
    </div>`).join('')}</div>
  <div class="card" style="margin-top:16px"><h3>Average actual vs. quoted lead time (days)</h3><div class="chart-box"><canvas id="sc-lt"></canvas></div></div>`;
  chart($('#sc-lt', body), {
    type: 'bar',
    data: { labels: rows.map((r) => r.name), datasets: [
      { label: 'Quoted', data: rows.map((r) => r.quoted_lead_days), backgroundColor: COLORS.s1, borderRadius: 4, maxBarThickness: 28 },
      { label: 'Actual (avg)', data: rows.map((r) => Math.round(Number(r.avg_actual_lead_days || 0) * 10) / 10), backgroundColor: COLORS.s2, borderRadius: 4, maxBarThickness: 28 }] },
  });
}

async function suppliers(body) {
  const rows = S.refs.suppliers;
  body.innerHTML = `<div class="toolbar"><span class="grow"></span><button class="btn primary" id="sp-new">+ Add supplier</button></div>
  <div class="card">${table([
    { k: 'name', label: 'Supplier', f: (v, r) => `<b>${esc(v)}</b><div class="muted small">${esc(r.notes || '')}</div>` },
    { k: 'contact_name', label: 'Contact' },
    { k: 'email', label: 'Email', f: (v) => (v ? `<a href="mailto:${esc(v)}">${esc(v)}</a>` : '') },
    { k: 'phone', label: 'Phone' },
    { k: 'lead_time_days', label: 'Quoted lead time', cls: 'num', f: (v) => v + ' days' },
    { k: 'payment_terms', label: 'Terms' },
    { k: 'id', label: 'Items', cls: 'num', f: (v) => S.refs.items.filter((i) => i.supplier_id === v).length },
    { k: 'id', label: '', f: (v) => `<button class="btn sm" data-ed="${v}">Edit</button>` },
  ], rows)}</div>`;
  $('#sp-new', body).onclick = () => editSupplier();
  body.querySelectorAll('[data-ed]').forEach((b) => (b.onclick = () => editSupplier(sup(Number(b.dataset.ed)))));
}

function editSupplier(s = {}) {
  modal({
    title: s.id ? `Edit ${esc(s.name)}` : 'Add supplier',
    body: `<label>Name<input name="name" value="${esc(s.name || '')}" required></label>
      <div class="row2"><label>Contact name<input name="contact_name" value="${esc(s.contact_name || '')}"></label>
      <label>Email<input name="email" type="email" value="${esc(s.email || '')}"></label></div>
      <div class="row2"><label>Phone<input name="phone" value="${esc(s.phone || '')}"></label>
      <label>Address<input name="address" value="${esc(s.address || '')}"></label></div>
      <div class="row3"><label>Quoted lead time (days)<input name="lead_time_days" type="number" min="0" value="${s.lead_time_days ?? 14}"></label>
      <label>Payment terms<select name="payment_terms">${['Net 15', 'Net 30', 'Net 45', 'Net 60', 'Due on receipt'].map((t) => `<option ${t === s.payment_terms ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>Notes<input name="notes" value="${esc(s.notes || '')}"></label></div>
      ${s.id ? '<label class="chk"><input type="checkbox" name="sync" checked> Also update the lead time on this supplier\'s items (drives ROP and MRP)</label>' : ''}`,
    onOk: async (el) => {
      const f = formVals(el);
      const rec = { name: f.name, contact_name: f.contact_name, email: f.email, phone: f.phone, address: f.address,
        lead_time_days: Number(f.lead_time_days), payment_terms: f.payment_terms,
        terms_days: f.payment_terms === 'Due on receipt' ? 0 : Number(f.payment_terms.replace(/\D/g, '')), notes: f.notes };
      if (!rec.name) throw new Error('Name is required');
      const res = s.id ? await sb.from('suppliers').update(rec).eq('id', s.id) : await sb.from('suppliers').insert(rec);
      if (res.error) throw new Error(res.error.message);
      if (s.id && f.sync) {
        const r2 = await sb.from('items').update({ lead_time_days: rec.lead_time_days }).eq('supplier_id', s.id);
        if (r2.error) throw new Error(r2.error.message);
      }
      await loadRefs(); toast('Supplier saved'); refresh();
    },
  });
}
