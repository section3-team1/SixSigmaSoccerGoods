// Settings (editable inputs that drive EOQ, ROP, tax, P&L, scorecard) + users & roles
import { S, sb, sel, rpc, esc, table, badge, isManager, loadRefs, toast, act, refresh, $, cust, fdt, modal } from '../lib.js';

export async function render(view) {
  const users = await sel('profiles', '*', (q) => q.order('created_at'));
  const groups = {};
  S.refs.settings.forEach((s) => (groups[s.grp] ||= []).push(s));
  const mgr = isManager();
  const show = (s) => (s.unit === 'rate' ? (Number(s.value) * 100).toFixed(2) : s.value);
  view.innerHTML = `
  ${mgr ? '' : '<div class="note" style="margin-bottom:14px">Only a <b>manager</b> can change settings or roles. You can view them.</div>'}
  <div class="grid g2">
    ${Object.entries(groups).map(([g, list]) => `
      <div class="card"><h3>${esc(g)}</h3>
        ${list.map((s) => `<label>${esc(s.label)} <span class="muted">${s.unit === 'rate' ? '(%)' : s.unit ? '(' + esc(s.unit) + ')' : ''}</span>
          <input data-key="${s.key}" data-unit="${s.unit}" type="number" step="any" value="${show(s)}" ${mgr ? '' : 'disabled'}></label>`).join('')}
      </div>`).join('')}
  </div>
  ${mgr ? '<div class="toolbar" style="margin-top:14px"><span class="grow"></span><button class="btn primary" id="set-save">Save settings</button></div>' : ''}
  <div class="card"><h3>Users & roles <span class="r muted small">New staff sign up with the staff code; customers sign up with their team email</span></h3>${table([
    { k: 'full_name', label: 'Name', f: (v, r) => `<b>${esc(v || '')}</b>` },
    { k: 'email', label: 'Email' },
    { k: 'role', label: 'Role', f: (v, r) => (mgr && r.id !== S.profile.id
      ? `<select data-role="${r.id}" style="max-width:140px;margin:0">${['manager', 'staff', 'customer'].map((x) => `<option ${x === v ? 'selected' : ''}>${x}</option>`).join('')}</select>`
      : badge(v, v === 'manager' ? 'violet' : v === 'staff' ? 'blue' : 'gray')) },
    { k: 'customer_id', label: 'Linked customer', f: (v) => esc(cust(v)?.name || '') },
    { k: 'created_at', label: 'Joined', f: (v) => fdt(v) },
  ], users)}</div>
  ${mgr ? `<div class="card"><h3>Demo data</h3>
    <p>Rebuild all items, suppliers and 6 months of history ending <b>today</b>. Every transaction since the last reset is erased. Customers and user logins are kept.</p>
    <button class="btn danger" id="set-reset">Reset demo data…</button>
    <p class="muted small">If this times out on Supabase's free tier, run <code>select seed_demo();</code> in the Supabase SQL Editor instead.</p></div>` : ''}`;

  $('#set-save', view)?.addEventListener('click', (e) => act(e.currentTarget, async () => {
    for (const i of view.querySelectorAll('[data-key]')) {
      const v = i.dataset.unit === 'rate' ? Number(i.value) / 100 : Number(i.value);
      const cur = S.refs.settings.find((s) => s.key === i.dataset.key);
      if (Number(cur.value) !== v) {
        const r = await sb.from('settings').update({ value: v }).eq('key', i.dataset.key);
        if (r.error) throw new Error(r.error.message);
      }
    }
    await loadRefs(); refresh();
  }, 'Settings saved. EOQ, ROP, P&L and scorecards recalculate everywhere.').catch(() => {}));
  view.querySelectorAll('[data-role]').forEach((s) => (s.onchange = async () => {
    const r = await sb.from('profiles').update({ role: s.value }).eq('id', s.dataset.role);
    if (r.error) toast(esc(r.error.message), 'err'); else toast('Role updated');
  }));
  $('#set-reset', view)?.addEventListener('click', () => modal({
    title: 'Reset demo data?', okText: 'Yes, rebuild everything',
    body: '<p>This deletes every sale, order, PO, work order and return, then regenerates 6 months of realistic history ending today. It takes about 5–15 seconds.</p>',
    onOk: async () => { const msg = await rpc('seed_demo', {}); await loadRefs(); toast(esc(msg), 'ok', 8000); refresh(); },
  }));
}
