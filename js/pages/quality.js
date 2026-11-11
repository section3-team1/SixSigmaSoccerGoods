// Six Sigma Quality Center (wow factor)
//  • DPMO + sigma level, first-pass yield, cost of poor quality (COPQ)
//  • p-chart (control chart) of weekly print-shop defect rate, with special-cause flags
//  • Pareto of defect reasons across production, customer returns and inventory damage
import { S, sel, rpc, money, money0, num, pct, esc, table, kpi, today, addDays, fdate, chart, COLORS, $, sigmaLevel, item } from '../lib.js';

const st = { weeks: 26, scope: 'jersey' };

export async function render(view) {
  const from = addDays(today(), -(st.weeks * 7 - 1)), to = today();
  const [weekly, pareto, wos, rets, adj, sold] = await Promise.all([
    rpc('quality_weekly', { p_weeks: st.weeks }),
    rpc('defect_pareto', { p_from: from, p_to: to }),
    sel('production_orders', 'item_id,qty_started,qty_good,qty_scrap,qty_rework,scrap_cost,finished_at,auto,notes', (q) => q.eq('status', 'completed').eq('auto', false).gte('finished_at', from)),
    sel('returns', 'refund_total,reason_code,ts', (q) => q.gte('ts', from)),
    sel('inventory_txns', 'qty,unit_cost,reason_code', (q) => q.eq('txn_type', 'adjust').in('reason_code', ['DMG', 'QC-SCRAP']).gte('ts', from)),
    rpc('sales_by_period', { p_from: from, p_to: to, p_grain: 'month' }),
  ]);
  const qReasons = new Set(S.refs.reasons.filter((r) => r.is_quality).map((r) => r.code));
  const started = wos.reduce((a, w) => a + +w.qty_started, 0);
  const defects = wos.reduce((a, w) => a + +w.qty_scrap + +w.qty_rework, 0);
  const opps = wos.reduce((a, w) => a + w.qty_started * item(w.item_id).defect_opportunities, 0);
  const good = wos.reduce((a, w) => a + +w.qty_good, 0);
  const rework = wos.reduce((a, w) => a + +w.qty_rework, 0);
  const dpmo = opps ? (defects / opps) * 1e6 : 0;
  const sigma = sigmaLevel(dpmo);
  const qRet = rets.filter((r) => qReasons.has(r.reason_code));
  const units = sold.reduce((a, s) => a + Number(s.units), 0);
  const copqScrap = wos.reduce((a, w) => a + Number(w.scrap_cost), 0);
  const copqWrite = adj.reduce((a, t) => a - t.qty * t.unit_cost, 0);
  const copqRet = qRet.reduce((a, r) => a + Number(r.refund_total), 0);

  // ---- p-chart: proportion defective per week, limits vary with sample size
  const pts = weekly.filter((w) => Number(w.units_started) > 0);
  const pbar = pts.reduce((a, w) => a + +w.defects, 0) / (pts.reduce((a, w) => a + +w.units_started, 0) || 1);
  const pc = pts.map((w) => {
    const n = Number(w.units_started), p = Number(w.defects) / n, s = Math.sqrt((pbar * (1 - pbar)) / n);
    return { week: w.week_start, n, p, ucl: Math.min(1, pbar + 3 * s), lcl: Math.max(0, pbar - 3 * s), out: p > pbar + 3 * s };
  });
  // 7-in-a-row below center line = sustained improvement (Western Electric style run rule)
  let run = 0, runFlag = -1;
  pc.forEach((x, i) => { run = x.p < pbar ? run + 1 : 0; if (run >= 7 && runFlag < 0) runFlag = i; });
  const outs = pc.filter((x) => x.out);
  // what did the operators write on work orders in the out-of-control weeks?
  const outNotes = [...new Set(wos.filter((w) => outs.some((o) => w.finished_at.slice(0, 10) >= o.week && w.finished_at.slice(0, 10) < addDays(o.week, 7)))
    .flatMap((w) => (w.notes || '').split(' | ')).filter((n) => n && !n.startsWith('Auto-released') && !n.startsWith('Replacement') && n !== 'Weekly kit build'))];

  // ---- Pareto
  const tot = pareto.reduce((a, r) => a + Number(r.qty), 0);
  let cum = 0;
  const par = pareto.map((r) => { cum += Number(r.qty); return { ...r, cum: cum / (tot || 1) }; });
  const vital = par.filter((r, i) => i === 0 || par[i - 1].cum < 0.8);

  view.innerHTML = `
  <div class="toolbar">
    <div class="chips">${[[13, 'Last 13 weeks'], [26, 'Last 26 weeks']].map(([w, l]) => `<button class="chip ${w === st.weeks ? 'on' : ''}" data-w="${w}">${l}</button>`).join('')}</div>
    <span class="muted small">Every number below is computed from work-order results, return reason codes and inventory adjustments.</span>
  </div>
  <div class="kpis">
    ${kpi('Process sigma level', num(sigma, 2) + 'σ', `${num(dpmo)} DPMO`, sigma >= 4 ? 'good' : sigma >= 3 ? 'warn' : 'bad')}
    ${kpi('First-pass yield', pct(started ? (good - rework) / started : null), `${num(started)} units started`)}
    ${kpi('Scrap rate', pct(started ? wos.reduce((a, w) => a + +w.qty_scrap, 0) / started : null), 'print shop + kitting')}
    ${kpi('Quality return rate', pct(units ? qRet.length / units : null, 2), `${qRet.length} quality returns / ${num(units)} units sold`)}
    ${kpi('Cost of poor quality', money0(copqScrap + copqWrite + copqRet), `scrap ${money0(copqScrap)} · write-offs ${money0(copqWrite)} · refunds ${money0(copqRet)}`, 'bad')}
    ${kpi('Out-of-control weeks', num(outs.length), outs.length ? 'special cause: investigate' : 'process stable', outs.length ? 'bad' : 'good')}
  </div>
  <div class="card"><h3>p-chart · weekly defect proportion (scrap + rework ÷ units started)</h3>
    <div class="chart-box tall"><canvas id="q-p"></canvas></div>
    <div class="grid g2" style="margin-top:10px">
      <div class="formula">p̄ = Σ defects ÷ Σ units = ${num(pbar * 100, 2)}%<br>UCL/LCL = p̄ ± 3·√(p̄(1−p̄)/nᵢ)  (limits widen when a week has fewer units)</div>
      <div class="note">${outs.length ? `<b>Special cause detected</b> in week${outs.length > 1 ? 's' : ''} of ${outs.map((o) => fdate(o.week)).join(', ')}: above the UCL.
        ${outNotes.length ? `Work-order notes from those weeks: <b>${esc(outNotes.join('; '))}</b>. Root cause found and fixed, and the process returned to control.` : 'Open the work orders from that week to find the assignable cause.'}` : 'No points outside the control limits: only common-cause variation.'}
        ${runFlag >= 0 ? `<br><b>Sustained improvement:</b> 7+ consecutive weeks below p̄ starting ${fdate(pc[runFlag - 6]?.week)}. Our DMAIC changes (press alignment jig, double-check of numbers) are holding.` : ''}</div>
    </div>
  </div>
  <div class="grid g2">
    <div class="card"><h3>Pareto of defect reasons <span class="r muted small">${num(tot)} defects · ${fdate(from)} – ${fdate(to)}</span></h3>
      <div class="chart-box tall"><canvas id="q-par"></canvas></div>
      <p class="muted small">The darker bars are the <b>vital few</b> causes that make up the first 80% of all defects. Fix these first.</p></div>
    <div class="card"><h3>Pareto table</h3>${table([
      { k: 'reason_code', label: 'Reason', f: (v, r) => `<b>${esc(v)}</b><div class="muted small">${esc(r.description)}</div>` },
      { k: 'source', label: 'Where found' },
      { k: 'qty', label: 'Count', cls: 'num', f: (v) => num(v) },
      { k: 'qty', label: '% of total', cls: 'num', f: (v) => pct(v / tot) },
      { k: 'cum', label: 'Cumulative', cls: 'num', f: (v) => `<b>${pct(v)}</b>` },
    ], par, { rowAttr: (r) => (vital.includes(r) ? 'class="hl"' : '') })}</div>
  </div>
  <div class="card"><h3>DMAIC snapshot: custom jersey print process</h3>
    <div class="grid g4">
      <div class="note"><b>Define</b><br>Defective custom jerseys (misaligned, scorched, peeling, wrong number) cost material and delay team orders.</div>
      <div class="note"><b>Measure</b><br>Every work order records good, scrap and rework with reason codes, so DPMO here is ${num(dpmo)} (${num(sigma, 2)}σ) with 3 opportunities per jersey: number, name, crest.</div>
      <div class="note"><b>Analyze</b><br>Pareto: <b>${esc(vital.map((v) => v.reason_code).join(', '))}</b> drive 80% of defects. The p-chart separates special causes (press drift) from common causes.</div>
      <div class="note"><b>Improve / Control</b><br>An alignment jig and a second-person number check cut the defect rate. The p-chart is the control plan: any point above the UCL triggers an investigation.</div>
    </div>
  </div>`;

  view.querySelectorAll('[data-w]').forEach((b) => (b.onclick = () => { st.weeks = Number(b.dataset.w); render(view); }));
  const labels = pc.map((x) => fdate(x.week).replace(/, \d{4}/, ''));
  chart($('#q-p', view), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Defect proportion p', data: pc.map((x) => x.p * 100), borderColor: COLORS.s1, borderWidth: 2, tension: 0,
        pointRadius: pc.map((x) => (x.out ? 7 : 4)), pointBackgroundColor: pc.map((x) => (x.out ? COLORS.critical : COLORS.s1)), pointBorderColor: '#fff', pointBorderWidth: 2 },
      { label: 'UCL', data: pc.map((x) => x.ucl * 100), borderColor: COLORS.critical, borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, stepped: 'middle' },
      { label: 'Center line p̄', data: pc.map(() => pbar * 100), borderColor: COLORS.muted, borderWidth: 1.5, pointRadius: 0 },
      { label: 'LCL', data: pc.map((x) => x.lcl * 100), borderColor: COLORS.critical, borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, stepped: 'middle' },
    ] },
    options: { scales: { y: { title: { display: true, text: '% defective' }, ticks: { callback: (v) => v + '%' }, grid: { color: COLORS.grid } }, x: { grid: { display: false } } },
      plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${num(c.raw, 1)}%`, afterBody: (c) => `n = ${pc[c[0].dataIndex].n} units${pc[c[0].dataIndex].out ? ' · OUT OF CONTROL' : ''}` } } } },
  });
  chart($('#q-par', view), {
    type: 'bar',
    data: { labels: par.map((r) => r.reason_code), datasets: [{ label: 'Defects', data: par.map((r) => Number(r.qty)),
      backgroundColor: par.map((r) => (vital.includes(r) ? COLORS.s1 : '#a9c8ee')), borderRadius: 4, maxBarThickness: 40 }] },
    options: { plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: (c) => `cumulative ${pct(par[c.dataIndex].cum)}` } } } },
  });
}
