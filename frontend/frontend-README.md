# Karo Recon — frontend guide (the screens)

_Last updated: 2026-10-18. The project guide and the backend are in the root `README.md`. Read that first, especially section 0 (how to work with the owner)._

## 1. Principles (decided by the owner)
1. **Mostly a monitor.** Screens show things. The everyday actions are the **Review queue** and the **bank setup** on Bank connections.
2. **Mobile friendly.** Tables turn into labelled cards on phones (`<td data-label>`). Buttons at least 40 px.
3. **Never show secrets.** Passwords and keys are shown ONCE at creation (inside a popup that cannot be closed by accident), never again. After that the screen shows only "set / not set". The full M-Pesa addresses are never shown, only a masked preview (`…/c2b/3f9a…/confirmation`).
4. **Escape everything** that comes from outside (payer names, references, server messages): use `esc()`.
5. **One file per page.** New pages get their own file and their own `<script>` line.
6. **Each school picks its channels** in School settings; only the switched-on ones appear on Bank connections.
7. **The server decides, the screen only shows.** Admin-only buttons are hidden for staff, but the server refuses anyway and the screen shows the server's message.

## 2. Files and load order (`index.html`)
Later files override earlier ones (`views.payments = ...` replaces a demo page). The server serves this folder from the same address as the API.
| # | File | Job |
|---|---|---|
| 1 | `js/sample-data.js` | FAKE data for the demo pages (delete when every page is real) |
| 2 | `js/app.js` | the original demo (16 screens with fake data), the switchboard `showView(name)`, helpers (`money`, `chipFor`, `openModal`, `closeModal`…) |
| 3 | `js/api.js` | talks to the server: `Api.get / post / put / request`; token in `sessionStorage`; 401 logs out; failures throw `Error(server message)` |
| 4 | `js/live.js` | REAL login/logout, session restore, Dashboard, data loading (`live`, `loadLiveData`) |
| 5 | `js/live-screens.js` | REAL Payments and Students & balances |
| 6 | `js/page-review.js` | REAL Review queue (two tabs + student finder) |
| 7 | `js/page-banks.js` | REAL Bank connections (cards of the switched-on channels) |
| 8 | `js/page-settings.js` | REAL School settings (channel switches; the old fake fields were removed) |
| 9 | `js/page-bank-setup.js` | the setup popup + Equity and Co-op flows; the plug-in hook `BANK_SETUP_OWN` |
| 10 | `js/page-bank-setup-kcb.js` | KCB flow (plugs into 9) |
| 11 | `js/page-bank-setup-mpesa.js` | M-Pesa checklist (plugs into 9) |
Other: `css/styles.css` (the look, phone layout), `index.html` (the shell and the two shared popups).

**Page-name rule (a real bug happened):** every page file's global names must be unique across ALL files, so give them a page prefix (`banks…`, `settings…`, `mpesa…`, `kcb…`). A page once used `banks`, which `sample-data.js` already defined, and the whole page broke. After writing a page, search the other files for each new global name.

## 3. How a page works
Menu click → `showView('payments')` → finds `views.payments` (a function returning the page shell) → puts it in the page → starts loading data with `Api.get('/schools/<id>/...')` (via `setTimeout(load, 0)`) → fills the page. Data is never kept in the browser: a refresh shows the truth.
Page file template:
```js
/* page-x.js — what it shows, which endpoint it reads, which actions it allows */
const xPage = { list: null };                       // state, with a page prefix
views.x = function () { setTimeout(xLoad, 0); return '<div class="topbar">…</div><div id="xBody">Loading…</div>'; };
async function xLoad() { xPage.list = await Api.get('/schools/' + live.staff.school_id + '/…'); /* build HTML with esc() */ }
window.xSomething = function () { /* called from onclick */ };
```

## 4. All pages
| Page | Status | File | Notes |
|---|---|---|---|
| Login | real | live.js | session survives refresh; token about 12 h |
| Dashboard | real | live.js | totals: auto-matched / review / unmatched |
| Payments | real | live-screens.js | filter pills, channel, search, paging |
| Review queue | real | page-review.js | see section 5 |
| Students & balances | real | live-screens.js | read-only; no class column yet |
| Bank connections | real | page-banks.js (+ setup files) | section 6 |
| School settings | real | page-settings.js | channel switches only |
| Admit student, Fee structure, Optional fees, Fee edits, Promotion, Classes, Terms, Staff, Student detail, Reports, Audit log | **DEMO (fake data, in app.js)** | — | replace one at a time; owner wants school and student setup in the terminal first, screens later in his own admin side |

