# SSSG ERP — Six Sigma Soccer Goods

A working mini-ERP for a fictional soccer retailer: 2 stores (Provo, Orem) plus a warehouse with an in-house print shop.
**Stack:** Supabase (Postgres, Auth, Realtime) + plain HTML/JS hosted on GitHub Pages. Built with Claude Code.

## Setup (about 15 minutes)

### 1. Supabase
1. Create a free project at https://supabase.com. Remember the database password.
2. **Turn off email confirmation** so sign-ups work instantly: *Authentication → Sign In / Providers → Email → uncheck "Confirm email" → Save*.
3. Open **SQL Editor → New query**, paste all of `supabase/SETUP_ALL.sql`, and click **Run**.
   It builds every table and function, then generates 6 months of history ending today. The last line prints a summary like
   `SSSG demo data generated: 3,9xx sales, ...`.
4. Go to **Project Settings → API Keys** and copy the **Project URL** and the **publishable key** (`sb_publishable_…`).
   The legacy **anon public** key also works. Never use the secret / service_role key in the app.

### 2. Connect the app
Open `js/config.js` and paste in the two values:
```js
SUPABASE_URL: 'https://abcd1234.supabase.co',
SUPABASE_ANON_KEY: 'sb_publishable_xxxxxxxx',
```

### 3. Publish on GitHub Pages
1. Create a **public** repository (e.g. `sssg-erp`) and upload every file in this folder, keeping the folders.
2. *Settings → Pages → Source: Deploy from a branch → `main` / root → Save*.
3. After 1–2 minutes the app is live at `https://YOUR-USERNAME.github.io/sssg-erp/`.

### 4. Create logins (on the live site → Create account)
| Who | Account type | Staff code |
|---|---|---|
| Each teammate | SSSG manager (or employee) | `SSSG2026` |
| Demo customer | Customer | — use `coach@provopremierfc.example.com` to log in as Provo Premier FC and see their orders |

Change the staff code with `update app_secrets set value = 'NEWCODE' where key = 'staff_code';` in the SQL Editor.
If Supabase rejects an `example.com` address, sign up with any real email: the portal creates a new customer record for it automatically.

## Reset before the demo
**Settings & Users → Reset demo data** (manager only), or run `select seed_demo();` in the SQL Editor.
History always ends *today*, so reset on demo morning.

## Files
```
index.html               app entry
css/styles.css           styles
js/config.js             ← your Supabase URL + key
js/app.js                login, navigation, live multi-user updates
js/lib.js                shared helpers (data, formatting, barcode scanning, charts)
js/pages/*.js            one file per screen
supabase/01_schema.sql   tables, business logic (SQL functions), reports, security
supabase/02_seed.sql     master data + 6-month history generator (seed_demo)
supabase/SETUP_ALL.sql   01 + 02 combined (paste this one)
DEMO_GUIDE.md            what to show, who shows it, and likely questions
```

## Testing checklist (do this on 2+ laptops and a phone)
- [ ] Two people logged in: a sale on laptop A updates inventory on laptop B (green "Live" dot, bottom-left)
- [ ] Print labels (Barcode Labels page), then scan them with a USB scanner and with a phone camera in POS
- [ ] Every page loads without a red error card
