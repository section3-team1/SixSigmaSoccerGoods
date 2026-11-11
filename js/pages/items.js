// Item master + bill-of-material editor
import { S, sb, sel, money, num, esc, modal, options, table, badge, item, sup, bomOf, formVals, loadRefs, toast, refresh, $, on, itemLabel } from '../lib.js';

const st = { cat: 'All', q: '' };

// valid EAN-13 from 12 digits (adds the check digit), same rule as the database's ean13()
function ean13(d12) {
  const s = [...d12].reduce((a, c, i) => a + Number(c) * (i % 2 ? 3 : 1), 0);
  return d12 + ((10 - (s % 10)) % 10);
}

export async function render(view) {
  const cats = ['All', ...new Set(S.refs.items.map((i) => i.category))];
  const rows = S.refs.items.filter((i) => (st.cat === 'All' || i.category === st.cat) && (!st.q || (i.sku + i.name + i.barcode).toLowerCase().includes(st.q.toLowerCase())));
  view.innerHTML = `
  <div class="toolbar">
    <div class="chips">${cats.map((c) => `<button class="chip ${c === st.cat ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <input id="it-q" placeholder="Search" value="${esc(st.q)}" style="max-width:220px;margin:0">
    <span class="grow"></span><button class="btn primary" id="it-new">+ New item</button>
  </div>
  <div class="card">${table([
    { k: 'sku', label: 'SKU', f: (v) => `<b>${esc(v)}</b>` },
    { k: 'barcode', label: 'Barcode', f: (v) => `<span class="mono">${esc(v)}</span>` },
    { k: 'name', label: 'Name' },
    { k: 'category', label: 'Category' },
    { k: 'item_type', label: 'Type', f: (v, r) => badge(v === 'kit' ? (r.auto_assemble ? 'bundle (BOM)' : 'made to order (BOM)') : v, v === 'kit' ? 'violet' : v === 'component' ? 'gray' : 'blue') },
    { k: 'supplier_id', label: 'Supplier', f: (v) => esc(sup(v)?.name || (v ? '' : 'In-house')) },
    { k: 'unit_cost', label: 'Std cost', cls: 'num', f: (v) => money(v) },
    { k: 'avg_cost', label: 'Avg cost', cls: 'num', f: (v) => money(v) },
    { k: 'price', label: 'Price', cls: 'num', f: (v, r) => (r.sellable ? money(v) : '—') },
    { k: 'lead_time_days', label: 'Lead time', cls: 'num', f: (v) => v + ' d' },
    { k: 'rop_override', label: 'ROP', cls: 'num', f: (v) => (v != null ? `${num(v)} <span class="badge gray">manual</span>` : '<span class="muted">calculated</span>') },
    { k: 'id', label: 'BOM', f: (v) => (bomOf(v).length ? `${bomOf(v).length} parts` : '') },
  ], rows, { rowAttr: (r) => `class="click" data-it="${r.id}"` })}
  <p class="muted small">Reorder points are calculated from sales history in Planning. Set a manual ROP here only to override the calculation.</p></div>`;
  view.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => { st.cat = b.dataset.cat; render(view); }));
  $('#it-q', view).oninput = (e) => { st.q = e.target.value; clearTimeout(st._t); st._t = setTimeout(() => render(view).then(() => { const i = $('#it-q'); i.focus(); i.setSelectionRange(99, 99); }), 300); };
  $('#it-new', view).onclick = () => editItem();
  view.querySelectorAll('[data-it]').forEach((r) => (r.onclick = () => editItem(item(Number(r.dataset.it)))));
}

function bomRow(b = {}) {
  return `<tr><td><select class="bm-c">${options(S.refs.items.filter((i) => i.item_type !== 'kit'), b.component_id, itemLabel)}</select></td>
    <td class="w80"><input class="bm-q" type="number" min="0.01" step="0.01" value="${b.qty || 1}"></td><td><button class="icon-btn bm-rm">✕</button></td></tr>`;
}

function editItem(it = {}) {
  const isNew = !it.id;
  const m = modal({
    title: isNew ? 'New item' : `${esc(it.sku)} · ${esc(it.name)}`, wide: true,
    body: `<div class="row3">
      <label>SKU<input name="sku" value="${esc(it.sku || '')}"></label>
      <label>Barcode (EAN-13)<input name="barcode" value="${esc(it.barcode || '')}" placeholder="auto if blank"></label>
      <label>Name<input name="name" value="${esc(it.name || '')}"></label></div>
    <div class="row3">
      <label>Category<input name="category" value="${esc(it.category || '')}" list="cats"><datalist id="cats">${[...new Set(S.refs.items.map((i) => i.category))].map((c) => `<option>${esc(c)}</option>`).join('')}</datalist></label>
      <label>Type<select name="item_type">${options([{ id: 'product', name: 'Product (buy & sell)' }, { id: 'component', name: 'Component (buy, used in BOMs)' }, { id: 'kit', name: 'Made in-house (has BOM)' }], it.item_type || 'product')}</select></label>
      <label>Supplier<select name="supplier_id"><option value="">In-house / none</option>${options(S.refs.suppliers, it.supplier_id)}</select></label></div>
    <div class="row3">
      <label>Standard cost<input name="unit_cost" type="number" step="0.01" value="${it.unit_cost ?? ''}"></label>
      <label>Price<input name="price" type="number" step="0.01" value="${it.price ?? ''}"></label>
      <label>Lead time (days)<input name="lead_time_days" type="number" min="0" value="${it.lead_time_days ?? 7}"></label></div>
    <div class="row3">
      <label>Manual ROP override<input name="rop_override" type="number" min="0" value="${it.rop_override ?? ''}" placeholder="blank = calculated"></label>
      <label>Defect opportunities / unit<input name="defect_opportunities" type="number" min="1" value="${it.defect_opportunities ?? 1}"></label>
      <label class="chk" style="margin-top:24px"><input type="checkbox" name="auto_assemble" ${it.auto_assemble ? 'checked' : ''}> Kit at counter when sold</label></div>
    <label>Description<input name="description" value="${esc(it.description || '')}"></label>
    <h4 style="margin:12px 0 6px">Bill of material <span class="muted small">(made-in-house items only)</span></h4>
    <table class="tbl"><thead><tr><th>Component</th><th>Qty per unit</th><th></th></tr></thead><tbody id="bm-rows">${bomOf(it.id).map(bomRow).join('')}</tbody></table>
    <button class="btn sm" id="bm-add" style="margin-top:8px">+ Add component</button>`,
    onOk: async (el) => {
      const f = formVals(el);
      const rec = {
        sku: f.sku.trim().toUpperCase(), name: f.name.trim(), category: f.category.trim() || 'General', item_type: f.item_type,
        supplier_id: f.supplier_id ? Number(f.supplier_id) : null, unit_cost: Number(f.unit_cost) || 0, price: Number(f.price) || 0,
        lead_time_days: Number(f.lead_time_days) || 0, rop_override: f.rop_override === '' ? null : Number(f.rop_override),
        defect_opportunities: Number(f.defect_opportunities) || 1, auto_assemble: f.auto_assemble, sellable: f.item_type !== 'component', description: f.description,
      };
      if (!rec.sku || !rec.name) throw new Error('SKU and name are required');
      rec.barcode = f.barcode.trim() || ean13('08500261' + String(Date.now()).slice(-4));
      let id = it.id;
      if (isNew) {
        const r = await sb.from('items').insert(rec).select('id').single();
        if (r.error) throw new Error(r.error.message); id = r.data.id;
      } else {
        const r = await sb.from('items').update(rec).eq('id', id);
        if (r.error) throw new Error(r.error.message);
      }
      const lines = [...el.querySelectorAll('#bm-rows tr')].map((tr) => ({ parent_id: id, component_id: Number($('.bm-c', tr).value), qty: Number($('.bm-q', tr).value) })).filter((b) => b.qty > 0);
      const d = await sb.from('bom').delete().eq('parent_id', id);
      if (d.error) throw new Error(d.error.message);
      if (lines.length) { const r = await sb.from('bom').insert(lines); if (r.error) throw new Error(r.error.message); }
      await loadRefs(); toast('Item saved'); refresh();
    },
  });
  $('#bm-add', m.el).onclick = () => $('#bm-rows', m.el).insertAdjacentHTML('beforeend', bomRow());
  on(m.el, 'click', '.bm-rm', (e, b) => b.closest('tr').remove());
}