## 5. Flows of the real pages
**Login** → email (capitals do not matter) + password → token stored → `loadLiveData()` → Dashboard. Wrong password shows the message. **5 wrong passwords lock the email for 15 minutes** and the screen shows the server's message. The login answer includes `role` (`admin` or `staff`). **A login made before roles existed has no role: log out and in once.** If the role is unknown the buttons show and the server decides.
**Payments** → pills (All / Auto-matched / Needs review / Unmatched / Confirmed / Rejected) + channel dropdown; search waits 0.3 s then reloads only the table; Older/Newer paging.
**Review queue** → two **tabs**:
- *Needs review*: an admission number was found but a person must decide. Two numbers found → pick one (radio). Number equal to the amount → shows the student found, confirm.
- *Unmatched*: no admission number found. Each card shows the reference and payer name/phone as clues and a **"Find the student"** box: type a number or a name (up to 3 words, searched separately; an exact admission number comes first; each result shows what the student owes), pick one, **Confirm** (popup names the student and amount) or Reject. "Search with payer name" fills the box. Server: `POST /transactions/:id/confirm {student_id}` (409 if already done).
- The shared popup has its own Cancel/Confirm row; the review popup brings its own buttons, so that row is hidden while it is open and restored by a wrapper around `closeModal` (a real double-button bug was fixed this way).
**Students & balances** → summary strip + searchable list; badge due / credit / paid up.
**School settings** → four switches (M-Pesa, KCB, Equity, Co-op) for Admins; staff see them disabled with a message. A flip saves at once (`PUT /channels` with the WHOLE list). Switching off only hides: nothing is disconnected and payments still arrive; the row says "Receiving payments (N). Hidden here, but still working." Two quick flips cannot collide (second ignored while saving).

## 6. Bank connections and the setup popups
**The page** shows a card per switched-on channel. If none is on, it says so and links to School settings. A card shows: status, identifier (Paybill / account / username), "notification login set", payment count and last payment, and the buttons. Status words are worked out by the server, not stored:
- **Not set up yet** (`setup_needed`) · **Set up · waiting for the first payment** (`waiting_for_bank`) · **Connected** (`connected` = a payment really arrived, not just "saved").
- Hidden channels that still receive payments are warned about under the cards. Staff on a not-set-up card see "Ask an Admin to set this up".

**Two popups.** The shared one (`#modalBackdrop`, used by review) and the setup one (`#setupBackdrop`, created by `page-bank-setup.js`, no click-outside closing). While a show-once password is on screen the setup popup cannot be closed (X hidden, Done disabled until "I have saved the password" is ticked). After Done the password is wiped from the page and never put in browser storage.

**Equity / Co-op** (`page-bank-setup.js`, config `BANK_SETUP`): intro (what the school needs; Co-op also asks for the account number, spaces ignored, 8–20 letters/numbers) → **Generate login** → shows callback URL, username, password (and account number for Co-op) with Copy buttons, the steps, the KES 50 test hint, and an honest note for Co-op that its steps are still being confirmed. **Reset login** (already set up) is a danger form: red warning, type RESET, your own password; the server's refusals (wrong password, wait N minutes) show inline.

**KCB** (`page-bank-setup-kcb.js`): no password. Form for the account (or Vooma till) number → saved → details view: account number and our callback URL (copy), the 4 letter steps (letter to buni@kcbgroup.com, KCB returns its public key, the team installs it, test), and a coloured box about OUR side: key installed / test mode / NOT installed / unreadable. Later: **Show details** (everyone) and **Change account number** (Admin; RESET + password + wait; the old number stops being recognised). A number another school already has is refused with the server's message.

