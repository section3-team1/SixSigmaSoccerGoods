-- =====================================================================
--  SIX SIGMA SOCCER GOODS (SSSG) — Mini-ERP database
--  File 2 of 2: master data + 6-month history generator
--  Run after 01_schema.sql.  To reset the demo later:  select seed_demo();
--
--  The generator simulates the business day by day, calling the SAME
--  functions the app uses (post_sale, receive_purchase_order, ...), so
--  on-hand, costs, and the ledger always agree.
-- =====================================================================

-- seasonality (monthly factors, smoothly interpolated)
create or replace function _sim_season(p text, d date) returns numeric
language plpgsql immutable as $$
declare f numeric[]; pos numeric; lo int; hi int; fr numeric;
begin
  f := case p
    when 'cleats' then array[0.6,1.1,1.6,1.3,1.0,0.7,0.9,2.4,1.4,0.9,0.6,0.7]
    when 'steady' then array[0.9,0.95,1.05,1.0,1.0,0.95,1.0,1.2,1.1,1.0,0.9,1.0]
    when 'camp'   then array[0.6,0.9,1.2,1.1,1.1,1.5,1.5,1.4,1.0,0.8,0.6,0.9]
    when 'team'   then array[0.4,1.0,1.5,0.9,0.6,0.5,1.0,2.6,1.6,0.7,0.6,0.4]
    else               array[0.6,1.0,1.4,1.2,1.0,0.75,0.85,1.9,1.45,1.0,0.7,0.85] end;
  pos := extract(month from d) + (extract(day from d) - 15) / 30.0;
  lo := floor(pos); fr := pos - lo; hi := lo + 1;
  lo := ((lo - 1 + 12) % 12) + 1; hi := ((hi - 1 + 12) % 12) + 1;
  return f[lo] * (1 - fr) + f[hi] * fr;
end $$;

create or replace function _sim_poisson(lambda numeric) returns int
language plpgsql volatile as $$
declare l numeric := exp(-lambda); k int := 0; p numeric := 1;
begin
  if lambda <= 0 then return 0; end if;
  loop k := k + 1; p := p * random(); exit when p <= l; end loop;
  return k - 1;
end $$;

create or replace function _sim_binom(n numeric, p numeric) returns int
language plpgsql volatile as $$
declare k int := 0; i int;
begin
  for i in 1..coalesce(n,0)::int loop if random() < p then k := k + 1; end if; end loop;
  return k;
end $$;

create or replace function _sim_onhand(p_item int, p_loc int) returns numeric
language sql stable as $$ select coalesce((select qty from inventory where item_id = p_item and location_id = p_loc), 0) $$;

-- expected company-wide daily usage of an item (direct + through BOMs) on a date
create or replace function _sim_exp(p_item int, d date) returns numeric
language plpgsql stable as $$
declare v numeric;
begin
  select coalesce((select base * _sim_season(prof, d) from _si where item_id = p_item), 0)
       + coalesce((select sum(s.base * _sim_season(s.prof, d) * b.qty)
                     from bom b join _si s on s.item_id = b.parent_id where b.component_id = p_item), 0)
    into v;
  return v;
end $$;

-- how many units could be sold at a location right now (bundles can be kitted from components)
create or replace function _sim_can_sell(p_item int, p_loc int, p_qty numeric) returns numeric
language plpgsql stable as $$
declare it items; v_have numeric; v_kits numeric;
begin
  select * into it from items where id = p_item;
  v_have := _sim_onhand(p_item, p_loc);
  if it.item_type = 'kit' and it.auto_assemble then
    select coalesce(min(floor(_sim_onhand(b.component_id, p_loc) / b.qty)), 0) into v_kits from bom b where b.parent_id = p_item;
    v_have := v_have + v_kits;
  end if;
  return least(p_qty, v_have);
end $$;

create or replace function _sim_ts(d date, h0 numeric, h1 numeric) returns timestamptz
language sql volatile as $$
  select ((d + make_interval(secs => (h0 + random() * (h1 - h0)) * 3600))::timestamp) at time zone 'America/Denver'
$$;

-- =====================================================================
create or replace function seed_demo(p_days int default 183) returns text
language plpgsql security definer set search_path = public, pg_temp
set statement_timeout = 0 as $$
#variable_conflict use_column
declare
  v_end date := today_local();
  v_start date := today_local() - p_days;
  d date; v_dow int; v_prog numeric; wd numeric; v_ts timestamptz;
  v_prv int; v_orm int; v_whs int; v_qch int;
  r record; s record; w record; sp record; st record;
  v_id bigint; v_lines jsonb; v_arr jsonb; v_basket jsonb; e jsonb;
  n int; k int; i int; v_size int; v_q numeric; v_can numeric; v_cust int; v_disc numeric;
  v_exp numeric; v_ip numeric; v_s numeric; v_big numeric; v_lt int; v_arrive date; v_late boolean;
  v_q1 numeric; v_rest numeric; v_scrap int; v_rew int; v_good numeric; v_p_scrap numeric; v_p_rew numeric;
  v_sr text; v_rr text; v_reason text; v_cat text; v_newlines jsonb; v_owed numeric; v_target numeric;
  v_kit_jsy int; v_kit_gk int; v_cnt int;
