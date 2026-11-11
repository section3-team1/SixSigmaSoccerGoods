// Barcode label sheet — print, cut, and stick on products for the live demo
import { S, esc, money, printDoc, $, toast } from '../lib.js';

const st = { picked: null, copies: 1 };

export async function render(view) {
  if (!st.picked) st.picked = new Set(S.refs.items.map((i) => i.id));
  view.innerHTML = `
  <div class="grid g3">
    <div class="card">
      <h3>Choose labels</h3>
      <div class="toolbar"><button class="btn sm" id="lb-all">All</button><button class="btn sm" id="lb-none">None</button>
        <label style="margin:0">Copies each<input id="lb-copies" type="number" min="1" max="10" value="${st.copies}" style="width:70px"></label></div>
      <div class="scroll" style="max-height:460px">${S.refs.items.map((i) => `<label class="chk"><input type="checkbox" value="${i.id}" ${st.picked.has(i.id) ? 'checked' : ''}> ${esc(i.sku)} — ${esc(i.name)}</label>`).join('')}</div>
      <button class="btn primary block" id="lb-print" style="margin-top:12px">🖨 Print label sheet</button>
      <p class="muted small">Print on plain paper or 1"×2⅝" address labels (30 per sheet). Labels are EAN-13, so they work with USB scanners and phone cameras. Bring them to the demo!</p>
    </div>
    <div class="card span2"><h3>Preview</h3><div class="labels" id="lb-sheet"></div></div>
  </div>`;
  const draw = () => {
    const ids = S.refs.items.filter((i) => st.picked.has(i.id));
    const sheet = $('#lb-sheet', view);
    sheet.innerHTML = ids.flatMap((i) => Array(st.copies).fill(i)).map((i, ix) => `
      <div class="label"><b>${esc(i.name)}</b><small>${esc(i.sku)}${i.sellable ? ' · ' + money(i.price) : ' · component'}</small><svg id="bc-${ix}"></svg></div>`).join('');
    ids.flatMap((i) => Array(st.copies).fill(i)).forEach((i, ix) => {
      try { JsBarcode(`#bc-${ix}`, i.barcode, { format: 'EAN13', height: 46, width: 1.7, fontSize: 13, margin: 2 }); }
      catch { JsBarcode(`#bc-${ix}`, i.barcode, { format: 'CODE128', height: 46, width: 1.4, fontSize: 12, margin: 2 }); }
    });
  };
  draw();
  view.querySelectorAll('.chk input').forEach((c) => (c.onchange = () => { c.checked ? st.picked.add(Number(c.value)) : st.picked.delete(Number(c.value)); draw(); }));
  $('#lb-all', view).onclick = () => { st.picked = new Set(S.refs.items.map((i) => i.id)); render(view); };
  $('#lb-none', view).onclick = () => { st.picked = new Set(); render(view); };
  $('#lb-copies', view).onchange = (e) => { st.copies = Math.max(1, Math.min(10, Number(e.target.value) || 1)); draw(); };
  $('#lb-print', view).onclick = () => {
    if (!st.picked.size) return toast('Pick at least one item', 'warn');
    printDoc('SSSG barcode labels', `<div class="labels">${$('#lb-sheet', view).innerHTML}</div>`, '.labels{grid-template-columns:repeat(3,2.6in);gap:.12in;justify-content:center}.label{border:1px dashed #ddd}');
  };
}
