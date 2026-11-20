// =====================================================================
//  SSSG ERP — MRP engine (GSCM 401 / Chapter 10 method)
//
//  Inputs  = Master Production Schedule + Bill of Materials + Inventory Status
//  Record  = Start | week 1..N with the six standard rows:
//    Gross requirements (GR)   level 0: customer orders (MPS)
//                              level 1: parent planned order RELEASES x qty per parent
//    Scheduled receipts (SR)   open purchase orders / open work orders, by due week
//    Projected on hand (POH)   POH(t) = POH(t-1) + SR(t) + planned receipt(t) - GR(t)
//    Net requirements (NR)     NR(t)  = max(0, GR(t) - SR(t) - POH(t-1))
//    Planned order receipts    L4L: = NR      FOQ: smallest multiple of the FOQ >= NR
//    Planned order releases    = planned receipt moved back by the lead time (in weeks)
//  A release that falls before week 1 is "past due" (expedite) and shows in Start.
// =====================================================================

// lead time in whole weeks (2 days -> 1 week, 35 days -> 5 weeks)
export const ltWeeks = (days) => Math.max(0, Math.ceil(Number(days || 0) / 7));

// plain function, no database: easy to test against the class examples
// items: [{id, sku, name, level, lt, rule:'L4L'|'FOQ', foq, onHand}]
// bom:   [{parent_id, component_id, qty}]
// gross: [{item_id, week, qty, source}]   independent demand (MPS), week 1..W
// sr:    [{item_id, week, qty, source}]   scheduled receipts, week 1..W
// firm:  [{item_id, week, qty, source}]   firm (already-created, not yet issued) parent releases
export function runMRP({ items, bom, gross = [], sr = [], firm = [] }, W) {
  const rec = {};
  const blank = () => Array(W + 1).fill(0); // index 0 = Start / past due
  items.forEach((it) => {
    rec[it.id] = {
      item: it, gr: blank(), sr: blank(), poh: blank(), nr: blank(), porc: blank(), porl: blank(),
      grSources: Array.from({ length: W + 1 }, () => []), planned: [],
    };
  });
  const add = (arr, w, q) => { arr[Math.min(W, Math.max(1, w))] += q; };
  gross.forEach((g) => rec[g.item_id] && (add(rec[g.item_id].gr, g.week, g.qty),
    rec[g.item_id].grSources[Math.min(W, Math.max(1, g.week))].push(`${g.source}: ${g.qty}`)));
  sr.forEach((s) => rec[s.item_id] && add(rec[s.item_id].sr, s.week, s.qty));

  // explode a parent's releases into its components' gross requirements
  const explode = (parentId, week, qty, source) => {
    bom.filter((b) => b.parent_id === parentId).forEach((b) => {
      const r = rec[b.component_id];
      if (!r) return;
      const w = Math.min(W, Math.max(1, week)); // a past-due parent release is needed now (week 1)
      r.gr[w] += qty * b.qty;
      r.grSources[w].push(`${source}: ${qty} × ${b.qty}`);
    });
  };
  firm.forEach((f) => explode(f.item_id, f.week, f.qty, f.source));

  // level 0 first (parents), then level 1 (components) — parents drive children
  const order = [...items].sort((a, b) => a.level - b.level);
  order.forEach((it) => {
    const r = rec[it.id];
    r.poh[0] = it.onHand;
    let prev = it.onHand;
    for (let w = 1; w <= W; w++) {
      const net = Math.max(0, r.gr[w] - r.sr[w] - prev);
      let receipt = net;
      if (net > 0 && it.rule === 'FOQ' && it.foq > 0) receipt = Math.ceil(net / it.foq) * it.foq;
      r.nr[w] = net;
      r.porc[w] = receipt;
      r.poh[w] = prev + r.sr[w] + receipt - r.gr[w];
      prev = r.poh[w];
      if (receipt > 0) {
        const rw = w - it.lt; // offset by lead time
        if (rw >= 1) r.porl[rw] += receipt; else r.porl[0] += receipt;
        r.planned.push({ item_id: it.id, needWeek: w, releaseWeek: rw, qty: receipt, net });
        explode(it.id, rw, receipt, `${it.sku} release wk ${rw >= 1 ? rw : 'past due'}`);
      }
    }
  });
  return rec;
}