begin
  perform _require_manager();
  perform setseed(0.2026);

  truncate po_payments, po_receipts, po_lines, purchase_orders, return_lines, returns, sale_lines, sales,
           so_lines, sales_orders, production_orders, inventory_txns, inventory, bom, items, suppliers,
           locations, reason_codes restart identity cascade;

  -- ---------------- settings
  insert into settings (key, value, label, unit, grp, sort) values
    ('tax_rate',          0.0725, 'Sales tax rate (Utah County)',           'rate',  'Point of Sale', 1),
    ('ordering_cost',     45,     'Ordering cost per purchase order (S)',    '$',     'Inventory Policy', 10),
    ('holding_cost_pct',  0.25,   'Annual holding cost (% of unit cost) (H)', 'rate', 'Inventory Policy', 11),
    ('service_z',         1.65,   'Service level z-score (1.65 = 95%)',      'z',     'Inventory Policy', 12),
    ('review_period_days',14,     'Periodic review interval',                'days',  'Inventory Policy', 13),
    ('history_days',      182,    'Sales history window for usage',          'days',  'Inventory Policy', 14),
    ('opex_rent',         4000,   'Monthly rent (2 stores + warehouse)',     '$/mo',  'Finance', 20),
    ('opex_wages',        12500,  'Monthly wages',                           '$/mo',  'Finance', 21),
    ('opex_other',        1500,   'Monthly utilities, software, other',      '$/mo',  'Finance', 22),
    ('score_w_ontime',    0.45,   'Scorecard weight: on-time delivery',      'weight','Supplier Scorecard', 30),
    ('score_w_fill',      0.35,   'Scorecard weight: fill rate',             'weight','Supplier Scorecard', 31),
    ('score_w_lead',      0.20,   'Scorecard weight: lead-time accuracy',    'weight','Supplier Scorecard', 32),
    ('score_keep',        92,     'Score needed to KEEP a supplier',         'pts',   'Supplier Scorecard', 33),
    ('score_watch',       75,     'Score needed to WATCH (below = REPLACE)', 'pts',   'Supplier Scorecard', 34)
  on conflict (key) do update set value = excluded.value, label = excluded.label, unit = excluded.unit,
                                  grp = excluded.grp, sort = excluded.sort;
  insert into app_secrets values ('staff_code', 'SSSG2026') on conflict (key) do nothing;

  -- ---------------- locations
  insert into locations (code, name, kind, address) values
    ('PRV', 'Provo Store',               'store',     '450 N University Ave, Provo, UT'),
    ('ORM', 'Orem Store',                'store',     '1200 S State St, Orem, UT'),
    ('WHS', 'Warehouse & Print Shop',    'warehouse', '2250 S Industrial Pkwy, Provo, UT'),
    ('QCH', 'QC Hold (Returns Inspection)', 'qc',     'Warehouse - Bay 4');
  select id into v_prv from locations where code = 'PRV';
  select id into v_orm from locations where code = 'ORM';
  select id into v_whs from locations where code = 'WHS';
  select id into v_qch from locations where code = 'QCH';

  -- ---------------- suppliers
  insert into suppliers (name, contact_name, email, phone, address, lead_time_days, payment_terms, terms_days, notes) values
    ('Apex Ball Co.',            'Rachel Kim',     'orders@apexball.example.com',     '801-555-0141', 'Salt Lake City, UT', 10, 'Net 30', 30, 'Soccer balls'),
    ('GripTech Goalkeeping',     'Marco Bianchi',  'sales@griptech.example.com',      '714-555-0177', 'Irvine, CA',         14, 'Net 45', 45, 'Goalkeeper gloves'),
    ('Pacific Rim Apparel',      'Linh Tran',      'export@pacrimapparel.example.com','+84 28 555 0190','Ho Chi Minh City, VN', 35, 'Net 60', 60, 'Jersey blanks (overseas)'),
    ('StrideLine Footwear',      'Greg Olsen',     'b2b@strideline.example.com',      '503-555-0122', 'Portland, OR',       21, 'Net 30', 30, 'Cleats and turf shoes'),
    ('ShieldGuard Sports',       'Dana Whitaker',  'support@shieldguard.example.com', '469-555-0108', 'Dallas, TX',         12, 'Net 30', 30, 'Shin guards'),
    ('Summit Socks & Print Supply','Ben Alvarez',  'orders@summitsocks.example.com',  '385-555-0163', 'Ogden, UT',           7, 'Net 15', 15, 'Socks, heat transfers, patches, bags, pumps');

  -- ---------------- reason codes
  insert into reason_codes (code, kind, description, is_quality) values
    ('CC-OVER',     'adjust', 'Cycle count overage',                         false),
    ('CC-SHORT',    'adjust', 'Cycle count shortage',                        false),
    ('DMG',         'adjust', 'Damaged in store / warehouse',                true),
    ('SHRINK',      'adjust', 'Theft / unexplained shrink',                  false),
    ('FOUND',       'adjust', 'Found stock',                                 false),
    ('QC-SCRAP',    'adjust', 'Scrapped after QC inspection',                false),
    ('QC-PASS',     'adjust', 'Passed QC inspection (move back to stock)',   false),
    ('WRONG-SIZE',  'return', 'Wrong size',                                  false),
    ('CHANGED-MIND','return', 'Customer changed mind',                       false),
    ('Q-AIR',       'return', 'Quality: ball will not hold air',             true),
    ('Q-SEAM',      'return', 'Quality: seam / stitching failure',           true),
    ('Q-SOLE',      'return', 'Quality: sole separation / broken stud',      true),
    ('Q-PRINT',     'return', 'Quality: print peeling or misprinted',        true),
    ('Q-STRAP',     'return', 'Quality: strap / elastic failure',            true),
    ('PR-MISALIGN', 'scrap',  'Heat press misaligned',                       true),
    ('PR-WRONGNUM', 'scrap',  'Wrong number or name pressed',                true),
    ('PR-SCORCH',   'scrap',  'Fabric scorched by press',                    true),
    ('PR-PEEL',     'scrap',  'Transfer did not bond',                       true),
    ('KIT-DMG',     'scrap',  'Component damaged during kitting',            true),
    ('RW-REPRESS',  'rework', 'Re-pressed lifted transfer edge',             true),
    ('RW-MISSING',  'rework', 'Kit missing a component - re-kitted',         true),
    ('RW-RELABEL',  'rework', 'Wrong size label - relabeled',                true);

  -- ---------------- items
  insert into items (sku, barcode, name, category, item_type, supplier_id, unit_cost, avg_cost, price,
                     lead_time_days, auto_assemble, defect_opportunities, sellable, description)
  select v.sku, 'TBD-' || v.sku, v.name, v.cat, v.typ, (select id from suppliers where name = v.sup),
         v.cost, 0, v.price, coalesce(v.lt, (select lead_time_days from suppliers where name = v.sup)),
         v.auto, v.opps, v.typ <> 'component', v.descr
  from (values
    ('BAL-MTC5','Match Ball Size 5',          'Soccer Balls', 'product',  'Apex Ball Co.',        24.00,  49.99, null, false, 1, 'FIFA-quality thermobonded match ball'),
    ('BAL-TRN5','Training Ball Size 5',       'Soccer Balls', 'product',  'Apex Ball Co.',         9.50,  21.99, null, false, 1, 'Machine-stitched training ball'),
    ('BAL-YTH4','Youth Ball Size 4',          'Soccer Balls', 'product',  'Apex Ball Co.',         8.00,  17.99, null, false, 1, 'Ages 8-12'),
    ('BAL-MIN3','Mini Skills Ball Size 3',    'Soccer Balls', 'product',  'Apex Ball Co.',         5.50,  12.99, null, false, 1, 'Ages 4-8 / skills'),
    ('GLV-PRO', 'Pro Goalkeeper Gloves',      'Goalie Gloves','product',  'GripTech Goalkeeping', 28.00,  64.99, null, false, 1, '4mm German latex, finger saves'),
    ('GLV-YTH', 'Youth Goalkeeper Gloves',    'Goalie Gloves','product',  'GripTech Goalkeeping', 11.00,  27.99, null, false, 1, 'Youth sizes 4-7'),
    ('JSY-HOME','Home Jersey Blank (Royal)',  'Jerseys',      'product',  'Pacific Rim Apparel',   9.00,  29.99, null, false, 1, 'Moisture-wicking polyester'),
    ('JSY-AWAY','Away Jersey Blank (White)',  'Jerseys',      'product',  'Pacific Rim Apparel',   9.00,  29.99, null, false, 1, 'Moisture-wicking polyester'),
    ('JSY-GK',  'GK Jersey Blank (Padded)',   'Jerseys',      'product',  'Pacific Rim Apparel',  14.00,  39.99, null, false, 1, 'Long sleeve, padded elbows'),
    ('CLT-FG',  'Firm Ground Cleat',          'Cleats',       'product',  'StrideLine Footwear',  42.00,  99.99, null, false, 1, 'Adult FG cleat'),
    ('CLT-YTH', 'Youth Cleat',                'Cleats',       'product',  'StrideLine Footwear',  18.00,  44.99, null, false, 1, 'Youth molded cleat'),
    ('CLT-TURF','Turf Shoe',                  'Cleats',       'product',  'StrideLine Footwear',  30.00,  74.99, null, false, 1, 'Turf / futsal'),
    ('SHN-SLIP','Slip-in Shin Guards',        'Shin Guards',  'product',  'ShieldGuard Sports',    6.00,  16.99, null, false, 1, 'Adult slip-in'),
    ('SHN-YTH', 'Youth Ankle Shin Guards',    'Shin Guards',  'product',  'ShieldGuard Sports',    7.50,  19.99, null, false, 1, 'Youth with ankle protection'),
    ('SHN-PRO', 'Carbon Pro Shin Guards',     'Shin Guards',  'product',  'ShieldGuard Sports',   16.00,  39.99, null, false, 1, 'Carbon fiber shell'),
    ('SCK-WHT', 'Team Socks (White)',         'Soccer Socks', 'product',  'Summit Socks & Print Supply', 2.75, 9.99, null, false, 1, 'Over-the-calf'),
    ('SCK-BLK', 'Team Socks (Black)',         'Soccer Socks', 'product',  'Summit Socks & Print Supply', 2.75, 9.99, null, false, 1, 'Over-the-calf'),
    ('SCK-GRP', 'Grip Socks',                 'Soccer Socks', 'product',  'Summit Socks & Print Supply', 5.00, 16.99, null, false, 1, 'Anti-slip crew'),
    ('CMP-NUM', 'Heat-Transfer Number Set',   'Components',   'component','Summit Socks & Print Supply', 1.40, 0, null, false, 1, 'Front + back numbers'),
    ('CMP-NAME','Heat-Transfer Name Bar',     'Components',   'component','Summit Socks & Print Supply', 1.10, 0, null, false, 1, 'Player name bar'),
    ('CMP-CREST','SSSG Team Crest Patch',     'Components',   'component','Summit Socks & Print Supply', 0.85, 0, null, false, 1, 'Iron-on crest'),
    ('CMP-MESH','Mesh Ball Bag (10-ball)',    'Components',   'component','Summit Socks & Print Supply', 4.25, 0, null, false, 1, 'Drawstring mesh'),
    ('CMP-PUMP','Dual-Action Ball Pump',      'Components',   'component','Summit Socks & Print Supply', 3.10, 0, null, false, 1, 'With needles'),
    ('CMP-DRAW','Drawstring Kit Bag',         'Components',   'component','Summit Socks & Print Supply', 2.20, 0, null, false, 1, 'SSSG branded'),
    ('CMP-BOX', 'Game Day Gift Box',          'Components',   'component','Summit Socks & Print Supply', 1.75, 0, null, false, 1, 'Printed box'),
    ('KIT-CJH', 'Custom Home Jersey',         'Jerseys',      'kit', null, 0, 49.99, 2, false, 3, 'Pressed in-house: number, name, crest'),
    ('KIT-CGK', 'Custom GK Jersey',           'Jerseys',      'kit', null, 0, 59.99, 2, false, 3, 'Pressed in-house: number, name, crest'),
    ('KIT-YSK', 'Youth Player Starter Kit',   'Kits & Bundles','kit', null, 0, 49.99, 1, true,  4, 'Ball, shin guards, socks, bag'),
    ('KIT-GKB', 'Goalkeeper Bundle',          'Kits & Bundles','kit', null, 0, 109.99,1, true,  4, 'Pro gloves, GK jersey, socks, bag'),
    ('KIT-TBP', 'Team Ball Pack (10 balls)',  'Kits & Bundles','kit', null, 0, 199.99,1, true,  3, '10 training balls, mesh bag, pump'),
    ('KIT-GDB', 'Game Day Box',               'Kits & Bundles','kit', null, 0, 129.99,1, true,  4, 'FG cleats, shin guards, grip socks, gift box')
  ) as v(sku, name, cat, typ, sup, cost, price, lt, auto, opps, descr);
  update items set barcode = ean13('08500260' || lpad(id::text, 4, '0'));

  insert into bom (parent_id, component_id, qty)
  select (select id from items where sku = p), (select id from items where sku = c), q
  from (values
    ('KIT-CJH','JSY-HOME',1),('KIT-CJH','CMP-NUM',1),('KIT-CJH','CMP-NAME',1),('KIT-CJH','CMP-CREST',1),
    ('KIT-CGK','JSY-GK',1),  ('KIT-CGK','CMP-NUM',1),('KIT-CGK','CMP-NAME',1),('KIT-CGK','CMP-CREST',1),
    ('KIT-YSK','BAL-YTH4',1),('KIT-YSK','SHN-YTH',1),('KIT-YSK','SCK-WHT',1),('KIT-YSK','CMP-DRAW',1),
    ('KIT-GKB','GLV-PRO',1), ('KIT-GKB','JSY-GK',1), ('KIT-GKB','SCK-BLK',1),('KIT-GKB','CMP-DRAW',1),
    ('KIT-TBP','BAL-TRN5',10),('KIT-TBP','CMP-MESH',1),('KIT-TBP','CMP-PUMP',1),
    ('KIT-GDB','CLT-FG',1),  ('KIT-GDB','SHN-SLIP',1),('KIT-GDB','SCK-GRP',1),('KIT-GDB','CMP-BOX',1)
  ) as b(p, c, q);
  -- standard cost of made items = rolled-up component cost
  update items k set unit_cost = (select sum(b.qty * c.unit_cost) from bom b join items c on c.id = b.component_id where b.parent_id = k.id)
   where k.item_type = 'kit';

  -- ---------------- customers (kept across resets so portal logins stay linked)
  insert into customers (name, kind, contact_name, email, phone, city) values
    ('Provo Premier FC',        'club',       'Daniel Reyes',  'coach@provopremierfc.example.com',  '801-555-0201', 'Provo'),
    ('Orem United SC',          'club',       'Megan Holt',    'megan@oremunited.example.com',      '801-555-0202', 'Orem'),
    ('Utah Valley Strikers',    'club',       'Carlos Mendoza','carlos@uvstrikers.example.com',     '801-555-0203', 'Lindon'),
    ('Wasatch Futsal League',   'league',     'Tyler Brooks',  'tyler@wasatchfutsal.example.com',   '801-555-0204', 'Provo'),
    ('Provo City Youth Soccer', 'rec league', 'Jenna Morris',  'jenna@provoyouthsoccer.example.com','801-555-0205', 'Provo'),
    ('Riverside High School',   'school',     'Paul Jensen',   'pjensen@riversidehs.example.com',   '801-555-0206', 'Springville'),
    ('Canyon View Academy',     'school',     'Lisa Chen',     'lchen@canyonview.example.com',      '801-555-0207', 'Orem'),
    ('Mateo Alvarez',           'individual', 'Mateo Alvarez', 'mateo.alvarez@example.com',         '801-555-0211', 'Provo'),
    ('Emma Clarke',             'individual', 'Emma Clarke',   'emma.clarke@example.com',           '801-555-0212', 'Orem'),
    ('Jacob Nguyen',            'individual', 'Jacob Nguyen',  'jacob.nguyen@example.com',          '801-555-0213', 'Provo'),
    ('Sofia Ramirez',           'individual', 'Sofia Ramirez', 'sofia.ramirez@example.com',         '801-555-0214', 'American Fork'),
    ('Liam Peterson',           'individual', 'Liam Peterson', 'liam.peterson@example.com',         '801-555-0215', 'Springville'),
    ('Ava Thompson',            'individual', 'Ava Thompson',  'ava.thompson@example.com',          '801-555-0216', 'Provo')
  on conflict (email) do update set name = excluded.name, kind = excluded.kind, contact_name = excluded.contact_name,
                                    phone = excluded.phone, city = excluded.city;

  -- ---------------- simulation parameters (temp)
  drop table if exists _si; drop table if exists _ss; drop table if exists _arr; drop table if exists _pay; drop table if exists _ret;
  -- base = average units/day company-wide at season factor 1.0
  create temp table _si (item_id int primary key, base numeric, prof text, maxq int, pack int, store_sale boolean);
  insert into _si
  select i.id, v.base, v.prof, v.maxq, v.pack, v.store_sale from (values
    ('BAL-MTC5',2.0,'general',2,6,true), ('BAL-TRN5',2.6,'general',3,12,true), ('BAL-YTH4',2.2,'camp',2,12,true),
    ('BAL-MIN3',1.5,'camp',2,12,true),   ('GLV-PRO',0.9,'steady',1,6,true),    ('GLV-YTH',1.1,'steady',1,6,true),
    ('JSY-HOME',0.6,'general',2,24,true),('JSY-AWAY',0.5,'general',2,24,true), ('JSY-GK',0.25,'steady',1,12,true),
    ('CLT-FG',1.7,'cleats',1,6,true),    ('CLT-YTH',1.9,'cleats',1,6,true),    ('CLT-TURF',0.8,'steady',1,6,true),
    ('SHN-SLIP',2.4,'cleats',1,12,true), ('SHN-YTH',2.0,'cleats',1,12,true),   ('SHN-PRO',0.5,'general',1,6,true),
    ('SCK-WHT',3.2,'general',3,24,true), ('SCK-BLK',2.8,'general',3,24,true),  ('SCK-GRP',1.3,'steady',2,12,true),
    ('CMP-NUM',0,'team',1,50,false),     ('CMP-NAME',0,'team',1,50,false),     ('CMP-CREST',0,'team',1,50,false),
    ('CMP-MESH',0,'general',1,12,false), ('CMP-PUMP',0,'general',1,12,false),  ('CMP-DRAW',0,'general',1,24,false),
    ('CMP-BOX',0,'general',1,24,false),
    ('KIT-CJH',4.6,'team',1,1,false),    ('KIT-CGK',0.4,'team',1,1,false),
    ('KIT-YSK',0.8,'camp',1,1,true),     ('KIT-GKB',0.22,'steady',1,1,true),   ('KIT-TBP',0.10,'general',1,1,true),
    ('KIT-GDB',0.30,'cleats',1,1,true)
  ) as v(sku, base, prof, maxq, pack, store_sale) join items i on i.sku = v.sku;

  create temp table _ss (supplier_id int primary key, p_ontime numeric, max_late int, p_short numeric, fill_min numeric, p_second numeric);
  insert into _ss select s.id, v.a, v.b, v.c, v.d, v.e from (values
    ('Apex Ball Co.',            0.96,  3, 0.03, 0.92, 0.6),
    ('GripTech Goalkeeping',     0.92,  4, 0.04, 0.90, 0.6),
    ('Pacific Rim Apparel',      0.74,  9, 0.10, 0.85, 0.6),
    ('StrideLine Footwear',      0.86,  6, 0.07, 0.88, 0.5),
    ('ShieldGuard Sports',       0.48, 11, 0.18, 0.80, 0.3),
    ('Summit Socks & Print Supply',0.82,4, 0.75, 0.50, 0.10)
  ) as v(name, a, b, c, d, e) join suppliers s on s.name = v.name;

  create temp table _arr (po_id bigint, po_line_id bigint, arrive date, qty numeric);
  create temp table _pay (po_id bigint primary key, pay_date date);
  create temp table _ret (sale_id bigint, sale_line_id bigint, item_id int, loc int, ret_date date, reason text, exch boolean);

  select id into v_kit_jsy from items where sku = 'KIT-CJH';
  select id into v_kit_gk  from items where sku = 'KIT-CGK';

  -- ---------------- opening balances
  v_ts := _sim_ts(v_start, 7, 7.5);
  for r in select i.id, i.unit_cost, i.item_type, i.lead_time_days from items i where i.item_type <> 'kit' loop
    v_exp := _sim_exp(r.id, v_start + 20);
    v_q := ceil(v_exp * (r.lead_time_days + 40));
    if v_q > 0 then perform _move(r.id, v_whs, v_q, 'opening', r.unit_cost, null, 'opening', null, v_ts, 'Opening balance'); end if;
  end loop;

  -- =================== DAY LOOP ===================
  d := v_start;
  while d < v_end loop
    v_dow := extract(dow from d)::int;
    v_prog := (d - v_start)::numeric / p_days;
    wd := case v_dow when 0 then 0 when 1 then 0.85 when 2 then 0.85 when 3 then 0.9 when 4 then 1.0 when 5 then 1.25 else 1.75 end;

    -- ---- 1. supplier deliveries arrive (any day the warehouse dock is open: Mon-Sat)
    if v_dow <> 0 then
      for r in select po_id, jsonb_agg(jsonb_build_object('po_line_id', po_line_id, 'qty', qty)) as lines
                 from _arr where arrive <= d group by po_id order by po_id loop
        if exists (select 1 from purchase_orders where id = r.po_id and status in ('sent','partial')) then
          perform receive_purchase_order(r.po_id, r.lines, v_whs, _sim_ts(d, 8, 11));
          if not exists (select 1 from _pay where po_id = r.po_id) then
            select due_date into v_arrive from purchase_orders where id = r.po_id;
            insert into _pay values (r.po_id, case when random() < 0.9 then v_arrive - floor(random() * 5)::int
                                                   else v_arrive + 3 + floor(random() * 8)::int end);
          end if;
        end if;
        delete from _arr where po_id = r.po_id and arrive <= d;
      end loop;
      -- nothing more coming on a partial PO? short-close it
      for r in select id from purchase_orders where status = 'partial' and id not in (select po_id from _arr) loop
        perform close_purchase_order(r.id, _sim_ts(d, 16, 17));
      end loop;
    end if;

    -- ---- 2. pay supplier invoices (AP runs weekdays)
    if v_dow between 1 and 5 then
      for r in select p.po_id, v.amount_owed from _pay p join v_po_summary v on v.id = p.po_id
                where p.pay_date <= d and v.amount_owed > 0 loop
        perform pay_purchase_order(r.po_id, r.amount_owed, _sim_ts(d, 9, 12));
      end loop;
      for r in select v.id from v_po_summary v where v.status = 'received' and v.amount_owed = 0 loop
        perform close_purchase_order(r.id, _sim_ts(d, 16, 17));
      end loop;
    end if;

    if v_dow <> 0 then   -- closed Sundays
      -- ---- 3. bundle builds at the warehouse (Mondays) — only when kits are running low
      if v_dow = 1 or d = v_start then
        for r in select s.item_id, s.base, s.prof from _si s join items i on i.id = s.item_id where i.auto_assemble loop
          v_exp := r.base * _sim_season(r.prof, d) * 7;
          select coalesce(sum(qty),0) into v_q from inventory iv join locations l on l.id = iv.location_id
           where iv.item_id = r.item_id and l.kind <> 'qc';
          if v_q < v_exp then
            v_target := ceil(v_exp * 2 - v_q);
            select least(v_target, coalesce(min(floor(_sim_onhand(b.component_id, v_whs) / b.qty)),0)) into v_target
              from bom b where b.parent_id = r.item_id;
            if v_target >= 2 then
              perform create_production_order(r.item_id, v_whs, v_target, d, null, 'Weekly kit build', _sim_ts(d, 7, 7.5));
            end if;
          end if;
        end loop;
      end if;

      -- ---- 4. production: run work orders that are due
      for w in select * from production_orders where status = 'planned' and not auto
                and coalesce(due_date, d) - 2 <= d order by due_date, id loop
        select coalesce(min(floor(_sim_onhand(b.component_id, w.location_id) / b.qty)), 0) into v_can
          from bom b where b.parent_id = w.item_id;
        if v_can >= w.qty_planned then
          v_ts := _sim_ts(d, 8, 10);
          perform start_production(w.id, w.qty_planned, v_ts);
          if w.item_id in (v_kit_jsy, v_kit_gk) then
            v_p_scrap := 0.075 - 0.045 * v_prog;  v_p_rew := 0.05 - 0.025 * v_prog;
            -- special cause: heat press #2 thermostat drift ~11 weeks ago (shows on the p-chart)
            if d between v_end - 80 and v_end - 74 then v_p_scrap := 0.22; v_p_rew := 0.10; end if;
          else
            v_p_scrap := 0.006; v_p_rew := 0.03;
          end if;
          v_scrap := _sim_binom(w.qty_planned, v_p_scrap);
          v_rew   := _sim_binom(w.qty_planned - v_scrap, v_p_rew);
          if w.item_id in (v_kit_jsy, v_kit_gk) then
            v_sr := (array['PR-MISALIGN','PR-MISALIGN','PR-MISALIGN','PR-WRONGNUM','PR-PEEL','PR-PEEL','PR-SCORCH'])[1 + floor(random()*7)::int];
            if d between v_end - 80 and v_end - 74 then v_sr := 'PR-SCORCH'; end if;
            v_rr := (array['RW-REPRESS','RW-REPRESS','RW-RELABEL'])[1 + floor(random()*3)::int];
          else
            v_sr := 'KIT-DMG'; v_rr := 'RW-MISSING';
          end if;
          perform complete_production(w.id, w.qty_planned - v_scrap, v_scrap, v_rew,
                                      case when v_scrap > 0 then v_sr end, case when v_rew > 0 then v_rr end,
                                      v_ts + make_interval(mins => 120 + floor(random() * 300)::int));
          if d between v_end - 80 and v_end - 74 and w.item_id in (v_kit_jsy, v_kit_gk) then
            update production_orders set notes = coalesce(notes || ' | ', '') || 'Heat press #2 temperature drift' where id = w.id;
          end if;
          if v_scrap > 0 and w.so_id is not null then
            perform create_production_order(w.item_id, w.location_id, v_scrap, d + 1, w.so_id,
                                            'Replacement for scrap on WO-' || w.id, v_ts);
          end if;
        end if;
      end loop;

      -- ---- 5. store replenishment from the warehouse (Mon & Thu mornings)
      if v_dow in (1, 4) or d = v_start then
        for st in select * from (values (v_prv, 0.58), (v_orm, 0.42)) t(loc, share) loop
          for r in select s.item_id, s.base, s.prof, s.store_sale from _si s join items i on i.id = s.item_id loop
            if r.store_sale then
              v_target := ceil(r.base * _sim_season(r.prof, d) * st.share * 8) + 1;
            else  -- bundle components kept at stores for kitting at the counter
              select coalesce(sum(s2.base * _sim_season(s2.prof, d) * st.share * b.qty * 3), 0) into v_target
                from bom b join _si s2 on s2.item_id = b.parent_id join items k on k.id = b.parent_id
               where b.component_id = r.item_id and k.auto_assemble;
              v_target := ceil(v_target);
            end if;
            v_q := least(v_target - _sim_onhand(r.item_id, st.loc), _sim_onhand(r.item_id, v_whs));
            if v_q >= 1 then
              perform transfer_inventory(r.item_id, v_whs, st.loc, v_q, 'Store replenishment', _sim_ts(d, 7, 8));
            end if;
          end loop;
        end loop;
      end if;

      -- ---- 6. walk-in store sales
      for st in select * from (values (v_prv, 0.58), (v_orm, 0.42)) t(loc, share) loop
        v_arr := '[]'::jsonb;
        for s in select * from _si where store_sale loop
          n := _sim_poisson(s.base * _sim_season(s.prof, d) * wd * st.share);
          for k in 1..n loop
            v_q := case when s.maxq > 1 then 1 + floor(random() * random() * s.maxq) else 1 end;
            v_arr := v_arr || jsonb_build_object('item_id', s.item_id, 'qty', v_q);
          end loop;
        end loop;
        select coalesce(jsonb_agg(x order by random()), '[]'::jsonb) into v_arr from jsonb_array_elements(v_arr) x;
        i := 0;
        while i < jsonb_array_length(v_arr) loop
          v_size := case when random() < 0.55 then 1 when random() < 0.67 then 2 else 3 end;
          v_lines := '[]'::jsonb;
          for e in select x from jsonb_array_elements(v_arr) with ordinality t(x, o) where o > i and o <= i + v_size loop
            if v_lines @> jsonb_build_array(jsonb_build_object('item_id', (e->>'item_id')::int)) then continue; end if;
            v_q := _sim_can_sell((e->>'item_id')::int, st.loc, (e->>'qty')::numeric);
            if v_q > 0 then
              v_lines := v_lines || jsonb_build_object('item_id', (e->>'item_id')::int, 'qty', v_q,
                         'discount_pct', case when random() < 0.06 then 15 else 0 end);
            end if;
          end loop;
          i := i + v_size;
          if jsonb_array_length(v_lines) > 0 then
            v_cust := case when random() < 0.18 then (select id from customers where kind = 'individual' order by random() limit 1) end;
            v_disc := case when random() < 0.05 then 10 else 0 end;
            v_id := post_sale(st.loc, v_cust, v_lines, v_disc, case when random() < 0.8 then 'card' else 'cash' end,
                              'POS', null, _sim_ts(d, 10, 19.5));
            -- some of these will come back
            for r in select l.id, l.item_id, i2.category from sale_lines l join items i2 on i2.id = l.item_id where l.sale_id = v_id loop
              if random() < (case r.category when 'Cleats' then 0.06 when 'Goalie Gloves' then 0.05
                                            when 'Shin Guards' then 0.05 else 0.02 end) then
                if random() < 0.40 then
                  v_reason := case r.category when 'Soccer Balls' then 'Q-AIR' when 'Goalie Gloves' then 'Q-SEAM'
                                when 'Cleats' then 'Q-SOLE' when 'Jerseys' then 'Q-PRINT' when 'Shin Guards' then 'Q-STRAP'
                                else 'Q-SEAM' end;
                elsif r.category in ('Cleats','Goalie Gloves','Shin Guards','Jerseys','Soccer Socks') and random() < 0.75 then
                  v_reason := 'WRONG-SIZE';
                else
                  v_reason := 'CHANGED-MIND';
                end if;
                insert into _ret values (v_id, r.id, r.item_id, st.loc, d + 1 + floor(random() * 20)::int, v_reason,
                                         v_reason = 'WRONG-SIZE' or (v_reason like 'Q-%' and random() < 0.4));
              end if;
            end loop;
          end if;
        end loop;
      end loop;

      -- ---- 7. new customer orders
      -- custom team jersey orders (made to order in the print shop)
      if random() < 0.27 * _sim_season('team', d) * (case when v_dow = 6 then 0.5 else 1 end) then
        v_cust := (select id from customers where kind in ('club','school','league','rec league') order by random() limit 1);
        v_lines := jsonb_build_array(jsonb_build_object('item_id', v_kit_jsy, 'qty', 12 + floor(random() * 11)),
                                     jsonb_build_object('item_id', v_kit_gk,  'qty', 1 + floor(random() * 2)));
        if random() < 0.4 then
          v_lines := v_lines || jsonb_build_object('item_id', (select id from items where sku = 'SCK-WHT'), 'qty', 14);
        end if;
        perform create_sales_order(v_cust, case when random() < 0.6 then v_whs when random() < 0.5 then v_prv else v_orm end,
                                   d + 7 + floor(random() * 6)::int, v_lines, 'Team uniform order', 'staff', _sim_ts(d, 10, 17));
      end if;
      -- team equipment orders
      if random() < 0.10 * _sim_season('general', d) then
        v_cust := (select id from customers where kind in ('club','school','league','rec league') order by random() limit 1);
        v_lines := case floor(random() * 3)::int
          when 0 then jsonb_build_array(jsonb_build_object('item_id', (select id from items where sku = 'KIT-TBP'), 'qty', 1 + floor(random() * 2)))
          when 1 then jsonb_build_array(jsonb_build_object('item_id', (select id from items where sku = 'BAL-TRN5'), 'qty', 12),
                                        jsonb_build_object('item_id', (select id from items where sku = 'SCK-BLK'), 'qty', 18))
          else jsonb_build_array(jsonb_build_object('item_id', (select id from items where sku = 'KIT-YSK'), 'qty', 6 + floor(random() * 10))) end;
        perform create_sales_order(v_cust, v_whs, d + 3 + floor(random() * 7)::int, v_lines, 'Team equipment order', 'staff', _sim_ts(d, 10, 17));
      end if;
      -- online pickup orders from individual customers
      if random() < 0.25 then
        v_cust := (select id from customers where kind = 'individual' order by random() limit 1);
        v_lines := jsonb_build_array(jsonb_build_object('item_id',
                     (select item_id from _si where store_sale and base >= 0.8 order by random() limit 1), 'qty', 1));
        perform create_sales_order(v_cust, case when random() < 0.6 then v_prv else v_orm end,
                                   d + 1 + floor(random() * 3)::int, v_lines, 'Online pickup order', 'portal', _sim_ts(d, 8, 21));
      end if;

      -- ---- 8. fulfil orders that are due and in stock; close picked-up orders
      for r in select so.id, so.location_id, so.requested_date from sales_orders so
                where so.status = 'placed' and so.requested_date <= d order by so.requested_date, so.id loop
        select bool_and(_sim_can_sell(l.item_id, r.location_id, l.qty - l.qty_fulfilled) >= l.qty - l.qty_fulfilled
                        and (it.auto_assemble or it.item_type <> 'kit' or _sim_onhand(l.item_id, r.location_id) >= l.qty - l.qty_fulfilled))
          into v_late
          from so_lines l join items it on it.id = l.item_id where l.so_id = r.id;
        if v_late then
          perform fulfill_sales_order(r.id, _sim_ts(d, 14, 18));
        elsif d > r.requested_date + 14 then
          perform cancel_sales_order(r.id, _sim_ts(d, 17, 18));
        end if;
      end loop;
      for r in select id from sales_orders where status = 'fulfilled' and local_date(fulfilled_at) <= d - 2 loop
        perform close_sales_order(r.id, _sim_ts(d, 11, 19));
      end loop;

      -- ---- 9. returns and exchanges
      for r in select * from _ret where ret_date = d loop
        v_newlines := null;
        if r.exch and _sim_onhand(r.item_id, r.loc) >= 1 then
          v_newlines := jsonb_build_array(jsonb_build_object('item_id', r.item_id, 'qty', 1));
        end if;
        perform process_return(r.sale_id, jsonb_build_array(jsonb_build_object('sale_line_id', r.sale_line_id, 'qty', 1)),
                               r.reason, r.loc, v_newlines,
                               case when v_newlines is not null then 'Exchanged for new unit' end, _sim_ts(d, 10, 19));
      end loop;

      -- ---- 10. cycle counts (Wednesdays) and occasional damage
      if v_dow = 3 then
        for st in select * from (values (v_prv), (v_orm), (v_whs)) t(loc) loop
          for r in select iv.item_id, iv.qty from inventory iv where iv.location_id = st.loc and iv.qty > 2 order by random() limit 4 loop
            v_q := case when random() < 0.72 then 0 when random() < 0.65 then -1 when random() < 0.7 then -2 else 1 end;
            perform cycle_count(r.item_id, st.loc, r.qty + v_q, null, _sim_ts(d, 7, 9));
          end loop;
        end loop;
      end if;
      if random() < 0.05 then
        select iv.item_id, iv.location_id into r from inventory iv join locations l on l.id = iv.location_id
         where l.kind in ('store','warehouse') and iv.qty >= 2 order by random() limit 1;
        perform adjust_inventory(r.item_id, r.location_id, -1, 'DMG', 'Damaged on display / in handling', _sim_ts(d, 10, 19));
      end if;

      -- ---- 11. QC Hold disposition (Fridays): failed units scrapped
      if v_dow = 5 and d < v_end - 10 then
        for r in select item_id, qty from inventory where location_id = v_qch and qty > 0 loop
          perform adjust_inventory(r.item_id, v_qch, -r.qty, 'QC-SCRAP', 'Failed inspection - scrapped', _sim_ts(d, 15, 16));
        end loop;
      end if;

      -- ---- 12. purchasing review (Mondays): reorder-point logic with seasonal look-ahead
      if v_dow = 1 or d = v_start then
        for sp in select s.*, ss.* from suppliers s join _ss ss on ss.supplier_id = s.id loop
          v_lines := '[]'::jsonb;
          for r in select i.id, i.lead_time_days, i.unit_cost, si.pack from items i join _si si on si.item_id = i.id
                    where i.supplier_id = sp.id loop
            v_lt := r.lead_time_days;
            v_exp := _sim_exp(r.id, d + v_lt / 2 + 7);
            select coalesce(sum(iv.qty),0) into v_ip from inventory iv join locations l on l.id = iv.location_id
             where iv.item_id = r.id and l.kind <> 'qc';
            v_ip := v_ip + coalesce((select sum(pl.qty_ordered - pl.qty_received) from po_lines pl
                                      join purchase_orders po on po.id = pl.po_id
                                     where pl.item_id = r.id and po.status in ('sent','partial')), 0);
            v_s   := v_exp * (v_lt + 12) * 1.4;
            v_big := v_s + v_exp * 40;
            if v_ip < v_s then
              v_q := ceil((v_big - v_ip) / r.pack) * r.pack;
              v_lines := v_lines || jsonb_build_object('item_id', r.id, 'qty', v_q, 'unit_cost',
                           round(r.unit_cost * (0.97 + random() * 0.06)::numeric, 2));
            end if;
          end loop;
          if jsonb_array_length(v_lines) > 0 then
            v_id := create_purchase_order(sp.id, v_whs, v_lines, true, null, _sim_ts(d, 15, 17));
            v_late := random() > sp.p_ontime;
            v_arrive := d + sp.lead_time_days + case when v_late then 1 + floor(random() * sp.max_late)::int
                                                     else -floor(random() * 3)::int end;
            for r in select id, qty_ordered from po_lines where po_id = v_id loop
              if random() < sp.p_short then
                v_q1 := greatest(1, floor(r.qty_ordered * (sp.fill_min + random() * (1 - sp.fill_min))));
              else
                v_q1 := r.qty_ordered;
              end if;
              v_rest := r.qty_ordered - v_q1;
              insert into _arr values (v_id, r.id, v_arrive, v_q1);
              if v_rest > 0 and random() < sp.p_second then
                insert into _arr values (v_id, r.id, v_arrive + 5 + floor(random() * 6)::int, v_rest);
              end if;
            end loop;
          end if;
        end loop;
      end if;
    end if;

    d := d + 1;
  end loop;

  -- =================== THIS MORNING: restock the stores before opening ===================
  for st in select * from (values (v_prv, 0.58), (v_orm, 0.42)) t(loc, share) loop
    for r in select s.item_id, s.base, s.prof, s.store_sale from _si s loop
      if r.store_sale then
        v_target := ceil(r.base * greatest(_sim_season(r.prof, v_end), 1) * st.share * 12) + 2;
      else
        select coalesce(sum(s2.base * st.share * b.qty * 4), 0) into v_target
          from bom b join _si s2 on s2.item_id = b.parent_id join items k on k.id = b.parent_id
         where b.component_id = r.item_id and k.auto_assemble;
        v_target := ceil(v_target) + 2;
      end if;
      v_q := least(v_target - _sim_onhand(r.item_id, st.loc), floor(_sim_onhand(r.item_id, v_whs) * 0.6));
      if v_q >= 1 then
        perform transfer_inventory(r.item_id, v_whs, st.loc, v_q, 'Store replenishment', least(_sim_ts(v_end, 7, 7.5), now() - interval '5 minutes'));
      end if;
    end loop;
  end loop;

  -- =================== OPEN ORDERS FOR THE NEXT 4 WEEKS (drive MRP) ===================
  v_ts := now() - interval '3 hours';
  perform create_sales_order((select id from customers where name = 'Provo Premier FC'), v_whs, v_end + 10,
    jsonb_build_array(jsonb_build_object('item_id', v_kit_jsy, 'qty', 22), jsonb_build_object('item_id', v_kit_gk, 'qty', 3)),
    'Winter indoor season uniforms', 'staff', v_ts);
  perform create_sales_order((select id from customers where name = 'Utah Valley Strikers'), v_prv, v_end + 18,
    jsonb_build_array(jsonb_build_object('item_id', v_kit_jsy, 'qty', 18), jsonb_build_object('item_id', v_kit_gk, 'qty', 2),
                      jsonb_build_object('item_id', (select id from items where sku='SCK-WHT'), 'qty', 20)),
    'U14 tournament kits', 'staff', v_ts);
  perform create_sales_order((select id from customers where name = 'Provo City Youth Soccer'), v_whs, v_end + 21,
    jsonb_build_array(jsonb_build_object('item_id', (select id from items where sku='KIT-YSK'), 'qty', 80)),
    'Spring registration giveaway kits', 'staff', v_ts);
  perform create_sales_order((select id from customers where name = 'Orem United SC'), v_orm, v_end + 12,
    jsonb_build_array(jsonb_build_object('item_id', (select id from items where sku='KIT-TBP'), 'qty', 5)),
    'Club ball packs', 'staff', v_ts);
  perform create_sales_order((select id from customers where name = 'Wasatch Futsal League'), v_whs, v_end + 25,
    jsonb_build_array(jsonb_build_object('item_id', (select id from items where sku='KIT-GDB'), 'qty', 14),
                      jsonb_build_object('item_id', (select id from items where sku='CLT-TURF'), 'qty', 12)),
    'League MVP prizes + referee shoes', 'staff', v_ts);
  perform create_sales_order((select id from customers where name = 'Riverside High School'), v_prv, v_end + 6,
    jsonb_build_array(jsonb_build_object('item_id', (select id from items where sku='KIT-GKB'), 'qty', 8),
                      jsonb_build_object('item_id', (select id from items where sku='SHN-PRO'), 'qty', 10)),
    'Varsity goalkeeper gear', 'staff', v_ts);

  perform create_sales_order((select id from customers where name = 'Canyon View Academy'), v_orm, v_end + 26,
    jsonb_build_array(jsonb_build_object('item_id', v_kit_jsy, 'qty', 30), jsonb_build_object('item_id', v_kit_gk, 'qty', 8)),
    'Spring season uniforms', 'staff', v_ts);

  -- periodic review history: some items reviewed recently, some overdue
  update items set last_reviewed_at = now() - make_interval(days => floor(random() * 26)::int) where item_type <> 'kit';

  drop table if exists _si; drop table if exists _ss; drop table if exists _arr; drop table if exists _pay; drop table if exists _ret;

  select count(*) into v_cnt from sales;
  return format('SSSG demo data generated: %s sales, %s purchase orders, %s work orders, %s returns, %s sales orders (%s to %s)',
    v_cnt, (select count(*) from purchase_orders), (select count(*) from production_orders),
    (select count(*) from returns), (select count(*) from sales_orders), v_start, v_end - 1);
end $$;

revoke execute on function seed_demo(int) from public, anon;
grant execute on function seed_demo(int) to authenticated;

-- generate it now
select seed_demo();
