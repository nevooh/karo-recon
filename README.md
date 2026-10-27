# Karo Recon — project guide (backend + everything a new chat needs)

_Last updated: 2026-10-22. This file replaces every older README. Screens are described in `frontend/frontend-README.md`._

## 0. Read this first: how to work with the owner
- **Plain, simple words.** The owner is learning backend while building and gets lost in long explanations. Short answers. Explain a command or a word lightly, tied to what we are doing.
- **One piece at a time.** Before each step say: **what is done / where we are / where we are going.** Do not jump between backend and frontend in one go.
- **Windows laptop, CMD, local Postgres.** No "sign up" wording: say **"school setup"**. Schools never set themselves up. The owner (and his agents) do it from the terminal now, and from the owner's own admin side (operator dashboard, not built yet) later.
- **No pile of zip files.** Give changes as files that go into the project folders, always saying the exact folder. Give ONE full zip only when asked.
- **Always test before handing over** (real Postgres in the sandbox, simulated browser for screens) and be honest about weak or failed checks. Add suggestions from your own research.
- The owner is on the free plan and long chats get slow: keep replies short, avoid giant outputs.
- **Never put real secrets in a zip.** The owner's own `.env` holds real keys. The zip you make must not contain it.

## 1. What this is
Karo Recon receives school-fee payments (M-Pesa Paybill, KCB, Equity, Co-op Bank), works out **which student each payment is for** (by admission number), and keeps each student's fee balance. Anything unclear goes to a **review queue** for a person. Many schools (multi-tenant): every school sees only its own data. Target users: **high schools** (admission numbers are standard; primary schools need market research first).

## 2. Status at a glance (2026-10-18)
| Area | State |
|---|---|
| Receiving payments from the 4 channels | Built and tested against each bank's own sample messages. **Not proven with a real bank message yet.** |
| Matcher (admission number only) | Done |
| Review queue (confirm / reject / find the student for an unmatched payment) | Done |
| Login, roles (Admin / staff), login lock, audit log, safe credential reset | Done |
| Channel switches per school (School settings) | Done |
| Bank setup screens: Equity, Co-op, KCB, M-Pesa checklist | Done (frontend + backend) |
| M-Pesa per-school secret code + registration with Safaricom | Done |
| School setup from the terminal (`create-school`) | Done |
| One email = one account, case-insensitive login | Done |
| Terms / academic years setup from the terminal (`set-terms`) | Done (2026-10-19). Payments reach balances once a term has started. |
| **Student setup from the terminal (CSV import)** | **NOT BUILT** (owner wants it terminal-first). Only `POST /api/schools/:id/students` (needs login) and the dev seed exist. |
| **Fee structure (reusable template per class and term 1/2/3, versioned, no year)** | **Done (backend, 2026-10-22)**: `set-fees.js`, `routes/fees.js`, `services/feeSetup.js`. Screens still to be rebuilt (see `frontend/frontend-README.md`) |
| **Automatic once-only billing** (locks the latest fees for a term, charges students) | **Done (backend, 2026-10-22)**: `services/termBilling.js`, runs at server start and every hour. Tested on real Postgres (`test-fee-billing.js`) |
| Request-letter helper buttons, TEST/LIVE ribbon, schools-status report, change-password screen | Planned (section 17) |
| Statement pull / safety-net check | Parked on purpose (build after the first schools exist) |
| Hosting / going live | Not done (section 16) |
| Owner's operator dashboard (all schools, resets with the school's permission) | Not built, owner will build it later |

## 3. Check that your folder is up to date (do this first in a new chat)
Run each (no database needed) and compare:
```
node src/scripts/test-matcher.js         38 pass
node src/scripts/test-kcb.js             28 pass
node src/scripts/test-equity.js          24 pass
node src/scripts/test-equity-setup.js    19 pass
node src/scripts/test-coop.js            43 pass
node src/scripts/test-mpesa.js           37 pass
node src/scripts/test-mpesa-setup.js     72 pass
node src/scripts/test-school-setup.js    37 pass
node src/scripts/test-terms.js           50 pass      (needs a real *_test Postgres database; it is WIPED. The old stubbed test-term-setup.js is gone)
```
Also: `test-class-setup.js` (144), `test-promotion.js` (86), `test-student-admission.js` (92, offline, fee rules) and **`test-fee-billing.js` (69 checks, needs a REAL Postgres: `set TEST_DATABASE_URL=postgres://user:pass@localhost:5432/karo_test`, the database name must end in `_test` because it is WIPED)**. `test-review.js` needs a real database login too. `test-fee-setup.js` (old per-year model) was deleted.
```
Key files that must exist: `src/services/schoolSetup.js`, `termSetup.js`, `src/scripts/set-terms.js`, `mpesaSetup.js`, `mpesaUrlToken.js`, `credentialGuard.js`, `lock.js`, `audit.js`, `channels.js`, `src/scripts/create-school.js`, `frontend/js/page-bank-setup-mpesa.js`. If a count differs or a file is missing, an earlier delivery was not pasted: fix that before anything else. (Older notes said 80 for `test-mpesa-setup.js`; the real file gives 72 and all pass, so 72 is the number now.)
(`test-local.js` and `test-setup.js` are old manual helpers that need the server and `ENABLE_DEV_ROUTES=true`. `setup.sh` is OUTDATED and is for Linux: ignore it.)

## 4. How a payment travels
```
Bank/M-Pesa --(message to our address)--> routes/webhooks.js
   -> check it is really from the bank (secret address, signature, or login)
   -> connector reads that bank's format (credits only)
   -> services/ingest.js: find school, drop duplicates, run matcher, save, update ledger
   -> screens read it through the staff API (login required)