**M-Pesa** (`page-bank-setup-mpesa.js`): a 5-step checklist popup, says **TEST** or **LIVE** at the top.
1. *Paybill and keys saved* (Save keys / Replace keys; replacing needs RESET + password; the Paybill cannot change after registering).
2. *Keys checked with Safaricom* (Check keys; registers nothing; a firewall error is NOT blamed on the keys). This result is **not stored**: after a refresh it says "not checked" until pressed again (a registered school shows done).
3. *Our server's public address is ready* (shows the problem and tells the team to set `PUBLIC_BASE_URL`).
4. *Addresses registered* (Register: a masked preview first, then type the Paybill number + your password; red "one time only" warning in LIVE; Safaricom's real reason is shown inline if it refuses, and the Admin can retry because nothing was recorded). A school registered the old way is marked "(the older way)"; re-register is offered in TEST only.
5. *First payment arrived* (green by itself).
Staff see the checklist read-only.

**Plug-in hook:** a bank with its own flow sets `BANK_SETUP_OWN.<channel> = { open(), change(), buttons(card, isAdmin) }` (see KCB and M-Pesa). `page-banks.js` calls `bankSetupAvailable`, `bankSetupOpen`, `bankSetupButtons`, `kcbKeyLine`, `mpesaStageLine`. To add a bank where we generate the login, add an entry to `BANK_SETUP`.

## 7. Roles on screen
Admin: sees every button. Staff: sees the data and works the review queue, but setup buttons are hidden or read-only. Never rely on the screen: the server enforces (403 "Only an Admin can do this" shows inline).

## 8. Phone rules and manual test
Use the existing table markup (`data-label`), buttons ≥ 40 px, one column on phones. Test: open http://localhost:3000, F12, Ctrl+Shift+M, pick a phone size (or `http://<laptop-ip>:3000` on a phone on the same Wi-Fi). Check the menu drawer, tables become cards, search/filters, login. To check a file loaded: press F12 → Console → type `Object.keys(BANK_SETUP)` (expect `["equity","coop"]`) and `Object.keys(BANK_SETUP_OWN)` (expect `["kcb","mpesa"]`).
Hard refresh with **Ctrl+F5** after replacing files. A missing or old file is the usual reason a button is missing (the Co-op button was missing once because an older `page-bank-setup.js` was in place).

## 9. Automated check (done by the assistant in its sandbox, NOT in this folder)
A simulated browser (jsdom) loads the real `index.html` and scripts against the real server on real Postgres and clicks like a person: every setup popup, the review finder, settings switches, staff read-only views, an older login with no role, malicious text shown as plain text, secrets/codes absent from the page and from browser storage, no script errors or alert popups. The server runs with a **pretend Safaricom** in front of it (answers key checks and registration; can answer an error, an HTTP error, or nothing). To rebuild: install `jsdom`, start the server with `node -r fake-safaricom.js src/server.js`, open `JSDOM.fromURL`, set `window.fetch` to the server, call `attemptLogin()`, then dispatch clicks.

## 10. Known limits
- 11 pages are still demo data (section 4); the sidebar still lists them.
- "Keys checked" (M-Pesa) is session-only. No audit-log screen, no staff screen, no change-password screen.
- Messages like "Hidden but still receiving payments" depend on the channel list answer; there is no TEST/LIVE ribbon outside the M-Pesa popup yet.

## 11. Next steps (frontend side; the owner confirms the order)
1. **TEST/LIVE ribbon** on every page (needs one small server answer: is M-Pesa LIVE, is the server in production).
2. **"Copy the request letter"** buttons in the KCB and Co-op popups (fills the school name, account, our address, and the questions to ask the bank).
3. **Change-my-password** screen.
4. Student detail, then Reports; replace the other demo pages one at a time or hide them; delete `sample-data.js` at the end. Owner prefers school and student setup in the terminal now, screens later in his own admin side.
5. Audit-log screen and a real Staff screen (add staff, roles).
6. Optional clean-up: move shared helpers to `js/lib/` and pages to `js/pages/` (one file per page already holds for new pages).

## 12. Continue in a new chat
See root `README.md` section 20. Run the 9 tests, then check the frontend with the F12 commands in section 8 above.

## NOTE 2026-10-22: Fee structure and Optional fees pages must be rebuilt
The backend moved to a new fee design (see root `README.md` section 10b). `js/page-fees.js` was written for the OLD design (year-based terms, "Grade 1-3" ranges, a locked running term, a Bill term button) and its calls (`/fees?year=&term=`, `/fees/charge`, ...) no longer exist, so **that page does not work until it is rebuilt**. The new page: one card per class (no ranges); click a class -> Term 1/2/3 tabs; each tab shows the latest version on top (history below), the mandatory fees, the class's optional fees for that term (automatic, no toggle), and Total mandatory / Total optional / Grand total; copy buttons (from another term, to other classes). The Optional fees page (`views.optionalfees`, still demo data) sets each optional fee's price per class per term. Endpoints are listed in the root README section 12.
