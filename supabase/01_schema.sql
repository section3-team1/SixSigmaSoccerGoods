-- =====================================================================
--  SIX SIGMA SOCCER GOODS (SSSG) — Mini-ERP database
--  File 1 of 2: tables, business logic, reports, security
--  Run in the Supabase SQL Editor. Safe to re-run (drops and rebuilds).
-- =====================================================================
create extension if not exists pgcrypto;

drop table if exists po_payments, po_receipts, po_lines, purchase_orders,
  return_lines, returns, sale_lines, sales, so_lines, sales_orders,
  production_orders, inventory_txns, inventory, bom, items, suppliers,
  profiles, customers, locations, reason_codes, settings, app_secrets cascade;

-- ---------------------------------------------------------------------
--  MASTER DATA
-- ---------------------------------------------------------------------
create table settings (
  key   text primary key,
  value numeric not null,
  label text not null,
  unit  text,
  grp   text not null default 'General',
  sort  int not null default 0
);

create table app_secrets (key text primary key, value text not null);

create table locations (
  id       serial primary key,
  code     text unique not null,
  name     text not null,
  kind     text not null check (kind in ('store','warehouse','qc')),
  address  text
);

create table suppliers (
  id             serial primary key,
  name           text not null,
  contact_name   text,
  email          text,
  phone          text,
  address        text,
  lead_time_days int  not null check (lead_time_days >= 0),
  payment_terms  text not null default 'Net 30',
  terms_days     int  not null default 30,
  notes          text,
  active         boolean not null default true
);

create table customers (
  id           serial primary key,
  name         text not null,
  kind         text not null default 'individual',
  contact_name text,
  email        text unique,
  phone        text,
  city         text,
  created_at   timestamptz not null default now()
);

create table items (
  id                    serial primary key,
  sku                   text unique not null,
  barcode               text unique not null,
  name                  text not null,
  category              text not null,
  item_type             text not null check (item_type in ('product','component','kit')),
  supplier_id           int references suppliers(id),
  unit_cost             numeric(12,4) not null default 0,   -- last/standard purchase cost
  avg_cost              numeric(12,4) not null default 0,   -- perpetual weighted-average cost
  price                 numeric(12,2) not null default 0,
  lead_time_days        int not null default 7,
  rop_override          int,
  auto_assemble         boolean not null default false,     -- bundles kitted at the counter when sold
  defect_opportunities  int not null default 1,             -- for DPMO
  sellable              boolean not null default true,
  last_reviewed_at      timestamptz,
  active                boolean not null default true,
  description           text
);

create table bom (
  parent_id    int references items(id) on delete cascade,
  component_id int references items(id),
  qty          numeric(12,4) not null check (qty > 0),
  primary key (parent_id, component_id)
);

create table inventory (
  item_id     int references items(id) on delete cascade,
  location_id int references locations(id),
  qty         numeric(12,2) not null default 0 check (qty >= 0),
  primary key (item_id, location_id)
);

create table reason_codes (
  code        text primary key,
  kind        text not null check (kind in ('adjust','return','scrap','rework')),
  description text not null,
  is_quality  boolean not null default false
);

create table inventory_txns (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  item_id     int not null references items(id) on delete cascade,
  location_id int not null references locations(id),
  qty         numeric(12,2) not null,            -- signed: + in, - out
  txn_type    text not null,                     -- opening, sale, return, receipt, transfer_in, transfer_out, adjust, prod_issue, prod_receipt
  unit_cost   numeric(12,4) not null default 0,
  reason_code text,
  ref_type    text,
  ref_id      bigint,
  note        text,
  user_email  text
);
create index on inventory_txns (item_id, ts);
create index on inventory_txns (ts);
create index on inventory_txns (txn_type, ts);