```
Statuses: `auto_matched` (applied to a balance), `needs_review` and `unmatched` (waiting for a person), `confirmed` (person approved, applied), `rejected`. A payment is applied to the ledger only when `auto_matched` or `confirmed`. Confirm/reject work only on `needs_review` / `unmatched` (409 otherwise), in one database transaction with a row lock.

## 5. The matcher (`src/matching/matcher.js`) — decided by the owner
**Admission number only. No names, no phone, no amounts, no percentages.** Matched is matched, otherwise not.
- Only the **number part** is compared, so `ADM343`, `343`, `adm/343`, `Adm 343 fees`, `ADM0343` all find a student saved as `343` or `ADM343`. Letters in front are ignored. Whole numbers only (`ADM1010` never matches `ADM101`).
- Exactly one student found → `auto_matched`. Two or more → `needs_review` with candidates. None → `unmatched`.
- 1–2 digit numbers count only when they are the whole reference ("term 2 fees" must not catch student 2).
- A number equal to the **amount paid** (reference `5000`, 5000 paid) goes to review.
- Long formats like `CM/M/1234/01/17` work as a whole run. Two students with the same number (`ADM343` and `KAB343`) → review.
- `ingest.js` hands the matcher only the reference and the amount. Payer name/phone are still saved with the payment but never used to match.
- Not done by design: per-bank matchers (later each bank may get its own), school-code stripping (Co-op `1059#343` and NBK `SCH26065343` formats) until real messages are seen.

## 6. Security model
- **Login**: bcrypt passwords. **5 wrong passwords lock that email for 15 minutes** (also for emails that do not exist, so nobody learns which are real). Login ignores capitals in the email.
- **One email = one account in the whole system** (database index `uniq_staff_email_ci`), because login finds a person by email alone. Each Admin needs their own email.
- **Roles**: `admin` (settings, bank setup, resets, add staff) and `staff` (works payments: review, confirm, reject). Read from the database on every request, so removing Admin takes effect at once. Old accounts became admin at upgrade; new "add staff" accounts default to `staff`.
- **Dangerous actions** (replace bank credentials, reset a login, change a bank account number, replace M-Pesa keys, register M-Pesa) need: Admin + type **RESET or the school's exact name** + **your own password** (5 wrong = 15-minute lock, separate counter) + for bank credential resets a **10-minute wait** between resets (one atomic claim, so three clicks at once = one wins) + an **audit entry**. Enforced by the **server** (`services/credentialGuard.js`), not only the screen.
- **One bank account number = one school** (KCB, Co-op; database index `uniq_bank_account_per_provider`; M-Pesa Paybill is unique in `schools`). Otherwise school B could claim school A's number and make A's payments be dropped.
- **Stored secrets**: Daraja keys and each school's M-Pesa secret code are encrypted (AES-256-GCM, key `ENCRYPTION_KEY`). Equity/Co-op passwords are never stored, only a SHA-256 fingerprint, shown once. Staff passwords are scrambled (bcrypt). Keys are **never** returned by any API; the screens show only "set / not set" or a masked preview.
- **Audit log** (`audit_log` table; no screen yet). Logged: login, login_locked, staff_invited, invite_resent, staff_joined, password_reset_requested / sent / done, password_changed, staff_role_changed, staff_name_changed, staff_suspended, staff_reactivated, staff_email_change_requested, staff_email_changed, ownership_transferred, credentials_created / rotated / wrong password, channels_changed, mpesa_keys_saved / replaced / checked, mpesa_urls_registered, mpesa_registration_failed, school_created, terms_set (term dates changed). Never any password, key or secret code.
- Staff doors need a login and are locked to the school in the token. Dev doors `/api/dev/*` are off unless `ENABLE_DEV_ROUTES=true` and never work in production. Plain `/webhooks/mpesa/...` paths are closed in production.

## 7. Settings (`.env`) — the server reads it ONCE at start; after editing, stop and start again
`.env` is a file named `.env` (starts with a dot, so programs may hide it). Start from `.env.example`. **The code reads exactly these 11 settings** (the old M-Pesa/Jenga lines in the old template were dead and are gone):
| Setting | Meaning |
|---|---|
| `DATABASE_URL` | Postgres address (special characters in the password must be URL-encoded) |
| `JWT_SECRET` | signs logins. Changing it logs everyone out. Server refuses to start without it |
| `ENCRYPTION_KEY` | exactly 64 hex characters; locks every stored bank key. **Back it up away from database backups. Lost = every stored key unreadable** |
| `PORT` | default 3000 |
| `PUBLIC_BASE_URL` | our public https address (no slash at the end). All bank addresses are built from it. Nothing can be registered without it |
| `MPESA_ENV` | `sandbox` (practice) or `production` (LIVE). **One setting for the whole server, not per school** |
| `NODE_ENV` | `production` on the real server (missing KCB key then refuses KCB payments; dev routes can never run) |
| `KCB_IPN_PUBLIC_KEY` | KCB's public key as one line. Empty = test mode (KCB signatures NOT checked) |
| `C2B_URL_SECRET` | optional; only for a school registered the OLD way (before per-school codes). Set once, never change |
| `MPESA_C2B_VERSION` | empty = `v2`; `v1` only if Safaricom says so |
| `ENABLE_DEV_ROUTES` | local testing only |
**Not in `.env`:** a school's own bank keys (Daraja Consumer Key/Secret, KCB account, Equity/Co-op logins). The school's Admin types them into the screens; they live in Postgres, encrypted, one row per school, so schools never share them. Test and live keys are saved in the same place (replacing overwrites), so **keep a separate practice server with its own database, and a separate real one. Never mix.**
Make a secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (run twice, different values).

## 8. Run it locally (Windows CMD)
```
copy .env.example .env      (then fill it in)
npm install
npm start                   (or npm run dev)
```
Open http://localhost:3000 . Postgres must be running first (tables are built automatically at start, safe to run again). The server needs both secrets or it exits.

