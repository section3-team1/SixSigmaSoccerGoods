# SSSG ERP — Demo Guide (10 minutes, Dr. Wright picks the order)

**The story in one sentence:** Six Sigma Soccer Goods sells soccer balls, goalie gloves, jerseys, cleats, shin guards and socks from two stores,
and presses custom team jerseys and assembles bundles in its warehouse print shop. One database connects every department.

**The big idea to repeat:** *one transaction, many effects.* Every screen reads the same tables, so nothing is typed twice and every number is computed.

---

## Always demoed

### Point of Sale / Sales Orders
- **POS:** scan 2–3 labels → change a line discount and the order discount → **Complete sale** → receipt.
- Then show: Inventory (on hand dropped at PRV), Financials (revenue and COGS rose), Dashboard ("Today's sales").
- Scan a **bundle** with none on the shelf (e.g. Goalkeeper Bundle): the system kits it from components on the spot (backflush) and logs an automatic work order.
- **Sales order:** New order → Custom Home Jersey ×15 → a work order is released automatically for the shortfall. Status flow: *Order placed → Fulfilled → Closed* (or Cancelled).
- **Concept:** COGS uses **weighted-average cost** at the moment of sale. Sales tax is a liability, not revenue.

### Inventory Management
- On-hand grid by **PRV / ORM / WHS / QCH**, backordered quantity and **estimated available date** (from the open PO's expected date, an open work order, or the item lead time).
- **Transfer** WHS→PRV · **Adjust** −1 with reason **DMG** · **Cycle count**: enter the counted qty and only the variance posts (CC-SHORT/OVER).
- **Scan to adjust** tab: scan a label, then hit +1/−1/Count.
- **Concept:** a perpetual inventory ledger. Every movement is a row with qty × unit cost, so inventory can be valued at any past date.

### Returns & Exchanges
- Scan the receipt barcode (or type S-####) → return 1 unit with **Q-AIR** (quality) → it goes to **QC Hold**, not the shelf.
- Exchange: return a cleat with **WRONG-SIZE** and add the replacement. The net difference is calculated for you.
- **Concept:** revenue is reversed at the *net price paid* (after discounts) and COGS is reversed at the *original cost*. Both show on the P&L.

### Production Orders
- Open a planned WO → **Start** (components are issued per the BOM; on-hand drops) → **Complete** with 1 scrap (PR-MISALIGN) and 1 rework.
- Point out the **rolled-up unit cost = component cost ÷ good units** (scrap cost is absorbed by the good units).
- **Production report** tab: pick a date range to show yield, first-pass yield, scrap rate, cycle time, on-time completion and DPMO/sigma.

### Financial Reporting
- P&L: gross sales − discounts − returns = net revenue; COGS − returned COGS; gross profit; write-offs; opex → operating income.
- Inventory valuation by location and item (weighted average). Turnover = COGS ÷ average inventory, with the math shown.
- **Live proof:** make a sale in another tab, refresh Financials, and the numbers move.

### MRP
- Planning & MRP → **MRP** tab. Walk one jersey order: SO quantity → parent net requirement → explode through the BOM → component gross requirement
  → minus on hand and open POs → net requirement → **order-by date = need date − lead time**.
- **If he changes an input:** raise Summit Socks & Print Supply's lead time (Purchasing → Suppliers → Edit → 30 days, with "update items" checked).
  The order-by dates for Team Socks and the Drawstring Kit Bag jump into the past and show **EXPEDITE**. Set it back to 7 afterward.
- Click **Create PO** on a planned order to show MRP → purchasing.

## Often picked as "additional" capabilities
- **Purchasing:** new PO → expected date = today + quoted lead time → **Receive** by scanning (partial) → bill due date from terms → pay → close.
- **Supplier scorecard:** on-time %, actual vs quoted lead time, fill rate and amounts owed, all computed from PO history. ShieldGuard = **Replace**, Summit = **Watch** (ships short).
- **Reorder points / EOQ:** in Settings, change the **ordering cost** from 45 to 180 and EOQ doubles (√4 = 2). Change **z** and safety stock moves.
- **Periodic review:** the order-up-to level and the quantity to order for items due for review.
- **Barcode:** bring printed labels and scan with a phone camera *and* a USB scanner.
- **Customer portal:** log in as `coach@provopremierfc.example.com` → see stock by store → place a pickup order → it appears instantly in Sales Orders (and in MRP if it's for kits).
- **Multi-user:** two laptops side by side. Sell on one and the other updates within a second (green dot, "Updated: sale recorded").
- **Reports:** sales by day/week, top sellers, low stock with order-by dates, inventory by location, supplier lead times.

## Wow factor: Six Sigma Quality Center
- **Sigma level and DPMO** from real work-order defects (3 defect opportunities per jersey: number, name, crest).
- **p-chart** with varying control limits. The red point is the week **heat press #2 drifted**, found from operator notes on the work orders.
- **Pareto**: the vital few reasons that cause 80% of defects, across production, returns and damage.
- **Cost of poor quality** in dollars. The DMAIC snapshot ties it back to GSCM 402.
- Plus: auto-released work orders from customer orders, live low-stock alerts to every user, and "Reset demo data" that regenerates history ending today.

## Likely questions → short answers
- *Why weighted average and not FIFO?* It's simpler to compute on every receipt, and it smooths the price changes our suppliers' POs show.
- *Why does ROP use σ of weekly demand?* Daily retail demand is lumpy, so weekly buckets give a stable σ that we convert to daily (÷√7).
- *What's the difference between ROP and MRP here?* ROP covers **independent** demand (walk-in sales) using history. MRP covers **dependent** demand from confirmed orders exploded through the BOM.
- *Inventory position vs on hand?* Position = on hand + on order − committed. That's what we compare to the ROP.
- *Is the data real?* It's simulated day by day through the same functions the app uses (seasonal: August is ~3× May), so the ledger always reconciles.
- *How do you know it's correct?* We tested each transaction by hand (tax, discounts, refund math, rolled-up cost, EOQ scaling) and checked that the ledger equals on hand.

## Before demo day
1. Reset the demo data that morning (Settings → Reset, or `select seed_demo();`).
2. Log in on every presenter's laptop. Check the green **Live** dot.
3. Print labels and test them with a phone camera and a USB scanner.
4. Dress professionally. Each teammate owns 1–2 sections above *and* can explain how theirs feeds the next.