create table profiles (
  id          uuid primary key,
  email       text,
  full_name   text,
  role        text not null default 'customer' check (role in ('manager','staff','customer')),
  customer_id int references customers(id),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
--  TRANSACTIONS
-- ---------------------------------------------------------------------
create table sales_orders (
  id             bigserial primary key,
  ts             timestamptz not null default now(),
  customer_id    int not null references customers(id),
  location_id    int not null references locations(id),
  status         text not null default 'placed' check (status in ('placed','fulfilled','closed','cancelled')),
  requested_date date not null,
  channel        text not null default 'staff',   -- staff | portal
  notes          text,
  sale_id        bigint,
  fulfilled_at   timestamptz,
  closed_at      timestamptz,
  created_by     text
);

create table so_lines (
  id            bigserial primary key,
  so_id         bigint not null references sales_orders(id) on delete cascade,
  item_id       int not null references items(id),
  qty           numeric(12,2) not null check (qty > 0),
  unit_price    numeric(12,2) not null,
  qty_fulfilled numeric(12,2) not null default 0
);

create table sales (
  id             bigserial primary key,
  ts             timestamptz not null default now(),
  customer_id    int references customers(id),
  location_id    int not null references locations(id),
  channel        text not null default 'POS',     -- POS | SO | EXCH
  so_id          bigint references sales_orders(id),
  subtotal       numeric(12,2) not null default 0,
  discount_total numeric(12,2) not null default 0,
  order_discount_pct numeric(6,2) not null default 0,
  tax            numeric(12,2) not null default 0,
  total          numeric(12,2) not null default 0,
  cogs           numeric(12,2) not null default 0,
  payment_method text default 'card',
  cashier        text
);
create index on sales (ts);
alter table sales_orders add constraint so_sale_fk foreign key (sale_id) references sales(id);

create table sale_lines (
  id           bigserial primary key,
  sale_id      bigint not null references sales(id) on delete cascade,
  item_id      int not null references items(id),
  qty          numeric(12,2) not null check (qty > 0),
  unit_price   numeric(12,2) not null,
  discount_pct numeric(6,2) not null default 0,
  line_total   numeric(12,2) not null,           -- net of line + order discount, before tax
  unit_cost    numeric(12,4) not null,
  returned_qty numeric(12,2) not null default 0
);
create index on sale_lines (sale_id);
create index on sale_lines (item_id);

create table returns (
  id               bigserial primary key,
  ts               timestamptz not null default now(),
  sale_id          bigint not null references sales(id),
  customer_id      int references customers(id),
  location_id      int not null references locations(id),
  kind             text not null check (kind in ('return','exchange')),
  reason_code      text not null references reason_codes(code),
  refund_total     numeric(12,2) not null default 0,   -- revenue reversed (pre-tax)
  tax_refund       numeric(12,2) not null default 0,
  cogs_reversed    numeric(12,2) not null default 0,
  exchange_sale_id bigint references sales(id),
  net_due          numeric(12,2) not null default 0,   -- + customer pays, - we refund
  notes            text,
  processed_by     text
);
create index on returns (ts);

create table return_lines (
  id           bigserial primary key,
  return_id    bigint not null references returns(id) on delete cascade,
  sale_line_id bigint not null references sale_lines(id),
  item_id      int not null references items(id),
  qty          numeric(12,2) not null check (qty > 0),
  unit_net     numeric(12,4) not null,
  unit_cost    numeric(12,4) not null,
  to_location  int not null references locations(id),
  disposition  text not null   -- restock | qc_hold
);

create table production_orders (
  id             bigserial primary key,
  item_id        int not null references items(id),
  location_id    int not null references locations(id),
  qty_planned    numeric(12,2) not null check (qty_planned > 0),
  qty_started    numeric(12,2) not null default 0,
  qty_good       numeric(12,2) not null default 0,
  qty_scrap      numeric(12,2) not null default 0,
  qty_rework     numeric(12,2) not null default 0,
  scrap_reason   text references reason_codes(code),
  rework_reason  text references reason_codes(code),
  status         text not null default 'planned' check (status in ('planned','in_progress','completed','cancelled')),
  created_at     timestamptz not null default now(),
  due_date       date,
  started_at     timestamptz,
  finished_at    timestamptz,
  component_cost numeric(12,2) not null default 0,
  unit_cost      numeric(12,4) not null default 0,
  scrap_cost     numeric(12,2) not null default 0,
  so_id          bigint references sales_orders(id),
  auto           boolean not null default false,
  notes          text,
  created_by     text
);
create index on production_orders (finished_at);

create table purchase_orders (
  id                 bigserial primary key,
  supplier_id        int not null references suppliers(id),
  location_id        int not null references locations(id),
  status             text not null default 'draft' check (status in ('draft','sent','partial','received','closed','cancelled')),
  created_at         timestamptz not null default now(),
  order_date         date,
  quoted_lead_days   int,
  expected_date      date,
  first_receipt_at   timestamptz,
  last_receipt_at    timestamptz,
  due_date           date,
  paid_total         numeric(12,2) not null default 0,
  closed_at          timestamptz,
  notes              text,
  created_by         text
);

create table po_lines (
  id           bigserial primary key,
  po_id        bigint not null references purchase_orders(id) on delete cascade,
  item_id      int not null references items(id),
  qty_ordered  numeric(12,2) not null check (qty_ordered > 0),
  qty_received numeric(12,2) not null default 0,
  unit_cost    numeric(12,4) not null
);
create index on po_lines (po_id);

create table po_receipts (
  id          bigserial primary key,
  po_id       bigint not null references purchase_orders(id) on delete cascade,
  po_line_id  bigint not null references po_lines(id) on delete cascade,
  ts          timestamptz not null default now(),
  qty         numeric(12,2) not null check (qty > 0),
  location_id int not null references locations(id),
  received_by text
);

create table po_payments (
  id     bigserial primary key,
  po_id  bigint not null references purchase_orders(id) on delete cascade,
  ts     timestamptz not null default now(),
  amount numeric(12,2) not null check (amount > 0),
  method text default 'ACH'
);

-- ---------------------------------------------------------------------
--  HELPERS
-- ---------------------------------------------------------------------
create or replace function cfg(p_key text) returns numeric
language sql stable as $$ select value from settings where key = p_key $$;

create or replace function local_date(p_ts timestamptz) returns date
language sql immutable as $$ select (p_ts at time zone 'America/Denver')::date $$;

create or replace function today_local() returns date
language sql stable as $$ select (now() at time zone 'America/Denver')::date $$;

create or replace function my_role() returns text
language sql stable security definer set search_path = public as
$$ select role from profiles where id = auth.uid() $$;

create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce((select role in ('manager','staff') from profiles where id = auth.uid()), false) $$;

create or replace function my_customer_id() returns int
language sql stable security definer set search_path = public as
$$ select customer_id from profiles where id = auth.uid() $$;

-- true when called through the API (a logged-in or anonymous web user);
-- false when run directly in the SQL editor (used by the data generator)
create or replace function _api_call() returns boolean
language sql stable as
$$ select coalesce(current_setting('request.jwt.claims', true), '') not in ('', '{}') $$;

create or replace function _require_staff() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if _api_call() and not is_staff() then
    raise exception 'Staff login required for this action';
  end if;
end $$;

create or replace function _require_manager() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if _api_call() and coalesce(my_role(), '') <> 'manager' then
    raise exception 'Manager login required for this action';
  end if;
end $$;

create or replace function _actor() returns text
language sql stable security definer set search_path = public as
$$ select coalesce((select coalesce(full_name, email) from profiles where id = auth.uid()), 'system') $$;

-- EAN-13 check digit (used for item barcodes)
create or replace function ean13(p12 text) returns text
language plpgsql immutable as $$
declare s int := 0; i int;
begin
  for i in 1..12 loop
    s := s + substr(p12, i, 1)::int * case when i % 2 = 0 then 3 else 1 end;
  end loop;
  return p12 || ((10 - s % 10) % 10)::text;
end $$;

-- ---------------------------------------------------------------------
--  CORE: every stock movement goes through here
--  Keeps on-hand, the transaction ledger and weighted-average cost in sync.
-- ---------------------------------------------------------------------
create or replace function _move(
  p_item int, p_loc int, p_qty numeric, p_type text, p_cost numeric,
  p_reason text, p_ref_type text, p_ref_id bigint, p_ts timestamptz, p_note text default null)
returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_item items; v_have numeric; v_total numeric; v_cost numeric; v_loc text;
begin
  select * into v_item from items where id = p_item for update;
  if not found then raise exception 'Item % not found', p_item; end if;

  if p_qty < 0 then
    select qty into v_have from inventory where item_id = p_item and location_id = p_loc for update;
    if coalesce(v_have, 0) + p_qty < 0 then
      select code into v_loc from locations where id = p_loc;
      raise exception 'Not enough % at % (on hand %, need %)', v_item.name, v_loc, coalesce(v_have,0), -p_qty;
    end if;
    v_cost := v_item.avg_cost;
  else
    v_cost := coalesce(p_cost, v_item.avg_cost);
    if p_type <> 'transfer_in' then
      select coalesce(sum(qty), 0) into v_total from inventory where item_id = p_item;
      if v_total + p_qty > 0 then
        update items
           set avg_cost = round((greatest(v_total,0) * avg_cost + p_qty * v_cost) / (greatest(v_total,0) + p_qty), 4)
         where id = p_item;
      end if;
    end if;
  end if;

  if p_qty < 0 then
    update inventory set qty = qty + p_qty where item_id = p_item and location_id = p_loc;
  else
    insert into inventory (item_id, location_id, qty) values (p_item, p_loc, p_qty)
    on conflict (item_id, location_id) do update set qty = inventory.qty + excluded.qty;
  end if;

  insert into inventory_txns (ts, item_id, location_id, qty, txn_type, unit_cost, reason_code, ref_type, ref_id, note, user_email)
  values (p_ts, p_item, p_loc, p_qty, p_type, v_cost, p_reason, p_ref_type, p_ref_id, p_note, _actor());

  return v_cost;
end $$;

-- ---------------------------------------------------------------------
--  INVENTORY: transfers, adjustments, cycle counts
-- ---------------------------------------------------------------------
create or replace function transfer_inventory(p_item int, p_from int, p_to int, p_qty numeric,
  p_note text default null, p_ts timestamptz default now())
returns void language plpgsql security definer set search_path = public as $$
declare v_cost numeric;
begin
  perform _require_staff();
  if p_qty <= 0 then raise exception 'Transfer quantity must be positive'; end if;
  if p_from = p_to then raise exception 'From and To locations must differ'; end if;
  v_cost := _move(p_item, p_from, -p_qty, 'transfer_out', null, null, 'transfer', null, p_ts, p_note);
  perform _move(p_item, p_to, p_qty, 'transfer_in', v_cost, null, 'transfer', null, p_ts, p_note);
end $$;

create or replace function adjust_inventory(p_item int, p_loc int, p_delta numeric, p_reason text,
  p_note text default null, p_ts timestamptz default now())
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require_staff();
  if p_delta = 0 then raise exception 'Adjustment cannot be zero'; end if;
  if not exists (select 1 from reason_codes where code = p_reason and kind = 'adjust') then
    raise exception 'A valid adjustment reason code is required';
  end if;
  perform _move(p_item, p_loc, p_delta, 'adjust', null, p_reason, 'adjust', null, p_ts, p_note);
end $$;

create or replace function cycle_count(p_item int, p_loc int, p_counted numeric, p_note text default null,
  p_ts timestamptz default now())
returns numeric language plpgsql security definer set search_path = public as $$
declare v_have numeric; v_delta numeric;
begin
  perform _require_staff();
  select coalesce((select qty from inventory where item_id = p_item and location_id = p_loc), 0) into v_have;
  v_delta := p_counted - v_have;
  if v_delta <> 0 then
    perform _move(p_item, p_loc, v_delta, 'adjust', null,
                  case when v_delta > 0 then 'CC-OVER' else 'CC-SHORT' end,
                  'cycle_count', null, p_ts, coalesce(p_note, 'Cycle count: system ' || v_have || ', counted ' || p_counted));
  end if;
  return v_delta;
end $$;

-- ---------------------------------------------------------------------
--  PRODUCTION ORDERS (work orders)
-- ---------------------------------------------------------------------
create or replace function create_production_order(p_item int, p_loc int, p_qty numeric,
  p_due date default null, p_so bigint default null, p_notes text default null, p_ts timestamptz default now())
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  perform _require_staff();
  if not exists (select 1 from bom where parent_id = p_item) then
    raise exception 'This item has no bill of material, so it cannot be produced';
  end if;
  insert into production_orders (item_id, location_id, qty_planned, due_date, so_id, notes, created_at, created_by)
  values (p_item, p_loc, p_qty, coalesce(p_due, local_date(p_ts) + 2), p_so, p_notes, p_ts, _actor())
  returning id into v_id;
  return v_id;
end $$;

-- Issue: consume components per BOM for the quantity started
create or replace function start_production(p_wo bigint, p_qty_started numeric default null, p_ts timestamptz default now())
returns void language plpgsql security definer set search_path = public as $$
declare w production_orders; b record; v_cost numeric; v_total numeric := 0; v_qty numeric;
begin
  perform _require_staff();
  select * into w from production_orders where id = p_wo for update;
  if w.status <> 'planned' then raise exception 'Work order WO-% is already %', p_wo, w.status; end if;
  v_qty := coalesce(p_qty_started, w.qty_planned);
  if v_qty <= 0 then raise exception 'Quantity started must be positive'; end if;
  for b in select component_id, qty from bom where parent_id = w.item_id loop
    v_cost := _move(b.component_id, w.location_id, -(b.qty * v_qty), 'prod_issue', null, null, 'production', p_wo, p_ts);
    v_total := v_total + b.qty * v_qty * v_cost;
  end loop;
  update production_orders
     set status = 'in_progress', qty_started = v_qty, started_at = p_ts, component_cost = round(v_total, 2)
   where id = p_wo;
end $$;

-- Complete: receive good units at rolled-up cost; scrap cost is absorbed by good units
create or replace function complete_production(p_wo bigint, p_good numeric, p_scrap numeric default 0,
  p_rework numeric default 0, p_scrap_reason text default null, p_rework_reason text default null,
  p_ts timestamptz default now())
returns void language plpgsql security definer set search_path = public as $$
declare w production_orders; v_unit numeric; so_loc int;
begin
  perform _require_staff();
  select * into w from production_orders where id = p_wo for update;
  if w.status <> 'in_progress' then raise exception 'Work order WO-% must be in progress to complete', p_wo; end if;
  if p_good < 0 or p_scrap < 0 or p_rework < 0 then raise exception 'Quantities cannot be negative'; end if;
  if p_good + p_scrap <> w.qty_started then
    raise exception 'Good (%) + scrapped (%) must equal quantity started (%)', p_good, p_scrap, w.qty_started;
  end if;
  if p_rework > p_good then raise exception 'Reworked units cannot exceed good units'; end if;
  if p_scrap > 0 and p_scrap_reason is null then raise exception 'A scrap reason code is required'; end if;
  if p_rework > 0 and p_rework_reason is null then raise exception 'A rework reason code is required'; end if;

  v_unit := case when p_good > 0 then w.component_cost / p_good else 0 end;
  update production_orders
     set status = 'completed', qty_good = p_good, qty_scrap = p_scrap, qty_rework = p_rework,
         scrap_reason = case when p_scrap > 0 then p_scrap_reason end,
         rework_reason = case when p_rework > 0 then p_rework_reason end,
         finished_at = p_ts, unit_cost = round(v_unit, 4),
         scrap_cost = round(case when w.qty_started > 0 then w.component_cost * p_scrap / w.qty_started else 0 end, 2)
   where id = p_wo;

  if p_good > 0 then
    perform _move(w.item_id, w.location_id, p_good, 'prod_receipt', v_unit, null, 'production', p_wo, p_ts);
    -- built for a customer order picked up at another location? ship it there
    if w.so_id is not null then
      select location_id into so_loc from sales_orders where id = w.so_id;
      if so_loc is not null and so_loc <> w.location_id then
        perform transfer_inventory(w.item_id, w.location_id, so_loc, p_good, 'Ship WO-' || p_wo || ' to pickup location', p_ts);
      end if;
    end if;
  end if;
end $$;

create or replace function cancel_production(p_wo bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_staff();
  update production_orders set status = 'cancelled' where id = p_wo and status = 'planned';
  if not found then raise exception 'Only planned work orders can be cancelled'; end if;
end $$;

-- Bundles sold at the counter with no finished kits on hand get kitted on the spot
create or replace function _auto_assemble(p_item int, p_loc int, p_qty numeric, p_ts timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare v_wo bigint;
begin
  insert into production_orders (item_id, location_id, qty_planned, due_date, auto, notes, created_at, created_by)
  values (p_item, p_loc, p_qty, local_date(p_ts), true, 'Kitted at point of sale', p_ts, _actor())
  returning id into v_wo;
  perform start_production(v_wo, p_qty, p_ts);
  perform complete_production(v_wo, p_qty, 0, 0, null, null, p_ts);
end $$;

-- ---------------------------------------------------------------------
--  POINT OF SALE
--  p_lines: [{"item_id":1,"qty":2,"unit_price":49.99,"discount_pct":10}, ...]
-- ---------------------------------------------------------------------
create or replace function post_sale(p_location int, p_customer int, p_lines jsonb,
  p_order_discount_pct numeric default 0, p_payment text default 'card', p_channel text default 'POS',
  p_so bigint default null, p_ts timestamptz default now())
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_sale bigint; l jsonb; it items; v_qty numeric; v_price numeric; v_disc numeric;
  v_gross numeric; v_net numeric; v_cost numeric; v_have numeric;
  v_sub numeric := 0; v_netsum numeric := 0; v_cogs numeric := 0; v_tax numeric;
begin
  perform _require_staff();
  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then raise exception 'Sale has no items'; end if;
  if coalesce(p_order_discount_pct,0) < 0 or coalesce(p_order_discount_pct,0) > 100 then raise exception 'Discount must be 0-100%%'; end if;

  insert into sales (ts, customer_id, location_id, channel, so_id, order_discount_pct, payment_method, cashier)
  values (p_ts, p_customer, p_location, p_channel, p_so, coalesce(p_order_discount_pct,0), p_payment, _actor())
  returning id into v_sale;

  for l in select * from jsonb_array_elements(p_lines) loop
    select * into it from items where id = (l->>'item_id')::int;
    if not found then raise exception 'Unknown item %', l->>'item_id'; end if;
    if not it.sellable then raise exception '% is a component and is not sold directly', it.name; end if;
    v_qty   := (l->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Quantity must be positive for %', it.name; end if;
    v_price := coalesce((l->>'unit_price')::numeric, it.price);
    v_disc  := coalesce((l->>'discount_pct')::numeric, 0);
    v_gross := round(v_qty * v_price, 2);
    v_net   := round(v_gross * (1 - v_disc/100) * (1 - coalesce(p_order_discount_pct,0)/100), 2);

    -- bundle not on the shelf? kit it from components right now (backflush)
    if it.item_type = 'kit' and it.auto_assemble then
      select coalesce((select qty from inventory where item_id = it.id and location_id = p_location), 0) into v_have;
      if v_have < v_qty then perform _auto_assemble(it.id, p_location, v_qty - v_have, p_ts); end if;
    end if;

    v_cost := _move(it.id, p_location, -v_qty, 'sale', null, null, 'sale', v_sale, p_ts);
    insert into sale_lines (sale_id, item_id, qty, unit_price, discount_pct, line_total, unit_cost)
    values (v_sale, it.id, v_qty, v_price, v_disc, v_net, v_cost);
    v_sub := v_sub + v_gross; v_netsum := v_netsum + v_net; v_cogs := v_cogs + round(v_qty * v_cost, 2);
  end loop;

  v_tax := round(v_netsum * cfg('tax_rate'), 2);
  update sales set subtotal = v_sub, discount_total = v_sub - v_netsum, tax = v_tax,
                   total = v_netsum + v_tax, cogs = v_cogs
   where id = v_sale;
  return v_sale;
end $$;

-- ---------------------------------------------------------------------
--  SALES ORDERS
-- ---------------------------------------------------------------------
create or replace function create_sales_order(p_customer int, p_location int, p_requested date,
  p_lines jsonb, p_notes text default null, p_channel text default 'staff', p_ts timestamptz default now())
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_so bigint; l jsonb; it items; v_qty numeric; v_avail numeric; v_short numeric; v_wh int;
begin
  if p_channel <> 'portal' then perform _require_staff(); end if;
  if jsonb_array_length(coalesce(p_lines,'[]'::jsonb)) = 0 then raise exception 'Order has no items'; end if;
  insert into sales_orders (ts, customer_id, location_id, requested_date, channel, notes, created_by)
  values (p_ts, p_customer, p_location, p_requested, p_channel, p_notes, _actor())
  returning id into v_so;

  select id into v_wh from locations where kind = 'warehouse' order by id limit 1;

  for l in select * from jsonb_array_elements(p_lines) loop
    select * into it from items where id = (l->>'item_id')::int;
    if not found or not it.sellable then raise exception 'Item % cannot be ordered', l->>'item_id'; end if;
    v_qty := (l->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Quantity must be positive'; end if;
    insert into so_lines (so_id, item_id, qty, unit_price)
    values (v_so, it.id, v_qty, coalesce((l->>'unit_price')::numeric, it.price));

    -- made-to-order items (custom jerseys): release a work order for whatever the pickup
    -- location can't cover from finished stock not already promised to earlier orders
    if it.item_type = 'kit' and not it.auto_assemble then
      select coalesce((select qty from inventory where item_id = it.id and location_id = p_location), 0) into v_avail;
      select v_avail - coalesce(sum(sl.qty - sl.qty_fulfilled), 0) into v_avail
        from so_lines sl join sales_orders so on so.id = sl.so_id
       where sl.item_id = it.id and so.status = 'placed' and so.location_id = p_location and so.id <> v_so
         and not exists (select 1 from production_orders w where w.so_id = so.id and w.item_id = it.id and w.status <> 'cancelled');
      v_short := v_qty - greatest(v_avail, 0);
      if v_short > 0 then
        insert into production_orders (item_id, location_id, qty_planned, due_date, so_id, notes, created_at, created_by)
        values (it.id, v_wh, v_short, greatest(p_requested - 1, local_date(p_ts)), v_so,
                'Auto-released for SO-' || v_so, p_ts, _actor());
      end if;
    end if;
  end loop;
  return v_so;
end $$;

-- Customer portal: place a pickup order for the logged-in customer
create or replace function place_pickup_order(p_location int, p_requested date, p_lines jsonb, p_notes text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_cust int;
begin
  v_cust := my_customer_id();
  if v_cust is null then raise exception 'Customer login required'; end if;
  if not exists (select 1 from locations where id = p_location and kind = 'store') then
    raise exception 'Pickup must be at a store';
  end if;
  if p_requested < today_local() then raise exception 'Pickup date cannot be in the past'; end if;
  return create_sales_order(v_cust, p_location, p_requested, p_lines, p_notes, 'portal', now());
end $$;

create or replace function fulfill_sales_order(p_so bigint, p_ts timestamptz default now())
returns bigint language plpgsql security definer set search_path = public as $$
declare s sales_orders; v_lines jsonb; v_sale bigint;
begin
  perform _require_staff();
  select * into s from sales_orders where id = p_so for update;
  if s.status <> 'placed' then raise exception 'SO-% is %, only placed orders can be fulfilled', p_so, s.status; end if;
  select jsonb_agg(jsonb_build_object('item_id', item_id, 'qty', qty - qty_fulfilled, 'unit_price', unit_price))
    into v_lines from so_lines where so_id = p_so and qty > qty_fulfilled;
  v_sale := post_sale(s.location_id, s.customer_id, v_lines, 0, 'invoice', 'SO', p_so, p_ts);
  update so_lines set qty_fulfilled = qty where so_id = p_so;
  update sales_orders set status = 'fulfilled', sale_id = v_sale, fulfilled_at = p_ts where id = p_so;
  return v_sale;
end $$;

create or replace function close_sales_order(p_so bigint, p_ts timestamptz default now())
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require_staff();
  update sales_orders set status = 'closed', closed_at = p_ts where id = p_so and status = 'fulfilled';
  if not found then raise exception 'Only fulfilled orders can be closed'; end if;
end $$;

create or replace function cancel_sales_order(p_so bigint, p_ts timestamptz default now())
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (is_staff() or not _api_call()
          or exists (select 1 from sales_orders where id = p_so and customer_id = my_customer_id())) then
    raise exception 'Not allowed';
  end if;
  update sales_orders set status = 'cancelled', closed_at = p_ts where id = p_so and status = 'placed';
  if not found then raise exception 'Only placed (unfulfilled) orders can be cancelled'; end if;
  update production_orders set status = 'cancelled' where so_id = p_so and status = 'planned';
end $$;

-- ---------------------------------------------------------------------
--  RETURNS & EXCHANGES
--  p_lines:    [{"sale_line_id":12,"qty":1}]
--  p_new_lines (exchange only): same format as post_sale
--  Quality-failure reasons send the item to QC Hold instead of back on the shelf.
-- ---------------------------------------------------------------------
create or replace function process_return(p_sale bigint, p_lines jsonb, p_reason text, p_location int,
  p_new_lines jsonb default null, p_notes text default null, p_ts timestamptz default now())
returns bigint language plpgsql security definer set search_path = public as $$
declare
  s sales; rc reason_codes; v_ret bigint; l jsonb; sl sale_lines; v_qty numeric; v_unit_net numeric;
  v_dest int; v_qc int; v_refund numeric := 0; v_cogs numeric := 0; v_taxrate numeric; v_taxref numeric;
  v_exch bigint; v_exch_total numeric := 0;
begin
  perform _require_staff();
  select * into s from sales where id = p_sale;
  if not found then raise exception 'Sale S-% not found', p_sale; end if;
  select * into rc from reason_codes where code = p_reason and kind = 'return';
  if not found then raise exception 'A valid return reason code is required'; end if;
  if jsonb_array_length(coalesce(p_lines,'[]'::jsonb)) = 0 then raise exception 'Select at least one item to return'; end if;
  select id into v_qc from locations where kind = 'qc' order by id limit 1;
  v_taxrate := case when s.subtotal - s.discount_total > 0 then s.tax / (s.subtotal - s.discount_total) else 0 end;

  insert into returns (ts, sale_id, customer_id, location_id, kind, reason_code, notes, processed_by)
  values (p_ts, p_sale, s.customer_id, p_location,
          case when jsonb_array_length(coalesce(p_new_lines,'[]'::jsonb)) > 0 then 'exchange' else 'return' end,
          p_reason, p_notes, _actor())
  returning id into v_ret;

  for l in select * from jsonb_array_elements(p_lines) loop
    select * into sl from sale_lines where id = (l->>'sale_line_id')::bigint and sale_id = p_sale for update;
    if not found then raise exception 'Line does not belong to sale S-%', p_sale; end if;
    v_qty := (l->>'qty')::numeric;
    if v_qty <= 0 or v_qty > sl.qty - sl.returned_qty then
      raise exception 'Can only return up to % of that item', sl.qty - sl.returned_qty;
    end if;
    v_unit_net := sl.line_total / sl.qty;
    v_dest := case when rc.is_quality then v_qc else p_location end;
    perform _move(sl.item_id, v_dest, v_qty, 'return', sl.unit_cost, p_reason, 'return', v_ret, p_ts);
    insert into return_lines (return_id, sale_line_id, item_id, qty, unit_net, unit_cost, to_location, disposition)
    values (v_ret, sl.id, sl.item_id, v_qty, v_unit_net, sl.unit_cost, v_dest,
            case when rc.is_quality then 'qc_hold' else 'restock' end);
    update sale_lines set returned_qty = returned_qty + v_qty where id = sl.id;
    v_refund := v_refund + round(v_qty * v_unit_net, 2);
    v_cogs   := v_cogs + round(v_qty * sl.unit_cost, 2);
  end loop;
  v_taxref := round(v_refund * v_taxrate, 2);

  if jsonb_array_length(coalesce(p_new_lines,'[]'::jsonb)) > 0 then
    v_exch := post_sale(p_location, s.customer_id, p_new_lines, 0, 'exchange', 'EXCH', null, p_ts);
    select total into v_exch_total from sales where id = v_exch;
  end if;

  update returns set refund_total = v_refund, tax_refund = v_taxref, cogs_reversed = v_cogs,
                     exchange_sale_id = v_exch, net_due = v_exch_total - (v_refund + v_taxref)
   where id = v_ret;
  return v_ret;
end $$;

-- ---------------------------------------------------------------------
--  PURCHASING
--  p_lines: [{"item_id":1,"qty":50,"unit_cost":9.5}]
-- ---------------------------------------------------------------------
create or replace function create_purchase_order(p_supplier int, p_location int, p_lines jsonb,
  p_send boolean default true, p_notes text default null, p_ts timestamptz default now())
returns bigint language plpgsql security definer set search_path = public as $$
declare v_po bigint; l jsonb; it items;
begin
  perform _require_staff();
  if jsonb_array_length(coalesce(p_lines,'[]'::jsonb)) = 0 then raise exception 'PO has no lines'; end if;
  insert into purchase_orders (supplier_id, location_id, created_at, notes, created_by)
  values (p_supplier, p_location, p_ts, p_notes, _actor()) returning id into v_po;
  for l in select * from jsonb_array_elements(p_lines) loop
    select * into it from items where id = (l->>'item_id')::int;
    if (l->>'qty')::numeric <= 0 then raise exception 'Quantity must be positive'; end if;
    insert into po_lines (po_id, item_id, qty_ordered, unit_cost)
    values (v_po, it.id, (l->>'qty')::numeric, coalesce((l->>'unit_cost')::numeric, it.unit_cost));
  end loop;
  if p_send then perform send_purchase_order(v_po, p_ts); end if;
  return v_po;
end $$;

-- Sending stamps the order date and the expected receipt date from the supplier's quoted lead time
create or replace function send_purchase_order(p_po bigint, p_ts timestamptz default now())
returns void language plpgsql security definer set search_path = public as $$
declare v_lt int;
begin
  perform _require_staff();
  select s.lead_time_days into v_lt from purchase_orders p join suppliers s on s.id = p.supplier_id where p.id = p_po;
  update purchase_orders
     set status = 'sent', order_date = local_date(p_ts), quoted_lead_days = v_lt,
         expected_date = local_date(p_ts) + v_lt
   where id = p_po and status = 'draft';
  if not found then raise exception 'Only draft POs can be sent'; end if;
end $$;

-- p_lines: [{"po_line_id":5,"qty":40}]
create or replace function receive_purchase_order(p_po bigint, p_lines jsonb, p_location int default null,
  p_ts timestamptz default now())
returns void language plpgsql security definer set search_path = public as $$
declare p purchase_orders; l jsonb; pl po_lines; v_qty numeric; v_loc int; v_terms int; v_open numeric;
begin
  perform _require_staff();
  select * into p from purchase_orders where id = p_po for update;
  if p.status not in ('sent','partial') then raise exception 'PO-% is %, it cannot be received', p_po, p.status; end if;
  v_loc := coalesce(p_location, p.location_id);
  for l in select * from jsonb_array_elements(p_lines) loop
    v_qty := (l->>'qty')::numeric;
    continue when coalesce(v_qty,0) = 0;
    select * into pl from po_lines where id = (l->>'po_line_id')::bigint and po_id = p_po for update;
    if not found then raise exception 'Line is not on PO-%', p_po; end if;
    if v_qty < 0 or v_qty > pl.qty_ordered - pl.qty_received then
      raise exception 'Cannot receive more than the % still open', pl.qty_ordered - pl.qty_received;
    end if;
    update po_lines set qty_received = qty_received + v_qty where id = pl.id;
    insert into po_receipts (po_id, po_line_id, ts, qty, location_id, received_by)
    values (p_po, pl.id, p_ts, v_qty, v_loc, _actor());
    perform _move(pl.item_id, v_loc, v_qty, 'receipt', pl.unit_cost, null, 'po', p_po, p_ts);
    update items set unit_cost = pl.unit_cost where id = pl.item_id;
  end loop;

  select terms_days into v_terms from suppliers where id = p.supplier_id;
  select coalesce(sum(qty_ordered - qty_received),0) into v_open from po_lines where po_id = p_po;
  update purchase_orders
     set first_receipt_at = coalesce(first_receipt_at, p_ts),
         last_receipt_at  = p_ts,
         due_date = local_date(coalesce(first_receipt_at, p_ts)) + v_terms,
         status = case when v_open = 0 then 'received' else 'partial' end
   where id = p_po;
end $$;

create or replace function pay_purchase_order(p_po bigint, p_amount numeric, p_ts timestamptz default now())
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require_staff();
  if p_amount <= 0 then raise exception 'Payment must be positive'; end if;
  insert into po_payments (po_id, ts, amount) values (p_po, p_ts, p_amount);
  update purchase_orders set paid_total = paid_total + p_amount where id = p_po;
end $$;

-- Close: done with this PO (any unreceived quantity is short-closed and no longer on order)
create or replace function close_purchase_order(p_po bigint, p_ts timestamptz default now())
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require_staff();
  update purchase_orders set status = 'closed', closed_at = p_ts
   where id = p_po and status in ('sent','partial','received');
  if not found then raise exception 'PO cannot be closed from its current status'; end if;
end $$;

create or replace function cancel_purchase_order(p_po bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_staff();
  update purchase_orders set status = 'cancelled' where id = p_po and status in ('draft','sent')
     and first_receipt_at is null;
  if not found then raise exception 'Only POs with nothing received can be cancelled'; end if;
end $$;

create or replace function mark_reviewed(p_items int[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_staff();
  update items set last_reviewed_at = now() where id = any(p_items);
end $$;

-- ---------------------------------------------------------------------
--  VIEWS (security_invoker = row-level security still applies)
-- ---------------------------------------------------------------------

-- Reorder planning: lead-time demand, safety stock, ROP, EOQ, periodic review
create or replace view v_item_planning with (security_invoker = true) as
with p as (
  select (cfg('history_days')::int / 7) as weeks, cfg('ordering_cost') as s, cfg('holding_cost_pct') as hpct,
         cfg('service_z') as z, cfg('review_period_days') as r
),
u as (  -- usage = units sold + units consumed by production, bucketed by week back from now
  select t.item_id, floor(extract(epoch from (now() - t.ts)) / 604800)::int as wk, sum(-t.qty) as q
  from inventory_txns t, p
  where t.txn_type in ('sale','prod_issue') and t.ts >= now() - make_interval(days => p.weeks * 7)
  group by 1, 2
),
uw as (
  select i.id as item_id, g.wk, coalesce(u.q, 0) as q
  from items i cross join p cross join lateral generate_series(0, p.weeks - 1) g(wk)
  left join u on u.item_id = i.id and u.wk = g.wk
),
st as (select item_id, sum(q) as total, coalesce(stddev_samp(q), 0) as sd_w from uw group by item_id),
oh as (
  select inv.item_id, sum(inv.qty) filter (where l.kind <> 'qc') as on_hand,
         sum(inv.qty) filter (where l.kind = 'qc') as qc_hold
  from inventory inv join locations l on l.id = inv.location_id group by inv.item_id
),
oo as (
  select pl.item_id, sum(pl.qty_ordered - pl.qty_received) as q
  from po_lines pl join purchase_orders po on po.id = pl.po_id
  where po.status in ('sent','partial') group by pl.item_id
  union all
  select item_id, sum(case status when 'planned' then qty_planned else qty_started end)
  from production_orders where status in ('planned','in_progress') group by item_id
),
oo2 as (select item_id, sum(q) as q from oo group by item_id),
cm as (
  select sl.item_id, sum(sl.qty - sl.qty_fulfilled) as q
  from so_lines sl join sales_orders so on so.id = sl.so_id where so.status = 'placed' group by sl.item_id
),
base as (
  select i.id as item_id, i.sku, i.name, i.category, i.item_type, i.supplier_id, sp.name as supplier_name,
         i.avg_cost, i.unit_cost, i.price, i.lead_time_days, i.rop_override, i.last_reviewed_at,
         p.weeks * 7 as window_days, st.total as usage_window,
         st.total / (p.weeks * 7.0) as avg_daily,
         st.sd_w / sqrt(7.0) as sd_daily,
         p.s, p.hpct, p.z, p.r,
         coalesce(oh.on_hand, 0) as on_hand, coalesce(oh.qc_hold, 0) as qc_hold,
         coalesce(oo2.q, 0) as on_order, coalesce(cm.q, 0) as committed
  from items i cross join p
  join st on st.item_id = i.id
  left join suppliers sp on sp.id = i.supplier_id
  left join oh on oh.item_id = i.id
  left join oo2 on oo2.item_id = i.id
  left join cm on cm.item_id = i.id
  where i.active
),
calc as (
  select b.*,
         b.avg_daily * 365 as annual_demand,
         b.hpct * greatest(b.avg_cost, b.unit_cost) as holding_cost_unit,
         b.avg_daily * b.lead_time_days as lead_time_demand,
         b.z * b.sd_daily * sqrt(b.lead_time_days::numeric) as safety_stock,
         b.on_hand + b.on_order - b.committed as inv_position
  from base b
),
calc2 as (
  select c.*,
         case when c.holding_cost_unit > 0 and c.annual_demand > 0
              then sqrt(2 * c.annual_demand * c.s / c.holding_cost_unit) else 0 end as eoq,
         c.lead_time_demand + c.safety_stock as rop_calc,
         coalesce(c.rop_override, ceil(c.lead_time_demand + c.safety_stock))::numeric as rop,
         c.avg_daily * (c.r + c.lead_time_days) + c.z * c.sd_daily * sqrt(c.r + c.lead_time_days) as order_up_to
  from calc c
)
select c.*,
       ceil(c.eoq) as eoq_units,
       case when c.inv_position <= c.rop then greatest(ceil(c.eoq), ceil(c.rop - c.inv_position) + 1) else 0 end as suggested_qty,
       greatest(0, ceil(c.order_up_to - c.inv_position)) as periodic_qty,
       case when c.inv_position <= c.rop then today_local()
            when c.avg_daily > 0 then today_local() + floor((c.inv_position - c.rop) / c.avg_daily)::int
       end as order_by,
       case when c.avg_daily > 0 then round(c.on_hand / c.avg_daily, 1) end as days_of_supply,
       case when c.inv_position <= c.rop then 'Reorder now'
            when c.avg_daily > 0 and (c.inv_position - c.rop) / c.avg_daily <= 7 then 'Order soon'
            else 'OK' end as stock_status,
       (c.last_reviewed_at is null or c.last_reviewed_at < now() - make_interval(days => c.r::int)) as review_due
from calc2 c;

-- Open sales order lines with allocation, backorder qty and estimated available date
create or replace view v_so_lines with (security_invoker = true) as
with open_lines as (
  select sl.*, so.location_id, so.requested_date, so.status, so.customer_id,
         sl.qty - sl.qty_fulfilled as remaining
  from so_lines sl join sales_orders so on so.id = sl.so_id
),
alloc as (
  select ol.*,
         coalesce((select qty from inventory where item_id = ol.item_id and location_id = ol.location_id), 0) as on_hand_loc,
         sum(case when ol.status = 'placed' then ol.remaining else 0 end)
           over (partition by ol.item_id, ol.location_id order by ol.requested_date, ol.so_id, ol.id) as cum_need
  from open_lines ol
)
select a.id, a.so_id, a.item_id, i.sku, i.name, a.qty, a.unit_price, a.qty_fulfilled, a.remaining,
       a.location_id, a.requested_date, a.status, a.customer_id, a.on_hand_loc,
       case when a.status = 'placed'
            then greatest(0, least(a.remaining, a.cum_need - a.on_hand_loc)) else 0 end as backordered,
       case when a.status = 'placed' and a.cum_need > a.on_hand_loc then
         coalesce(
           (select min(coalesce(w.due_date, today_local())) from production_orders w
             where w.item_id = a.item_id and w.status in ('planned','in_progress')),
           (select min(greatest(po.expected_date, today_local())) from po_lines pl join purchase_orders po on po.id = pl.po_id
             where pl.item_id = a.item_id and po.status in ('sent','partial') and pl.qty_received < pl.qty_ordered),
           today_local() + i.lead_time_days)
       end as est_available
from alloc a join items i on i.id = a.item_id;

create or replace view v_item_backorders with (security_invoker = true) as
select item_id, sum(backordered) as backordered, min(est_available) as est_available
from v_so_lines where backordered > 0 group by item_id;

-- Purchase orders with computed totals, owed amounts, on-time result
create or replace view v_po_summary with (security_invoker = true) as
select po.*, s.name as supplier_name, s.payment_terms, s.terms_days, l.code as location_code,
       round(coalesce(x.ordered_value, 0), 2) as ordered_value, round(coalesce(x.received_value, 0), 2) as received_value,
       coalesce(x.qty_ordered, 0) as qty_ordered, coalesce(x.qty_received, 0) as qty_received,
       round(greatest(coalesce(x.received_value, 0) - po.paid_total, 0), 2) as amount_owed,
       case when po.first_receipt_at is not null then local_date(po.first_receipt_at) - po.order_date end as actual_lead_days,
       case when po.first_receipt_at is not null then local_date(po.first_receipt_at) <= po.expected_date
            when po.status in ('sent') and po.expected_date < today_local() then false end as on_time,
       (po.status in ('sent','partial') and po.expected_date < today_local()) as overdue
from purchase_orders po
join suppliers s on s.id = po.supplier_id
join locations l on l.id = po.location_id
left join (
  select po_id, sum(qty_ordered * unit_cost) as ordered_value, sum(qty_received * unit_cost) as received_value,
         sum(qty_ordered) as qty_ordered, sum(qty_received) as qty_received
  from po_lines group by po_id) x on x.po_id = po.id;

-- Supplier scorecard: everything computed from PO history
create or replace view v_supplier_scorecard with (security_invoker = true) as
with po as (select * from v_po_summary where status not in ('draft','cancelled')),
agg as (
  select s.id as supplier_id, s.name, s.contact_name, s.email, s.phone, s.lead_time_days as quoted_lead_days,
         s.payment_terms, s.terms_days,
         count(po.id) as po_count,
         count(po.id) filter (where po.first_receipt_at is not null) as delivered_count,
         count(po.id) filter (where po.on_time) as on_time_count,
         count(po.id) filter (where po.on_time is not null) as on_time_base,
         avg(po.actual_lead_days) as avg_actual_lead_days,
         sum(po.qty_received) filter (where po.first_receipt_at is not null) as qty_received,
         sum(po.qty_ordered)  filter (where po.first_receipt_at is not null) as qty_ordered,
         round(coalesce(sum(po.amount_owed), 0), 2) as amount_owed,
         round(coalesce(sum(po.amount_owed) filter (where po.due_date < today_local()), 0), 2) as amount_overdue,
         min(po.due_date) filter (where po.amount_owed > 0) as next_due_date,
         round(coalesce(sum(po.received_value), 0), 2) as spend
  from suppliers s left join po on po.supplier_id = s.id
  group by s.id
),
sc as (
  select a.*,
         case when on_time_base > 0 then on_time_count::numeric / on_time_base end as on_time_rate,
         case when qty_ordered > 0 then qty_received / qty_ordered end as fill_rate,
         case when avg_actual_lead_days > 0 then least(1, quoted_lead_days / avg_actual_lead_days) end as lead_time_accuracy
  from agg a
)
select sc.*,
       round(100 * (cfg('score_w_ontime') * coalesce(on_time_rate, 0)
                  + cfg('score_w_fill')   * coalesce(fill_rate, 0)
                  + cfg('score_w_lead')   * coalesce(lead_time_accuracy, 0))
                 / nullif(cfg('score_w_ontime') + cfg('score_w_fill') + cfg('score_w_lead'), 0), 1) as score,
       case when delivered_count = 0 then 'New'
            when 100 * (cfg('score_w_ontime') * coalesce(on_time_rate, 0) + cfg('score_w_fill') * coalesce(fill_rate, 0)
                  + cfg('score_w_lead') * coalesce(lead_time_accuracy, 0))
                 / nullif(cfg('score_w_ontime') + cfg('score_w_fill') + cfg('score_w_lead'), 0) >= cfg('score_keep') then 'Keep'
            when 100 * (cfg('score_w_ontime') * coalesce(on_time_rate, 0) + cfg('score_w_fill') * coalesce(fill_rate, 0)
                  + cfg('score_w_lead') * coalesce(lead_time_accuracy, 0))
                 / nullif(cfg('score_w_ontime') + cfg('score_w_fill') + cfg('score_w_lead'), 0) >= cfg('score_watch') then 'Watch'
            else 'Replace' end as rating
from sc;

-- Inventory valuation (weighted average cost) by item and location
create or replace view v_inventory_valuation with (security_invoker = true) as
select i.id as item_id, i.sku, i.name, i.category, i.item_type, l.id as location_id, l.code as location_code,
       l.kind as location_kind, inv.qty, i.avg_cost, round(inv.qty * i.avg_cost, 2) as value
from inventory inv join items i on i.id = inv.item_id join locations l on l.id = inv.location_id;

-- ---------------------------------------------------------------------
--  REPORT FUNCTIONS
-- ---------------------------------------------------------------------
create or replace function inventory_value_at(p_date date) returns numeric
language sql stable as $$
  select coalesce(round(sum(qty * unit_cost), 2), 0) from inventory_txns where local_date(ts) <= p_date
$$;

create or replace function pnl(p_from date, p_to date) returns json
language plpgsql stable as $$
declare
  v_gross numeric; v_disc numeric; v_tax numeric; v_cogs numeric; v_ret numeric; v_ret_cogs numeric; v_ret_tax numeric;
  v_writeoff numeric; v_scrapmemo numeric; v_days int; v_opex numeric; v_netrev numeric; v_netcogs numeric; v_gp numeric;
  v_rent numeric; v_wages numeric; v_other numeric;
begin
  select coalesce(sum(subtotal),0), coalesce(sum(discount_total),0), coalesce(sum(tax),0), coalesce(sum(cogs),0)
    into v_gross, v_disc, v_tax, v_cogs from sales where local_date(ts) between p_from and p_to;
  select coalesce(sum(refund_total),0), coalesce(sum(cogs_reversed),0), coalesce(sum(tax_refund),0)
    into v_ret, v_ret_cogs, v_ret_tax from returns where local_date(ts) between p_from and p_to;
  select coalesce(-sum(qty * unit_cost),0) into v_writeoff from inventory_txns
   where txn_type = 'adjust' and local_date(ts) between p_from and p_to;
  select coalesce(sum(scrap_cost),0) into v_scrapmemo from production_orders
   where status = 'completed' and local_date(finished_at) between p_from and p_to;
  v_days := p_to - p_from + 1;
  v_rent := round(cfg('opex_rent') * v_days / 30.4375, 2);
  v_wages := round(cfg('opex_wages') * v_days / 30.4375, 2);
  v_other := round(cfg('opex_other') * v_days / 30.4375, 2);
  v_opex := v_rent + v_wages + v_other;
  v_netrev := v_gross - v_disc - v_ret;
  v_netcogs := v_cogs - v_ret_cogs;
  v_gp := v_netrev - v_netcogs;
  return json_build_object(
    'from', p_from, 'to', p_to, 'days', v_days,
    'gross_sales', v_gross, 'discounts', v_disc, 'returns', v_ret, 'net_revenue', v_netrev,
    'cogs', v_cogs, 'cogs_returns', v_ret_cogs, 'net_cogs', v_netcogs,
    'gross_profit', v_gp, 'gross_margin', case when v_netrev <> 0 then v_gp / v_netrev end,
    'inventory_writeoffs', round(v_writeoff, 2), 'opex_rent', v_rent, 'opex_wages', v_wages, 'opex_other', v_other,
    'operating_expenses', v_opex,
    'operating_income', v_gp - round(v_writeoff, 2) - v_opex,
    'tax_collected', v_tax - v_ret_tax, 'scrap_cost_memo', v_scrapmemo);
end $$;

create or replace function inventory_metrics(p_from date, p_to date) returns json
language plpgsql stable as $$
declare v_begin numeric; v_end numeric; v_avg numeric; v_cogs numeric; v_days int; v_turns numeric;
begin
  v_begin := inventory_value_at(p_from - 1);
  v_end   := inventory_value_at(p_to);
  v_avg   := (v_begin + v_end) / 2;
  select coalesce(sum(cogs),0) into v_cogs from sales where local_date(ts) between p_from and p_to;
  select v_cogs - coalesce(sum(cogs_reversed),0) into v_cogs from returns where local_date(ts) between p_from and p_to;
  v_days := p_to - p_from + 1;
  v_turns := case when v_avg > 0 then v_cogs / v_avg end;
  return json_build_object('from', p_from, 'to', p_to, 'days', v_days,
    'begin_value', v_begin, 'end_value', v_end, 'avg_value', round(v_avg, 2), 'cogs', v_cogs,
    'turnover', round(v_turns, 2),
    'annualized_turnover', round(v_turns * 365.0 / v_days, 2),
    'days_on_hand', case when v_turns > 0 then round(v_days / v_turns, 1) end,
    'current_value', (select coalesce(sum(value),0) from v_inventory_valuation));
end $$;

-- monthly inventory turnover trend (last N months)
create or replace function turnover_trend(p_months int default 6)
returns table(month date, cogs numeric, avg_value numeric, annualized_turnover numeric)
language sql stable as $$
  with m as (
    select (date_trunc('month', today_local()) - make_interval(months => g))::date as m_start
    from generate_series(p_months - 1, 0, -1) g
  ), r as (
    select m_start, least((m_start + interval '1 month')::date - 1, today_local()) as m_end from m
  )
  select r.m_start,
         ((inventory_metrics(r.m_start, r.m_end))->>'cogs')::numeric,
         ((inventory_metrics(r.m_start, r.m_end))->>'avg_value')::numeric,
         ((inventory_metrics(r.m_start, r.m_end))->>'annualized_turnover')::numeric
  from r;
$$;

create or replace function sales_by_period(p_from date, p_to date, p_grain text default 'day')
returns table(period date, orders bigint, units numeric, revenue numeric, cogs numeric, gross_profit numeric)
language sql stable as $$
  with s as (
    select date_trunc(case when p_grain = 'week' then 'week' when p_grain = 'month' then 'month' else 'day' end,
                      local_date(ts))::date as period, id, subtotal - discount_total as rev, cogs
    from sales where local_date(ts) between p_from and p_to
  ), u as (
    select s.period, sum(l.qty) as units from s join sale_lines l on l.sale_id = s.id group by s.period
  )
  select s.period, count(*), coalesce(max(u.units), 0), sum(s.rev), sum(s.cogs), sum(s.rev) - sum(s.cogs)
  from s left join u on u.period = s.period group by s.period order by s.period;
$$;

create or replace function top_items(p_from date, p_to date, p_limit int default 10)
returns table(item_id int, sku text, name text, category text, units numeric, revenue numeric, gross_profit numeric)
language sql stable as $$
  select i.id, i.sku, i.name, i.category, sum(l.qty), sum(l.line_total), sum(l.line_total - l.qty * l.unit_cost)
  from sale_lines l join sales s on s.id = l.sale_id join items i on i.id = l.item_id
  where local_date(s.ts) between p_from and p_to
  group by i.id order by sum(l.line_total) desc limit p_limit;
$$;

-- weekly quality data for the p-chart (production defects = scrap + rework)
create or replace function quality_weekly(p_weeks int default 26)
returns table(week_start date, orders bigint, units_started numeric, scrap numeric, rework numeric, defects numeric,
              opportunities numeric)
language sql stable as $$
  select date_trunc('week', local_date(w.finished_at))::date, count(*), sum(w.qty_started), sum(w.qty_scrap),
         sum(w.qty_rework), sum(w.qty_scrap + w.qty_rework), sum(w.qty_started * i.defect_opportunities)
  from production_orders w join items i on i.id = w.item_id
  where w.status = 'completed' and not w.auto
    and local_date(w.finished_at) >= date_trunc('week', today_local())::date - (p_weeks - 1) * 7
  group by 1 order by 1;
$$;

-- Pareto of defect / failure reasons across production, returns and inventory damage
create or replace function defect_pareto(p_from date, p_to date)
returns table(source text, reason_code text, description text, qty numeric)
language sql stable as $$
  with x as (
    select 'Production scrap' as source, scrap_reason as code, qty_scrap as qty from production_orders
     where status = 'completed' and qty_scrap > 0 and local_date(finished_at) between p_from and p_to
    union all
    select 'Production rework', rework_reason, qty_rework from production_orders
     where status = 'completed' and qty_rework > 0 and local_date(finished_at) between p_from and p_to
    union all
    select 'Customer return', r.reason_code, rl.qty from returns r join return_lines rl on rl.return_id = r.id
     join reason_codes rc on rc.code = r.reason_code
     where rc.is_quality and local_date(r.ts) between p_from and p_to
    union all
    select 'Inventory damage', t.reason_code, -t.qty from inventory_txns t join reason_codes rc on rc.code = t.reason_code
     where t.txn_type = 'adjust' and rc.is_quality and t.qty < 0 and local_date(t.ts) between p_from and p_to
  )
  select x.source, x.code, rc.description, sum(x.qty)
  from x join reason_codes rc on rc.code = x.code
  group by 1, 2, 3 order by 4 desc;
$$;

-- ---------------------------------------------------------------------
--  MRP — time-phased, lot-for-lot, weekly buckets
--  Level 0: parent (kit) items and finished products demanded on open sales orders
--  Level 1: components, gross = parent planned orders x BOM qty (+ any direct demand)
--  Net = gross - on hand - scheduled receipts (open POs / open work orders)
--  Order-by date = need date - lead time
-- ---------------------------------------------------------------------
create or replace function mrp_bucket(d date, p_today date, p_weeks int) returns int
language sql immutable as $$ select least(p_weeks, greatest(1, floor((d - p_today) / 7.0)::int + 1)) $$;

create or replace function mrp_plan(p_weeks int default 4)
returns table(item_id int, sku text, name text, item_type text, mrp_level int, lead_time_days int,
              supplier_name text, on_hand numeric, week int, week_start date, gross numeric,
              sched_receipts numeric, projected_oh numeric, net_req numeric, need_date date, order_by date)
language sql stable as $$
with
t as (select today_local() as d0, p_weeks as nw),
wk as (select g as w, (select d0 from t) + 7 * (g - 1) as ws from generate_series(1, p_weeks) g),
oh as (
  select inv.item_id, sum(inv.qty) as q from inventory inv join locations l on l.id = inv.location_id
  where l.kind <> 'qc' group by inv.item_id
),
-- independent demand: open (placed) sales orders inside the horizon (past-due counts in week 1)
d0 as (
  select sl.item_id, mrp_bucket(so.requested_date, t.d0, t.nw) as w,
         min(so.requested_date) as first_need, sum(sl.qty - sl.qty_fulfilled) as q
  from so_lines sl join sales_orders so on so.id = sl.so_id, t
  where so.status = 'placed' and so.requested_date < t.d0 + 7 * t.nw and sl.qty > sl.qty_fulfilled
  group by 1, 2
),
-- scheduled receipts for parents: open work orders
sr_wo as (
  select w.item_id, mrp_bucket(coalesce(w.due_date, t.d0), t.d0, t.nw) as w,
         sum(case w.status when 'planned' then w.qty_planned else w.qty_started end) as q
  from production_orders w, t where w.status in ('planned','in_progress') group by 1, 2
),
-- scheduled receipts for bought items: open purchase order quantities
sr_po as (
  select pl.item_id, mrp_bucket(po.expected_date, t.d0, t.nw) as w, sum(pl.qty_ordered - pl.qty_received) as q
  from po_lines pl join purchase_orders po on po.id = pl.po_id, t
  where po.status in ('sent','partial') and po.expected_date < t.d0 + 7 * t.nw group by 1, 2
),
-- ---- level 0 netting (kits)
k as (
  select i.id as item_id, wk.w, wk.ws, coalesce(d0.q, 0) as gross, coalesce(sr.q, 0) as sr, d0.first_need,
         coalesce(oh.q, 0) as onhand, i.lead_time_days as lt
  from items i cross join wk
  left join d0 on d0.item_id = i.id and d0.w = wk.w
  left join sr_wo sr on sr.item_id = i.id and sr.w = wk.w
  left join oh on oh.item_id = i.id
  where i.item_type = 'kit'
),
k2 as (
  select k.*, sum(gross) over (partition by item_id order by w) as cg,
              sum(sr) over (partition by item_id order by w) as csr
  from k
),
k3 as (
  select k2.*, greatest(0, max(cg - onhand - csr) over (partition by item_id order by w)) as cum_planned from k2
),
k4 as (
  select k3.*, cum_planned - coalesce(lag(cum_planned) over (partition by item_id order by w), 0) as planned,
         onhand + csr + cum_planned - cg as poh
  from k3
),
-- ---- dependent demand: explode parent planned orders + not-yet-issued work orders through the BOM
dep as (
  select b.component_id as item_id,
         mrp_bucket(coalesce(k4.first_need, k4.ws) - k4.lt, t.d0, t.nw) as w,
         min(coalesce(k4.first_need, k4.ws) - k4.lt) as first_need,
         sum(k4.planned * b.qty) as q
  from k4 join bom b on b.parent_id = k4.item_id, t
  where k4.planned > 0 group by 1, 2
  union all
  select b.component_id, mrp_bucket(coalesce(w.due_date, t.d0) - i.lead_time_days, t.d0, t.nw),
         min(coalesce(w.due_date, t.d0) - i.lead_time_days), sum(w.qty_planned * b.qty)
  from production_orders w join items i on i.id = w.item_id join bom b on b.parent_id = w.item_id, t
  where w.status = 'planned' group by 1, 2
),
d1 as (
  select item_id, w, min(first_need) as first_need, sum(q) as q from (
    select item_id, w, first_need, q from d0 where item_id in (select id from items where item_type <> 'kit')
    union all select item_id, w, first_need, q from dep) z
  group by 1, 2
),
c as (
  select i.id as item_id, wk.w, wk.ws, coalesce(d1.q, 0) as gross, coalesce(sr.q, 0) as sr, d1.first_need,
         coalesce(oh.q, 0) as onhand, i.lead_time_days as lt
  from items i cross join wk
  left join d1 on d1.item_id = i.id and d1.w = wk.w
  left join sr_po sr on sr.item_id = i.id and sr.w = wk.w
  left join oh on oh.item_id = i.id
  where i.item_type <> 'kit'
),
c2 as (
  select c.*, sum(gross) over (partition by item_id order by w) as cg,
              sum(sr) over (partition by item_id order by w) as csr
  from c
),
c3 as (
  select c2.*, greatest(0, max(cg - onhand - csr) over (partition by item_id order by w)) as cum_planned from c2
),
c4 as (
  select c3.*, cum_planned - coalesce(lag(cum_planned) over (partition by item_id order by w), 0) as planned,
         onhand + csr + cum_planned - cg as poh
  from c3
),
allrows as (
  select item_id, w, ws, gross, sr, onhand, poh, planned, first_need, lt, 0 as lvl from k4
  union all
  select item_id, w, ws, gross, sr, onhand, poh, planned, first_need, lt,
         case when exists (select 1 from bom b where b.component_id = c4.item_id) then 1 else 0 end from c4
)
select a.item_id, i.sku, i.name, i.item_type, a.lvl, a.lt, s.name, round(a.onhand, 2), a.w, a.ws, round(a.gross, 2),
       round(a.sr, 2), round(a.poh, 2), round(a.planned, 2),
       case when a.planned > 0 then coalesce(a.first_need, a.ws) end,
       case when a.planned > 0 then coalesce(a.first_need, a.ws) - a.lt end
from allrows a join items i on i.id = a.item_id left join suppliers s on s.id = i.supplier_id
where a.item_id in (select item_id from allrows group by item_id having sum(gross) > 0 or sum(sr) > 0)
order by a.lvl, i.sku, a.w;
$$;

-- ---------------------------------------------------------------------
--  AUTH: profile on sign-up (staff code in metadata grants staff/manager)
-- ---------------------------------------------------------------------
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_role text := 'customer'; v_cust int; v_name text; v_code text;
begin
  v_name := coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1));
  v_code := new.raw_user_meta_data->>'staff_code';
  if v_code is not null and v_code = (select value from app_secrets where key = 'staff_code') then
    v_role := case when new.raw_user_meta_data->>'role' = 'manager' then 'manager' else 'staff' end;
  end if;
  if v_role = 'customer' then
    select id into v_cust from customers where lower(email) = lower(new.email);
    if v_cust is null then
      insert into customers (name, kind, contact_name, email, city)
      values (v_name, 'individual', v_name, new.email, 'Provo') returning id into v_cust;
    end if;
  end if;
  insert into profiles (id, email, full_name, role, customer_id)
  values (new.id, new.email, v_name, v_role, v_cust)
  on conflict (id) do update set role = excluded.role, customer_id = excluded.customer_id;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function handle_new_user();

-- re-create profiles for users that signed up before a rebuild
insert into profiles (id, email, full_name, role)
select u.id, u.email, coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email,'@',1)),
       case when u.raw_user_meta_data->>'staff_code' is not null
            then case when u.raw_user_meta_data->>'role' = 'manager' then 'manager' else 'staff' end
            else 'customer' end
from auth.users u on conflict do nothing;

-- staff can upgrade an existing login with the staff code
create or replace function claim_staff(p_code text, p_role text default 'staff') returns text
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Log in first'; end if;
  if p_code is distinct from (select value from app_secrets where key = 'staff_code') then
    raise exception 'Incorrect staff code';
  end if;
  update profiles set role = case when p_role = 'manager' then 'manager' else 'staff' end where id = auth.uid();
  return 'ok';
end $$;

-- ---------------------------------------------------------------------
--  ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['settings','locations','suppliers','customers','items','bom','inventory','reason_codes',
    'inventory_txns','sales_orders','so_lines','sales','sale_lines','returns','return_lines','production_orders',
    'purchase_orders','po_lines','po_receipts','po_payments','profiles','app_secrets'] loop
    execute format('alter table %I enable row level security', t);
    if t not in ('app_secrets') then
      execute format('create policy staff_all on %I for all to authenticated using (is_staff()) with check (is_staff())', t);
    end if;
  end loop;
end $$;

-- customers (portal) can browse the catalog and see availability
create policy catalog_read on items        for select to authenticated using (active and sellable);
create policy catalog_read on locations    for select to authenticated using (true);
create policy catalog_read on inventory    for select to authenticated using (true);
create policy catalog_read on bom          for select to authenticated using (true);
create policy catalog_read on settings     for select to authenticated using (true);
create policy catalog_read on reason_codes for select to authenticated using (true);
-- ...and their own records
create policy own_customer on customers    for select to authenticated using (id = my_customer_id());
create policy own_orders   on sales_orders for select to authenticated using (customer_id = my_customer_id());
create policy own_lines    on so_lines     for select to authenticated
  using (so_id in (select id from sales_orders where customer_id = my_customer_id()));
create policy own_profile  on profiles     for select to authenticated using (id = auth.uid());
-- only managers change roles
drop policy staff_all on profiles;
create policy staff_read on profiles for select to authenticated using (is_staff());
create policy mgr_write  on profiles for update to authenticated using (my_role() = 'manager') with check (my_role() = 'manager');
-- only managers change settings
drop policy staff_all on settings;
create policy mgr_settings on settings for update to authenticated using (my_role() = 'manager') with check (my_role() = 'manager');

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;

-- ---------------------------------------------------------------------
--  REALTIME: push changes to every logged-in user
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['inventory','sales','sales_orders','purchase_orders','production_orders','returns',
                             'items','settings','suppliers','customers'] loop
      begin
        execute format('alter publication supabase_realtime add table %I', t);
      exception when duplicate_object then null;
      end;
    end loop;
  end if;
end $$;