## 9. Terminal tools (the operator does these today; the future dashboard will use the same engines)
All run from the project folder and need `.env` (the server need not be running).
| Command | What it does |
|---|---|
| `node src/scripts/create-school.js "School name" "Admin full name" admin@email --channels mpesa,equity [--password "..."] [--dry]` | Makes the school **and its first Admin together** (all or nothing, one creation at a time). Generates a 16-character password shown **once** (no look-alike characters). `--dry` creates nothing. Refuses a repeated school name or an email already used anywhere. Engine: `services/schoolSetup.js` |
| `node src/scripts/create-admin.js <schoolId> "Full Name" email password` | Lost password, or add another Admin to an existing school. Refuses an email that belongs to another school |
| `node src/scripts/register-urls.js <schoolId> https://address [--dry] [--force]` | M-Pesa registration from the terminal (same rules as the screen). `--dry` shows a masked preview and sends nothing. `--force` only in production, only if Safaricom already deleted the old addresses |
| `node src/scripts/set-terms.js show <school>` | Lists that school's terms: dates, status (coming / RUNNING / ended), fees charged yes/no, and which term payments go to today |
| `node src/scripts/set-terms.js <year> <term 1-3> <start> <end> [--dry]` | Sets ONE term's dates, dates written `2026-08-31`. Makes the year and its 3 terms the first time. Terms are shared by all schools. Rules: real dates inside the year, term 14-180 days, terms in order and never overlapping, a term that already started keeps its start date (end can move), one change at a time, audit entry. `--dry` changes nothing. Engine: `services/termSetup.js` |
| `node src/scripts/set-fees.js "<school>" ...` | The fee structure: `optional add/remove/list`, `set "<class>" 1,2,3 --fee "Tuition=50000" --optional "Lunch=3000" [--new]`, `copy "<class>" <term> --to-classes ... --to-terms ...`, `price "<optional fee>" "<classes>" <terms> <amount\|none>`, `show ["<class>"]`. Every save = a new version. `--dry` changes nothing. Engine: `services/feeSetup.js` |
| `node src/scripts/charge-term.js "<school>" [--dry]` | Normally NOT needed: billing is automatic. Shows or runs billing for one school now (same engine and same once-only protection) |
| `node src/scripts/simulate-payment.js ...` | Sends a test payment locally |
Agents never get the `.env`. For now agents send the owner: school name, Admin's full name, Admin's own email, which banks. The owner runs the command.

