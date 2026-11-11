// System Info — documents the tools, architecture and how every number is computed (required by the assignment)
import { S, esc, table, setting } from '../lib.js';

export async function render(view) {
  view.innerHTML = `
  <div class="grid g2">
    <div class="card"><h3>About this system</h3>
      <p><b>SSSG ERP</b> is a mini-ERP for <b>Six Sigma Soccer Goods</b>, a fictional soccer retailer with two stores (Provo, Orem) and a warehouse with an in-house print shop
      that presses custom team jerseys and assembles bundles. It sells six product families: soccer balls, goalie gloves, jerseys, cleats, shin guards and soccer socks.</p>
      <p>Every module reads and writes the <b>same database</b>. A sale reduces inventory, which moves the reorder point status, which feeds MRP, which creates a purchase order,
      which builds the supplier scorecard and accounts payable. Every number on every screen is computed from stored transactions.</p>
    </div>
    <div class="card"><h3>Tools used to build it</h3>${table([
      { k: 'a', label: 'Layer' }, { k: 'b', label: 'Tool' }, { k: 'c', label: 'Used for' },
    ], [
      { a: 'AI coding assistant', b: 'Claude (Anthropic), via Claude Code', c: 'Generated the SQL schema, business logic, data generator and web app; the team tested and verified every module' },
      { a: 'Database', b: 'Supabase (PostgreSQL 15+)', c: 'All tables, plus business logic as SQL functions (post_sale, receive_purchase_order, mrp_plan, …)' },
      { a: 'Logins', b: 'Supabase Auth', c: 'Email/password logins; roles: manager, staff, customer' },
      { a: 'Multi-user sync', b: 'Supabase Realtime', c: 'Pushes every change to all logged-in users instantly' },
      { a: 'Security', b: 'PostgreSQL row-level security', c: 'Customers see only the catalog and their own orders' },
      { a: 'Hosting', b: 'GitHub + GitHub Pages', c: 'Source code repository and the public web app' },
      { a: 'Front end', b: 'HTML, CSS and JavaScript modules (no framework)', c: 'All screens' },
      { a: 'Libraries', b: 'supabase-js 2.118, Chart.js 4.4, JsBarcode 3.11, html5-qrcode 2.3', c: 'Database client, charts, barcode labels, camera scanning' },
    ])}</div>
  </div>
  <div class="card"><h3>How the modules connect</h3>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>When you…</th><th>The system…</th></tr></thead><tbody>
      <tr><td>Complete a POS sale</td><td>Reduces on-hand at that store (bundles with no stock are kitted from components on the spot), records revenue, discount, tax and <b>COGS at weighted-average cost</b>, and recalculates inventory position against the ROP</td></tr>
      <tr><td>Place a sales order for custom jerseys</td><td>Commits stock (reduces inventory position), releases a <b>production order</b> for any shortfall, and adds gross requirements to <b>MRP</b></td></tr>
      <tr><td>Start a production order</td><td>Issues components per the <b>BOM</b> (inventory goes down at average cost)</td></tr>
      <tr><td>Complete a production order</td><td>Receives good units at <b>rolled-up cost</b> (component cost ÷ good units) and records scrap and rework with reason codes, which feed the yield, DPMO and p-chart</td></tr>
      <tr><td>Process a return</td><td>Reverses revenue at the net price paid and reverses COGS at the original cost. Quality-failure reasons go to <b>QC Hold</b> and the Pareto</td></tr>
      <tr><td>Send a PO</td><td>Stamps the order date and <b>expected date = order date + supplier quoted lead time</b>. The open quantity counts as on order and as an MRP scheduled receipt</td></tr>
      <tr><td>Receive a PO</td><td>Increases inventory, re-averages item cost, sets the bill due date from payment terms, and scores on-time, actual lead time and fill rate</td></tr>
      <tr><td>Change a setting (S, H, z, tax, opex)</td><td>EOQ, ROP, safety stock, P&amp;L and scorecards recalculate immediately</td></tr>
    </tbody></table></div>
  </div>
  <div class="grid g2">
    <div class="card"><h3>Key formulas</h3><div class="formula">
      Weighted avg cost = (Q₀·C₀ + q·c) ÷ (Q₀ + q) on every receipt<br>
      d̄ = (units sold + units consumed in production) ÷ days of history<br>
      Safety stock = z·σ<sub>daily</sub>·√LT      ROP = d̄·LT + SS<br>
      EOQ = √(2DS ÷ H), D = 365·d̄, S = $${setting('ordering_cost')}, H = ${(setting('holding_cost_pct') * 100).toFixed(0)}%·cost<br>
      Order-up-to (periodic) = d̄(R+LT) + z·σ·√(R+LT)<br>
      MRP net = gross − on hand − scheduled receipts; order-by = need date − LT<br>
      Inventory turnover = COGS ÷ ((begin + end inventory) ÷ 2)<br>
      Supplier score = w₁·on-time + w₂·fill rate + w₃·min(1, quoted LT ÷ actual LT)<br>
      DPMO = defects ÷ (units × opportunities) × 10⁶; sigma = Φ⁻¹(1 − DPMO/10⁶) + 1.5<br>
      p-chart limits = p̄ ± 3√(p̄(1−p̄)/n)</div></div>
    <div class="card"><h3>Data at a glance</h3>${table([{ k: 'a', label: 'Master data' }, { k: 'b', label: 'Count', cls: 'num' }], [
      { a: 'Items (incl. components)', b: S.refs.items.length },
      { a: 'Parent items with bills of material', b: new Set(S.refs.bom.map((b) => b.parent_id)).size },
      { a: 'Locations', b: S.refs.locations.length },
      { a: 'Suppliers', b: S.refs.suppliers.length },
      { a: 'Customers', b: S.refs.customers.length },
      { a: 'Reason codes', b: S.refs.reasons.length },
    ])}<p class="muted small">History was generated by a day-by-day simulation of the business (seasonal demand, supplier reliability, print-shop scrap)
      that calls the same SQL functions the app uses, so the ledger, on-hand and costs always agree.</p></div>
  </div>`;
}