## 10. School setup today, step by step (and what is missing)
1. **Terms must exist, per school** (every school has its OWN calendar in `school_term_dates`; the year and the 3 term slots are shared but hold no dates; school admins set theirs on the Academic years & terms page, `set-terms.js <school> <year> <term> <start> <end>` is the operator's way in). Lock rules: before a term starts both dates change freely; once running only the end date can move; once ended nothing changes (also enforced by a database trigger). A start date of today or earlier needs a clear yes (`--confirm-started` / the page's confirm box) and bills at once with the same once-only billing. A class with fees but no active students is not locked; the first admission locks it. ✓ section 9. ✓ `set-terms.js` (section 9). The "current term" is worked out from DATES only: the term whose start date passed most recently (`feeLedger.getCurrentTerm`). A term with no start date is never current, and with no current term a payment is saved but not added to any balance. Set the running term first, then the others. (`termManagement.js` is old and unused; its date messages show a day early in Kenya's time zone, so do not use it.)
2. `create-school` ✓
3. The Admin logs in, opens **School settings**, switches on the channels the school uses ✓ (or `--channels` did it already).
4. **Students**: MISSING terminal tool (planned: CSV import with dry-run). Existing: `POST /api/schools/:id/students` (login) and the dev seed. Check how a student gets a term ledger row before building.
5. **Classes and fees**: `set-classes.js` switches classes on, `set-fees.js` sets each class's fees per term number (1/2/3). Nothing else to do: **billing is automatic** (below).
6. Bank setup on **Bank connections** ✓ (section 11).
7. Test each channel with about KES 50 and an admission number.

### 10a. Academic years and terms (decided by the owner 2026-10-23)
- Terms are NOT shared. Each school has its own calendar (`school_term_dates`: school, term slot, start, end). School admins set their own (page `page-terms.js`, route `src/routes/terms.js`); the operator can use `set-terms.js <school> ...`. Engine: `src/services/termSetup.js`.
- A date locks when it is reached: not started = both dates free; running = start locked, end can move (not before today); ended = fully locked. The database trigger `guard_school_term_dates` backs this up (it guards UPDATE only; the engine never deletes).
- Saving a start date of today or earlier needs a confirmation. The page does a dry run first and shows every class, its students and whether it will be billed; after "Yes" billing runs at once (still once-only).
- All "current term" readers take the school: `feeLedger.getCurrentTerm(schoolId)`, `termBilling.loadCurrentTerm(db, schoolId)`, `studentAdmission.loadStartTerm(db, schoolId)`, promotion checks.
- One-time migration: the old shared dates are copied to every school, then the shared columns are emptied.
- Billing change: a class with no active students is not locked (the first admitted student locks it).

### 10c. Students & balances (step 1 of 4, built 2026-10-23)
- Read-only list for ONE term (the school's current term, or any started term for history): `src/services/balances.js`, route `GET /api/schools/:id/balances` (`src/routes/balanceRoutes.js`), page `frontend/js/page-balances.js` (replaces the old roster in live-screens.js; load it after live-screens.js). Test: `node src/scripts/test-balances.js` (26 checks, real `*_test` Postgres, WIPED).
- Money states: owing / overpaid / cleared / not billed. Tiles and status chips follow the filters. Filters: search, class, stream, active/left; sorts incl. biggest debt first.
- Decided with the owner: any staff member may do the student actions (edit, mark left, add a manual payment) and every one is audited with who did it. Waivers/discounts are NOT in v1 (revisit with a real school). Printable receipts per payment come in step 2 (the student's sheet). Step 3: audited adjustments. Step 4: CSV import (dry run first, same admission engine).

### 10d. The student sheet (step 2 of 4, built 2026-10-24)
- Click a row in Students & balances: side sheet `frontend/js/page-student-sheet.js` (after page-balances.js in index.html). Service `src/services/studentSheet.js`, routes `src/routes/studentSheetRoutes.js`, test `node src/scripts/test-student-sheet.js` (54 checks, real `*_test` Postgres, WIPED).
- Shows this term's billed / paid / balance, the fee breakdown from the LOCKED fees (current term only: earlier terms keep numbers only, because the class may have changed), money by term, every payment, contacts and optional fees chosen.
- ANY staff member can: add a manual payment (cash / cheque / bank slip / other; same ledger path as bank payments, `source = 'manual'`, safe to double-click: one `request_id` = one payment), edit the name and contacts, mark a student as left or bring them back (coming back while the class is already billed charges them for the term). Every action is audited with the staff member (`manual_payment_added`, `student_updated` with before/after, `student_marked_left`, `student_returned`). Nothing deletes a student; the admission number is not editable here (matching depends on it).
- Receipts: `GET /api/schools/:id/payments/:txnId/receipt`; printable (browser print). Receipt number = `RCP-` + payment id. "Balance after" counts payments up to that one by payment date.
- Reversing a wrong MANUAL payment (built 2026-10-24): `POST /api/schools/:id/payments/:txnId/reverse {reason}`; the payment row stays (marked `rejected`, `payment_reversals` row says who/why, one per payment, cannot be edited or deleted), the student's ledger drops by the same amount. Bank/M-Pesa payments cannot be reversed here (Review queue). Only the current or previous term. Audited as `manual_payment_reversed`.
- Fee edits menu item removed (it was demo data). It returns with real per-student fee adjustments (append-only lines added on top of the locked fees; billing's recalculation must include them) after the first school has used the system. Waivers/discounts wait for the same reason.
- File names: the route files are `balanceRoutes.js` and `studentSheetRoutes.js` so they can never be confused with the services of nearly the same name.

### 10c. Students & balances (step 1 of 4, built 2026-10-23)
- Read-only list for ONE term (the school's current term, or any started term for history): `src/services/balances.js`, route `GET /api/schools/:id/balances` (`src/routes/balanceRoutes.js`), page `frontend/js/page-balances.js` (replaces the old roster in live-screens.js; load it after live-screens.js). Test: `node src/scripts/test-balances.js` (26 checks, real `*_test` Postgres, WIPED).
- Money states: owing / overpaid / cleared / not billed. Tiles and status chips follow the filters. Filters: search, class, stream, active/left; sorts incl. biggest debt first.
- Decided with the owner: any staff member may do the student actions (edit, mark left, add a manual payment) and every one is audited with who did it. Waivers/discounts are NOT in v1 (revisit with a real school). Printable receipts per payment come in step 2 (the student's sheet). Step 3: audited adjustments. Step 4: CSV import (dry run first, same admission engine).

### 10e. App frame (2026-10-24)
- `frontend/js/shell.js` (load LAST in index.html): foldable sidebar (choice remembered in localStorage, it folds by itself while a student sheet is open and goes back after), real term badge and real logged-in name in the sidebar (they used to be fixed demo text "Jane Wambui / 2026 Term 2 live"), the dashboard refreshes when opened and once a minute while open. Esc closes the student sheet.
- Student sheet layout (owner's design, 2026-10-24): inside the Students & balances page, clicking a student SPLITS the page. The sheet is the left half (slides in, rounded, sticky); the same students page (tiles, search, filters, table) squeezes into the right half with the money columns hidden (Brought fwd / Charged / Paid). Clicking another row swaps the sheet. No overlay, no dimming. Esc or the close button restores the full-width list. On phones only the sheet shows, with an "All students" back button. The sidebar folds while the sheet is open. Code: `#blSplit` in page-balances.js, `#ssSheet` in page-student-sheet.js.
- Menu groups: Money, Students, Setup (Classes & streams, Academic years & terms, Optional fees, Bank connections), School (Staff, Activity log, Reports, School settings). "Fee edits" is not in the menu.
- Not done on purpose: TEST/LIVE ribbon (only needed once a second, practice server exists; do it with hosting).
- Open question answered 2026-10-24: other pages reload their own data every time they are opened (fees, optional fees, terms, balances, student sheet, payments, review queue); the dashboard now also refreshes itself. The webhooks are covered by the offline bank tests (M-Pesa, KCB, Equity, Co-op) but have NOT been proven with the real banks: they need a public address and each bank's registration.

### 10f. Staff, owner and password links (2026-10-24)
- **Roles**: Owner (one per school; an Admin who can never be demoted, suspended or removed, enforced by a database trigger and a unique index) > Admin > Staff. Admins manage Staff people. Only the Owner adds/promotes/suspends/resets/changes the email of other Admins. Ownership moves only through "Hand over ownership" (owner's password needed; new owner must be an active Admin).
- **Nobody sees a password.** Invite = name + email + role; the person gets an email with a one-time link to choose their own password (48 h). "Send reset link" (1 h) and "Forgot password" on the login screen work the same way. Links: 32 random bytes, only a SHA-256 hash stored (`staff_tokens`), one use, a new link kills the old one, forgot-password stops after 3 mails an hour, and the answer never shows which emails exist.
- **Sign-out**: `staff.token_version` goes up on password change/reset/suspension; login tokens carry it, so older sessions stop working at once. Suspended people keep their name in the activity log; they are never deleted.
- **Email change**: staff can't change their own; the Owner changes anyone's, an Admin changes Staff people's. A confirm link goes to the NEW address first (someone who never joined is fixed at once and re-invited).
- **Email sending** (`services/mailer.js`): set `APP_URL`, `MAIL_PROVIDER` (`resend` or `brevo`), `MAIL_API_KEY`, `MAIL_FROM` in `.env`. Without them nothing is sent: the mail prints in the terminal and (never in production) the Staff page shows the link so you can test locally. Real sending is untested against the providers until hosting (the request shape is unit-tested).
- Tests: `node src/scripts/test-staff.js` (80 checks, real Postgres, `TEST_DATABASE_URL` ending `_test`).
- Not built yet: per-person PIN for sensitive actions (planned with School settings).

### 10g. Activity log (2026-10-25)
- Page `frontend/js/page-activity.js` (after page-staff.js in index.html), service `src/services/activityLog.js`, route `src/routes/activityRoutes.js` (`GET /api/schools/:id/activity`, Admins only), test `node src/scripts/test-activity.js` (36 checks, real `*_test` Postgres, WIPED).
- Reads `audit_log` and writes each line in plain words with names looked up at read time. Newest first, grouped by day (Kenya time), scrolls on. Filters: search (person, student, receipt), person, kind (Money / Students / Fees & terms / Staff & access / Setup / Sign-ins), date (today, 7 days, 30 days, this term, custom, all). Sign-ins hidden until "Show sign-ins"; wrong passwords and lockouts always show.
- `audit_log` can no longer be edited or deleted (trigger `no_change_audit_log`).
- New log lines: `payment_confirmed`, `payment_rejected` (Review queue), `login_failed` (real accounts only, never for emails that do not exist).
- Every action the code writes must have a group in `GROUP_OF` (the test fails if one is missing), so new actions are never lost from the page.
- Not built: CSV download (the owner said later). Staff-role people do not get the page.

### 10h. Reports (2026-10-25)
- Page `frontend/js/page-reports.js` (after page-activity.js), service `src/services/reports.js`, route `src/routes/reportRoutes.js` (`GET /api/schools/:id/reports?term_id=`, Admins only), test `node src/scripts/test-reports.js` (26 checks, real `*_test` Postgres, WIPED).
- One term at a time (newest with figures by default). Tiles: billed, collected, outstanding, collection rate. Collection by term, where the money came from (M-Pesa / banks / recorded by hand), money in per day (per week for a full term), arrears by class (click -> Students & balances filtered), top 10 arrears (click -> sheet), needs attention (review queue, unmatched, not billed). Print / Save as PDF gives a black-on-white page.
- Same ledger as Students & balances, so totals agree (the test checks it). Includes students who left. Rejected and reversed payments are not counted.
- Terms with no billing and no payments (before the school used Karo) are not listed and show nothing.
- Not built: per-student / class-list reports (owner: not needed now), CSV/Excel download (later).

### 10i. School settings and the PIN (2026-10-25)
- **Profile**: name, motto, phone, email, address, county, receipt footer (no KRA/registration fields). Any Admin edits it; everyone signed in can read it. Renaming the school = **Main Admin only**, needs the PIN, name must be unique across schools.
- **Logo**: PNG, JPG or WebP (SVG refused, real file bytes are checked, max 700 KB; the browser shrinks it to 400px first). Shown top of the menu (circle with initials if none), on receipts and on printed reports. Not on the login screen or in emails.
- **PIN** (Admins only): 4 to 6 digits, easy ones (1234, 1111...) refused, set or changed with the login password. Asked **only for sensitive things**: bank connections, M-Pesa keys/register, payment channels, staff invite/reset/role/suspend/email, ownership transfer, school rename. Never for payments, reversals, review queue or marking students left. One unlock lasts 10 minutes (kept in memory only); 5 wrong tries lock the PIN for 15 minutes. Password change or suspension kills the unlock.
- Everything lands in the Activity log (profile changes, logo, PIN set/changed, wrong PIN, lock).
- API: `GET/PUT /schools/:id/profile`, `PUT/DELETE /schools/:id/logo`, `GET /schools/:id/pin`, `POST /schools/:id/pin/set`, `POST /schools/:id/pin/unlock`. Sensitive routes answer 403 `{code:'pin_required'|'pin_not_set'}`; send the unlock as header `X-Pin-Token`.
- Test: `node src/scripts/test-settings.js` (63 checks).

### 10j. Classes: full class page (2026-10-25)
- Classes & streams is now a list; click a class (or one of its streams) to open its **full page** (`frontend/js/page-class-detail.js`).
- **Students tab**: full class list with billed / paid / balance and a Paid up / Owing / Credit / Not billed tag, from the same ledger as Students & balances. Filters: search, stream, term, status. **Download CSV** and **Print list** contain exactly what the filters show (a class teacher filters to their stream and prints).
- **Moving students**: only between streams of the same class, from a row ("Move" / "Put in stream") or by ticking several. The "N students have no stream" notice only appears when the class has streams. Admins only; staff-role people can look. Changing a student's CLASS stays in Promotion & transfers.
- **Streams tab**: add, rename, remove empty streams. Merge is hidden under "More".
- Promotion rules are no longer shown on this page (by default a stream name follows its students). The backend routes are untouched.

### 10k. The student page (2026-10-25)
- Clicking a student (Students & balances, Reports, Activity log) opens a **full page**, not a pop-up. Back returns to the same list and filters; Previous / Next walk the list you came from.
- Top: name, admission no., class/stream, status, buttons. Then four tiles (brought forward, fees charged, paid, balance) with the sum written out, and a term picker. Last 5 payments (Show all for the rest; reversed payments stay, struck out, with who and why). Side: fees, money by term, contacts, "what changed".
- Payment methods: **Cash, M-Pesa, Bank, Cheque, Other**. "Bank" shows the bank's name when the school uses exactly one. **M-Pesa and Bank need the code** (the transaction code or slip number, NOT the admission number); a code already recorded, by hand or arriving by itself, is refused. A reversed payment frees its code.
- **Admission number** can be corrected by an Admin (not by staff-role); it can not clash with another student; payments already received stay with the student; the change is in the activity log. Parents must use the new number from then on.
- Tests: `node src/scripts/test-student-sheet.js` (77 checks).

### 10l. Admit student page (2026-10-25)
- Order: Full name, Class, Admission number. Class is a wide picker grouped by stage (Pre-primary, Lower primary...), only the classes the school runs.
- **Admission numbers are digits only, with `/` or `-` allowed** (215, 2024/015, 12-07). No letters, in the admit page, in Edit details on the student page, and on the server. Numbers that already exist with letters keep working.
- After a class is chosen the page suggests the next number (the last number-style admission + 1, leading zeros kept; skips a taken or confusable number). It is filled in but editable, and a number the person typed is never overwritten.

### 10b. Fees and billing (the design, decided by the owner 2026-10-21/22)
- **Fee structure = a reusable template**, one per school + class + **term number** (1, 2, 3). No year, so it is set once and reused. It can be **edited any day** and **never locks anything**. Each save writes a **new version** (old ones kept, a database trigger refuses any change/delete). The newest version is the "latest". Term 3 is shorter, so every term has its own prices.
- **Mandatory and optional fees are saved together** in one version. A class has an optional fee in a term only if that class's version for that term contains it. The school keeps one list of optional fee **names** (`school_optional_fees`); the price is per class per term. Mandatory total + optional total + grand total are worked out per class per term.
- **Billing is what locks.** On (or within an hour of) a term's first day the server takes, for each class the school runs, the latest version of that class's fees for that term number and **locks it for that exact term** (`term_fee_locks`), then charges the class's active students from the locked version. Editing the structure later never changes a billed term. A class with no fees yet is not billed and is tried again on every run (so fees set late are billed on their own).
- **Never twice** (several layers): primary key (school, term, class) on `term_fee_locks`; the lock is claimed with INSERT ... ON CONFLICT DO NOTHING RETURNING; one school at a time (advisory lock); triggers refuse UPDATE/DELETE on locks, billing records and versions; charging recalculates (never adds) and never touches payments; one school failing never stops the others.
- Only the **current** term is billed (latest started, and not ended: the holiday before the next term bills nothing).
- A student admitted into a running term: if the class is not locked yet and has fees, admission locks it; otherwise the student is charged from the locked version.
- **Not built yet (on purpose):** a careful admin-side "re-bill a running term" (needs a preview and its own safety rules), the screens (fee structure page, optional fees page), the operator dashboard.
- Old design (fees tied to one year's term in `fee_items`) was carried over once automatically at start (newest year = latest version; terms that already had ledgers are marked billed and locked). `fee_items` stays in the database, unused. School-wide fees (no class) no longer exist: the carry-over warns and skips them.

## 11. Each bank: how it connects
| | **M-Pesa Paybill** | **KCB** | **Equity** | **Co-op** |
|---|---|---|---|---|
| School gives | Paybill (**must be a Paybill, not a Till**) + Daraja PRODUCTION Consumer Key/Secret (after Go Live by the school's M-Pesa manager) | KCB account number (or Vooma till) | nothing | Co-op account number |
| We generate | per-school 40-character secret code, inside two addresses | nothing | username + 32-char password (shown once) | username + 32-char password (shown once) |
| Bank-side step | **We** call Safaricom's API to register the two addresses (nobody pastes in a dashboard). Production = one time only | Signed request letter to **buni@kcbgroup.com**; KCB sends its public key, which goes in `.env` | School pastes address + login in **JengaHQ** (Alerts, credit only) | School asks Co-op to subscribe the account to INS (credits). **Not confirmed how** |
| Our address | `/webhooks/c2b/<code>/confirmation` and `/validation` | `/webhooks/kcb/ipn` | `/webhooks/equity/ipn` | `/webhooks/coop/ins` |
| School found by | Paybill in message + secret code | `creditAccountIdentifier`, then till, then shortcode | the username | `AccountNumber`, then login must match |
| Proof it is real | the secret code in the address | KCB's signature (SHA256withRSA over raw body, header `signature`) | Basic Auth | Basic Auth (3 places accepted) |
| Reply | `{"ResultCode":0,...}`; reject `C2B00015` | flat `{transactionID,statusCode:"0",...}` | 200 | `{MessageCode:"0",...}` |
Rules in the code: credits only; duplicates ignored (unique per channel + bank reference); phone numbers never trusted; M-Pesa addresses must be https, not contain mpesa/safaricom/exe/exec/cmd/sql/query, no localhost/ngrok in production.

**M-Pesa in detail.** Screen: a 5-step checklist (keys saved → keys checked → our public address ready → addresses registered → first payment). Registering = our server logs in to Safaricom with the school's keys, then sends the two addresses. The secret code is made by us (random, 40 characters), stored encrypted per school. Safe order: save the new code as *pending* → call Safaricom → only if it confirms, pending becomes the school's code and the date is recorded; if Safaricom says no or is unreachable the pending code is thrown away and nothing that worked changes (messages show Safaricom's real reason). The webhook accepts the school's stored code, or the pending one (so an interrupted registration loses no payment), or the OLD shared-secret code **only** for schools registered before per-school codes (they keep working; re-registering in test mode migrates them; in LIVE it needs the team). Production registration is one time; changing needs Safaricom to delete the old ones first. `services/mpesaSetup.js` holds all the rules; `getFullUrls()` exists for the future operator dashboard only (never wire it to a school-facing route).

**KCB in detail.** No password to generate. The screen takes the account number, shows our address for the letter, and shows whether OUR side has KCB's key (`installed` / test mode / `NOT installed` / `unreadable`). Without a key outside production, messages are accepted unsigned (test mode); with a key, unsigned/tampered messages are refused.

**Verified against documents:** the four message formats (KCB PDFs, Equity Jenga pages, Co-op portal PDF, Safaricom C2B + Authorization pages). **Still UNCONFIRMED (settle with the first real message or the bank):**
- **KCB**: is the public key the same for every school or one per school (if per school we must store a key per school)? Which field holds the school's account? Sample message and signature details? A test environment?
- **Equity**: where the parent's typed reference lands in an alert; whether alerts cover every deposit type.
- **Co-op**: **the owner believes Co-op has no instant push and works by polling.** The connector was built for INS (push) from Co-op's portal PDF, and `src/services/coopPoller.js` is OLD polling code that is **not started anywhere**. Unresolved. Co-op's docs page needs JavaScript, so the owner must paste text or save PDFs. Questions for Co-op: (1) exact `EventType` word for money in (docs only show `DEBIT`; code accepts `CREDIT`/`CR`/`C`; unknown types are acknowledged but **not saved**, only logged); (2) where the login travels; (3) how a school subscribes.
- **M-Pesa**: the real reply format of the registration call (if different we refuse to record "registered" instead of guessing).
First target school pays through **Co-op**; second by **M-Pesa**. Order: Co-op, M-Pesa, then KCB/Equity as schools need them.

## 12. Staff API (login token; the school number in the URL must match the token)
- **Read**: `GET /api/schools/:id/summary | review-queue | unmatched | transactions | students | channels | bank-connections | staff | classes | streams`, `classes/:id/students | repeat-options`
- **Review**: `POST /api/transactions/:id/confirm | reject`
- **Channels**: `PUT /api/schools/:id/channels {channels:[...]}` (Admin)
- **Bank setup (Admin)**: `POST .../bank-connections` (KCB etc.; Equity and Co-op refused here), `POST .../bank-connections/equity/credentials`, `.../coop/credentials` (first time free; replacing needs `confirm_text` + `password` + the wait)
- **M-Pesa (Admin)**: `PUT .../mpesa/keys`, `POST .../mpesa/check-keys`, `POST .../mpesa/register` (`{dry:true}` or `{confirm_paybill, password}`)
- **Staff** (`routes/staffRoutes.js`, see 10f): `GET .../me`, `GET .../staff` (Admin), `POST .../staff` (invite), `POST .../staff/:id/resend-invite | send-reset | role | status | name | email`, `POST .../transfer-ownership`; public: `POST /api/auth/forgot | token-info | complete`; signed in: `POST /api/auth/change-password`. The old "Admin sets someone's password" route is gone.
- **Other**: `POST .../students`, `POST .../promotion/run`, `POST .../classes/:id/toggle`, `POST .../streams`, `POST /api/students/:id/transfer-stream`
- **Fees** (`routes/fees.js`): `GET .../fees` (one card per class, 3 terms) · `GET .../fees/class/:classId` (Term 1/2/3 tabs, latest on top, history, what was locked) · `POST .../fees/set` · `POST .../fees/copy` · `GET .../optional-fees` (price per class per term) · `POST .../optional-fees` (add a name) · `POST .../optional-fees/prices` · `DELETE .../optional-fees/:name`. Admin to change. **There is no route to bill: billing is automatic.**
- **Login**: `POST /api/auth/login`. Banks call `/webhooks/...` (section 11).
Errors: plain errors → 400 with the message; refusals with their own code (401/403/409/429/502); bugs → 500 "generic". A bad request never crashes the server.

## 13. Database (tables are built at start from `src/db/schema.sql` + `fee_structure_schema.sql`; adding columns/indexes is automatic and safe to repeat)
`schools` (name, Paybill, encrypted Daraja keys, M-Pesa secret code + pending, registration date) · `staff` (email, role, password hash) · `students` · `transactions` (every payment; never deleted) · `bank_providers` · `school_bank_connections` · `school_channels` (which channels a school switched on; unpicking only hides) · `student_term_ledger` · `academic_years`, `terms` (global) · classes/streams · `fee_templates` + `fee_template_items` (versions) · `term_fee_locks` (what was locked per school, term, class) · `term_billing` (one row per school and term) · `fee_items` (OLD, unused) · `audit_log` · `login_attempts`.
Upgrade rules: new columns default so old data keeps working (old staff became admin; schools already receiving M-Pesa count as registered, kind "legacy"; a school already using a channel stays switched on). Unique indexes that cannot be built because duplicates already exist are skipped with a warning (server still starts; app-level checks still protect new records).

## 14. Tests
The 9 offline files above use stubbed databases and each bank's own samples (384 checks). `test-term-setup.js` was also run on a real Postgres (terms, the same-instant race, audit entries, a payment reaching the ledger, the daily auto-charge) and each rule was broken on purpose to prove the test notices. **Also done by the assistant in its sandbox, NOT in this folder (rebuild when needed):** the whole server on real Postgres, a pretend Safaricom (returns success, errors, HTTP errors, no connection), the same-instant races (two schools, same email, same Paybill), and a simulated browser (jsdom) for every screen. Lesson: always run the real pages in the simulated browser; it caught real bugs (a global name clash, a popup with double buttons).

## 15. Decisions log (owner)
Auto-match only on admission number · credits only · no phone/name/amount scoring, no percentages · schools use Karo Recon **or** their old software (no forwarding) · Hakikisha (Safaricom name check) parked · statement pull check parked (wanted: quick check about hourly + fuller every 24 h for KCB and Equity; KCB seems to have **no** statement API; discuss before coding) · silence alarm dropped · saving unroutable payments skipped for now (watch logs, compare with the bank in first live tests) · schools do their own bank paperwork where possible · the owner's team onboards schools (admin side), schools never self-onboard · school AND student setup from the terminal for now, screens later in the owner's own admin side · only Admins reset bank credentials · channels a school does not use stay hidden but can be switched back on · bank connectors are enough until real schools exist, then refine from real use · no sandbox for banks: help the school sign, send the request, test live with ~KES 50 (several times) · frontend: one file per page.

**Fees (2026-10-21/22):** fee structure is a template per class per term number with no year, editable any day, new version on every save · billing is automatic and is what locks fees for a term · optional fees live in the same version as mandatory, per class per term · no toggle: if a class has an optional fee for that term it shows, otherwise not · re-billing a running term is admin-only and built later, carefully.

## 16. Going live (plain)
Going live = moving from the laptop to a real server on the internet, so the banks can reach it.
1. **Domain** (no "mpesa" or "safaricom" in it) and a server with **https**.
2. Server with Node and Postgres, and something that **restarts** the app if it stops.
3. `.env` complete: real `DATABASE_URL`, two fresh secrets, `PUBLIC_BASE_URL`, `MPESA_ENV=production`, `NODE_ENV=production`, no dev flag.
4. **Back up** the database daily, off the server, and **test a restore**. Back up `ENCRYPTION_KEY` separately.
5. Only ports 80/443 open. Timezone Africa/Nairobi.
6. Keep a **separate practice server** with its own database (`MPESA_ENV=sandbox`) for rehearsing.
7. Per school: `create-school`, the school's Admin sets up each channel, then test about KES 50 five times per bank: exact admission number → auto-matched; a name only → unmatched; two numbers → review.
8. Watch the server logs for unknown messages (especially Co-op) and compare with the bank.

## 17. Next steps (owner's priorities first; confirm before starting)
1. ~~Terms setup tool~~ DONE (`set-terms.js`). Still open: **student import from the terminal (CSV, with `--dry`)** and **fee structure from the terminal**: without them the first school cannot see balances. Verify how a student gets a ledger row first. **(Both traps found on 2026-10-19 are fixed by the 2026-10-22 billing redesign: billing is per school and per class, a class without fees is retried, and nothing is marked done until it is billed.)** Old note: (a) the server charges a term ONCE (at start and in its daily check, `termAutoCharge.js`) and marks it done even when there are no students or fees yet, so fees added later are never charged by themselves; `chargeFeesForTerm(termId)` is safe to run again (it keeps `amount_paid`), so we need a small `charge-term` command (or the import/fee tools must call it); (b) `setClassFeesForTerm` refuses to edit fees of a term that already started, so a school going live in the middle of a term needs a way to set that term's fees. Also `chargeFeesForTerm` charges EVERY school's students, not one school.
2. **Request-letter helper**: "Copy the request letter" buttons in the KCB and Co-op popups (school name, account, our address, the questions to ask).
3. **TEST/LIVE ribbon** on every page (so a practice server is never mistaken for the real one).
4. **`schools-status` report command**: every school, channels, M-Pesa stage, last payment.
5. **Change-my-password screen** (today only `create-admin` resets a password).
6. **Co-op**: settle the real mechanism (push or polling); safety net so unknown event types are saved for a person instead of dropped.
7. Statement pull / safety-net check (parked), hosting guide, then the owner's operator dashboard (create school/students, resets with permission, copy full M-Pesa addresses via `getFullUrls`).

## 18. What a request letter is (plain)
A bank will not send payment alerts to just anyone. The **school** (the account owner) must **ask the bank in writing** to switch alerts on for its account and say where to send them (our address). The people who can sign for that account sign it. We prepare the words; the school signs; for Co-op a visit to the school's branch manager is likely better than a letter alone.
Put in it: school name, account number, our address, "credits only", and ask: **KCB** (to buni@kcbgroup.com): is the public key the same for every school, which field holds the account, a sample message with signature details, is there a test environment. **Co-op**: the three questions in section 11. **Equity**: the school does it itself in JengaHQ (no letter). **M-Pesa**: no letter; the school does Go Live on Daraja.

## 19. Glossary
**Webhook/push** the bank messages us · **Poll/pull** we ask the bank · **Ledger** a student's money record for a term · **Fingerprint** one-way scramble of a password (cannot be turned back) · **INS/IPN** instant notification names (Co-op / KCB, Equity) · **Paybill vs Till** a Paybill has an account-reference field, a Till does not · **Operator** the owner and his agents (not a school) · **Legacy** an M-Pesa school registered before per-school codes.

## 20. Continue in a new chat
Upload the project zip and say: "Read `README.md` and `frontend/frontend-README.md`. Run the 9 tests and compare with section 3. I use plain simple words, one piece at a time (say what is done / where we are / where we are going), Windows CMD, no pile of zips. Next is section 17, item 1."
### 10g. Parent portal (built 2026-10-26)
- Page: `frontend/portal/` (open `/portal/`). Same design as the mockup, now live: Home, Fees, Payments, receipts, "Send request to my phone" (STK push) and the Paybill steps.
- A parent is a **phone number**, not an account: they sign in with that number + a 6-digit code sent by text message (`services/parentAuth.js`, `services/sms.js`, Celcom Africa). They see every in-school student that has that number as a contact, in any school. Anything else is a plain 404. Phones are compared on the last 9 digits, so `0712 345 678` and `+254712345678` are the same.
- API: `src/routes/parentRoutes.js` (`/api/parent/*`, header at the top of the file lists every route). Rules: `services/parentPortal.js`. Parent tokens and staff tokens can not open each other's pages.
- STK push, steps 1-3 (yours) + step 4 (new): the result arrives at `POST /webhooks/stk/:requestId/:token/result` -> `services/stkCallback.js`. It books the payment in ONE transaction. A paid STK push also triggers the normal Paybill alert with the same M-Pesa code; `UNIQUE(source, external_ref)` makes whichever arrives second a no-op. If the alert came first but went to the Review queue, the callback settles it (it knows the student for sure). If no callback ever comes, the portal's polling asks Safaricom after 40 s (`refreshIfStale`); that can close a request as cancelled/timeout but never books money (Safaricom's answer has no receipt code).
- Tables: `src/db/parent_schema.sql` (runs after `stk_schema.sql`). New .env: `PUBLIC_BASE_URL`, `SMS_PROVIDER=celcom`, `SMS_API_KEY`, `SMS_PARTNER_ID`, `SMS_SENDER_ID`, optional `SMS_URL`, `SMS_PRINT_CODE` (see `.env.example`). The sign-in code is always printed in the terminal outside production (and in production with SMS_PRINT_CODE=true); with no SMS settings it is also shown on the sign-in screen.
- Test: `node src/scripts/test-parent-portal.js` (95 checks, HTTP, real `*_test` Postgres, WIPED, Safaricom and SMS faked).
- NOT proven with the real services: Safaricom STK (sandbox/live), Africa's Talking. Safaricom is written from its docs; Celcom's send address is not on their public page, so it defaults to https://isms.celcomafrica.com/api/services/sendsms/ and can be changed with SMS_URL. Both are and tested against fakes.
