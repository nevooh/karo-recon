// Tests the term setup engine (src/services/termSetup.js) without a real database.
// The pretend database can UNDO work (ROLLBACK), so "all or nothing" and --dry are really tested.
// Run:  node src/scripts/test-term-setup.js
const crypto = require('crypto');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

let failed = 0;
const check = (name, ok, extra) => { if (!ok) failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---- a pretend database with transactions ----
const st = { today: '2026-10-19', years: [], terms: [], charged: [], audit: [], log: [], nextId: 1, released: 0, snap: null, failUpdate: false };
const snapshot = () => JSON.stringify({ years: st.years, terms: st.terms, nextId: st.nextId });
const restore = (s) => { const o = JSON.parse(s); st.years = o.years; st.terms = o.terms; st.nextId = o.nextId; };
const query = async (sql, params = []) => {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (/^BEGIN/.test(q)) { st.log.push('BEGIN'); st.snap = snapshot(); return { rows: [] }; }
  if (/^COMMIT/.test(q)) { st.log.push('COMMIT'); st.snap = null; return { rows: [] }; }
  if (/^ROLLBACK/.test(q)) { st.log.push('ROLLBACK'); if (st.snap) restore(st.snap); st.snap = null; return { rows: [] }; }
  if (/pg_advisory_xact_lock/.test(q)) { st.log.push('LOCK'); return { rows: [] }; }
  if (/to_char\(CURRENT_DATE/.test(q)) return { rows: [{ today: st.today }] };
  if (/^SELECT id FROM academic_years WHERE year = \$1/.test(q)) { const y = st.years.find((x) => x.year === params[0]); return { rows: y ? [{ id: y.id }] : [] }; }
  if (/^INSERT INTO academic_years/.test(q)) { const row = { id: st.nextId++, year: params[0], is_current: !st.years.some((x) => x.is_current) }; st.years.push(row); st.log.push('INSERT year'); return { rows: [{ id: row.id }] }; }
  if (/^INSERT INTO terms/.test(q)) { st.terms.push({ id: st.nextId++, academic_year_id: params[0], term_number: params[1], start_day: null, end_day: null }); st.log.push('INSERT term'); return { rows: [] }; }
  if (/FROM terms t JOIN academic_years ay/.test(q)) {
    const rows = st.terms.map((t) => ({ id: t.id, year: st.years.find((y) => y.id === t.academic_year_id).year, term_number: t.term_number, start_day: t.start_day, end_day: t.end_day, charged: st.charged.includes(t.id) }));
    rows.sort((a, b) => a.year - b.year || a.term_number - b.term_number);
    return { rows };
  }
  if (/^UPDATE terms SET start_date/.test(q)) {
    if (st.failUpdate) throw new Error('disk is full');
    const t = st.terms.find((x) => x.id === params[2]); t.start_day = params[0]; t.end_day = params[1]; st.log.push('UPDATE term'); return { rows: [] };
  }
  if (/^INSERT INTO audit_log/.test(q)) { st.audit.push({ action: params[2], detail: JSON.parse(params[3]) }); return { rows: [] }; }
  return { rows: [] };
};
const pool = { query, connect: async () => ({ query, release: () => { st.released++; } }) };
require.cache[require.resolve('../db/db')] = { id: require.resolve('../db/db'), filename: require.resolve('../db/db'), loaded: true, exports: { pool, initSchema: async () => {} } };
const svc = require('../services/termSetup');
const reset = () => { st.today = '2026-10-19'; st.years = []; st.terms = []; st.charged = []; st.audit = []; st.log = []; st.nextId = 1; st.released = 0; st.snap = null; st.failUpdate = false; };
const set = (year, term, start, end, extra = {}) => svc.setTermDates({ year, term, start, end, ...extra });
const termRow = (year, term) => { const y = st.years.find((x) => x.year === year); return y && st.terms.find((t) => t.academic_year_id === y.id && t.term_number === term); };

(async () => {
  // ================= checking what was typed =================
  const bad = (over, re) => { try { svc.validateTermInput({ year: 2026, term: 3, start: '2026-08-31', end: '2026-10-23', ...over }); return false; } catch (e) { return e.status === 400 && re.test(e.message); } };
  const good = svc.validateTermInput({ year: '2026', term: '3', start: ' 2026-08-31 ', end: '2026-10-23' });
  check('good input is cleaned (text numbers and spaces accepted)', good.year === 2026 && good.term === 3 && good.start === '2026-08-31' && good.end === '2026-10-23', good);
  for (const y of [26, 1999, 2101, 'abc', '', null, 2026.5]) check(`bad year "${y}" -> 400`, bad({ year: y }, /4 digits/));
  for (const t of [0, 4, 'x', '', null, 1.5]) check(`bad term "${t}" -> 400`, bad({ term: t }, /1, 2 or 3/));
  for (const d of ['31/08/2026', '2026-8-31', '2026/08/31', 'tomorrow', '', null, '2026-08-31T00:00']) check(`wrong date style "${d}" -> 400`, bad({ start: d }, /year-month-day/));
  check('31 February is not a real date -> 400', bad({ start: '2026-02-31' }, /not a real date/));
  check('29 February in a non-leap year -> 400', bad({ start: '2026-02-29', end: '2026-05-20' }, /not a real date/));
  check('29 February in a leap year is fine', (() => { try { svc.validateTermInput({ year: 2028, term: 1, start: '2028-02-29', end: '2028-05-20' }); return true; } catch (e) { return false; } })());
  check('month 13 -> 400', bad({ end: '2026-13-01' }, /not a real date/));
  check('end equal to start -> 400', bad({ end: '2026-08-31' }, /AFTER/));
  check('end before start -> 400', bad({ end: '2026-08-01' }, /AFTER/));
  check('a 13-day term looks like a typing mistake -> 400', bad({ start: '2026-08-31', end: '2026-09-13' }, /13 days/));
  check('a 14-day term is the shortest allowed', (() => { try { svc.validateTermInput({ year: 2026, term: 3, start: '2026-08-31', end: '2026-09-14' }); return true; } catch (e) { return false; } })());
  check('a 181-day term looks like a typing mistake -> 400', bad({ start: '2026-03-01', end: '2026-08-29' }, /181 days/));
  check('dates in another year -> 400', bad({ start: '2025-08-31', end: '2025-10-23' }, /inside 2026/));
  check('start in one year and end in the next -> 400', bad({ start: '2026-11-20', end: '2027-01-10' }, /inside 2026/));
  check('the engine refuses bad input before touching the database', await (async () => { reset(); const e = await rejects(() => set(2026, 9, '2026-08-31', '2026-10-23')); return e && e.status === 400 && st.log.length === 0 && st.released === 0; })());

  // ================= the first term ever =================
  reset();
  let r = await set(2026, 3, '2026-08-31', '2026-10-23');
  check('first use of a year makes the year and its 3 terms', r.createdYear && st.years.length === 1 && st.terms.length === 3, st.terms);
  check('the very first year becomes the current year', st.years[0].is_current === true);
  check('only the asked term got dates; the other two have none', termRow(2026, 3).start_day === '2026-08-31' && termRow(2026, 3).end_day === '2026-10-23' && !termRow(2026, 1).start_day && !termRow(2026, 2).start_day);
  check('a term that has already started becomes the CURRENT term, and the answer says so', r.current && r.current.term_number === 3 && r.warnings.some((w) => /CURRENT term/.test(w)), r.warnings);
  check('it warns that the fees of that term are not charged yet', r.warnings.some((w) => /not charged yet/.test(w)), r.warnings);
  check('it all ran in ONE transaction, one at a time (LOCK), and committed', st.log[0] === 'BEGIN' && st.log[1] === 'LOCK' && st.log[st.log.length - 1] === 'COMMIT' && !st.log.includes('ROLLBACK'), st.log);
  check('the connection was given back', st.released === 1);
  check('a real change is written to the audit log (no school, no secrets)', st.audit.length === 1 && st.audit[0].action === 'terms_set' && st.audit[0].detail.year === 2026 && st.audit[0].detail.term === 3 && st.audit[0].detail.created_year === true, st.audit);

  // ================= the other terms of the year =================
  r = await set(2026, 1, '2026-01-05', '2026-04-10');
  check('term 1 saved; the year is not made twice', !r.createdYear && st.years.length === 1 && st.terms.length === 3);
  check('a term in the past does not take over as current', r.current.term_number === 3 && !r.warnings.some((w) => /CURRENT/.test(w)), r.warnings);
  r = await set(2026, 2, '2026-05-04', '2026-08-07');
  check('term 2 saved', termRow(2026, 2).start_day === '2026-05-04');

  // ================= order and overlap (all in the FUTURE, so the terms may still move) =================
  const refused = async (args, re, status = 409) => { const e = await rejects(() => set(...args)); return !!(e && e.status === status && re.test(e.message)); };
  await set(2027, 1, '2027-01-04', '2027-04-09');
  await set(2027, 2, '2027-05-04', '2027-08-06');
  await set(2027, 3, '2027-08-30', '2027-10-22');
  const auditBeforeRefusals = st.audit.length;
  check('a gap between terms is fine (term 1 ends 9 April, term 2 starts 4 May)', termRow(2027, 1).end_day === '2027-04-09' && termRow(2027, 2).start_day === '2027-05-04');
  check('term 2 may not start before term 1 ends', await refused([2027, 2, '2027-04-01', '2027-08-06'], /Term 1 2027 ends on 2027-04-09.*AFTER/));
  check('term 2 may not start on the day term 1 ends', await refused([2027, 2, '2027-04-09', '2027-08-06'], /AFTER/));
  check('term 1 may not end after term 2 starts', await refused([2027, 1, '2027-01-04', '2027-05-10'], /Term 2 2027 starts on 2027-05-04.*BEFORE/));
  check('term 1 may not end on the day term 2 starts', await refused([2027, 1, '2027-01-04', '2027-05-04'], /BEFORE/));
  check('term 2 may not run into term 3', await refused([2027, 2, '2027-05-04', '2027-09-01'], /Term 3 2027 starts on 2027-08-30/));
  check('term 3 may not start before term 2 ends', await refused([2027, 3, '2027-08-01', '2027-10-22'], /Term 2 2027 ends on 2027-08-06/));
  check('a refused change leaves the dates exactly as they were', termRow(2027, 2).start_day === '2027-05-04' && termRow(2027, 2).end_day === '2027-08-06');
  check('a refused change is rolled back and is NOT in the audit log', st.audit.length === auditBeforeRefusals && st.log.includes('ROLLBACK'));

  // ordering is checked against every dated term, even when the term in between has no dates yet
  reset();
  await set(2026, 1, '2026-01-05', '2026-04-10');
  await set(2026, 3, '2026-08-31', '2026-10-23');
  check('term 2 (no dates yet) cannot start inside term 1, even though term 2 itself was empty', await refused([2026, 2, '2026-04-01', '2026-07-30'], /Term 1 2026 ends on 2026-04-10/));
  check('term 2 (no dates yet) cannot end inside term 3', await refused([2026, 2, '2026-05-04', '2026-09-20'], /Term 3 2026 starts on 2026-08-31/));
  check('term 2 cannot be placed completely after term 3', await refused([2026, 2, '2026-10-24', '2026-12-01'], /Term 3 2026 starts on 2026-08-31/));
  r = await set(2026, 2, '2026-05-04', '2026-08-07');
  check('term 2 fits between term 1 and term 3', r.start === '2026-05-04');

  // ================= a term that already started =================
  check('a started term keeps its START date', await refused([2026, 3, '2026-09-01', '2026-10-23'], /already started on 2026-08-31.*cannot change/));
  check('the message tells which start date to use', await refused([2026, 3, '2026-09-01', '2026-10-23'], /use 2026-08-31 as the start date/));
  r = await set(2026, 3, '2026-08-31', '2026-10-30');
  check('but its END date can still move', termRow(2026, 3).end_day === '2026-10-30' && r.previous.end === '2026-10-23', r);
  check('the audit log keeps what it was before', st.audit[st.audit.length - 1].detail.previous_end === '2026-10-23');
  st.charged.push(termRow(2026, 3).id);
  r = await set(2026, 3, '2026-08-31', '2026-10-28');
  check('a term that was already charged: end date still moves, and no "not charged" warning', termRow(2026, 3).end_day === '2026-10-28' && !r.warnings.some((w) => /not charged/.test(w)), r.warnings);
  check('a term that was already charged never changes its start', await refused([2026, 3, '2026-08-30', '2026-10-28'], /cannot change/));
  check('a term still in the future can move its start both ways', await (async () => { await set(2027, 1, '2027-01-04', '2027-04-09'); await set(2027, 1, '2027-01-11', '2027-04-16'); await set(2027, 1, '2027-01-04', '2027-04-09'); return termRow(2027, 1).start_day === '2027-01-04'; })());

  // ================= nothing to change, and --dry =================
  reset();
  await set(2026, 3, '2026-08-31', '2026-10-23');
  const logBefore = st.log.length, auditBefore = st.audit.length;
  r = await set(2026, 3, '2026-08-31', '2026-10-23');
  check('the same dates again -> "unchanged", nothing written, nothing audited', r.unchanged && st.audit.length === auditBefore && !st.log.slice(logBefore).includes('UPDATE term'), st.log.slice(logBefore));
  reset();
  r = await set(2026, 3, '2026-08-31', '2026-10-23', { dry: true });
  check('--dry on a brand new year reports what it WOULD do', r.dry && r.createdYear && r.warnings.some((w) => /CURRENT/.test(w)));
  check('--dry changes NOTHING (the year and terms it made are undone)', st.years.length === 0 && st.terms.length === 0 && st.audit.length === 0 && st.log[st.log.length - 1] === 'ROLLBACK', { y: st.years, t: st.terms.length });
  check('--dry still refuses what a real run would refuse', await (async () => { await set(2026, 1, '2026-01-05', '2026-04-10'); const e = await rejects(() => set(2026, 2, '2026-04-01', '2026-08-07', { dry: true })); return e && e.status === 409; })());

  // ================= all or nothing =================
  reset();
  st.failUpdate = true;
  let e = await rejects(() => set(2026, 3, '2026-08-31', '2026-10-23'));
  check('if saving fails half-way, the new year is NOT left behind', e && /disk is full/.test(e.message) && st.years.length === 0 && st.terms.length === 0, { y: st.years.length });
  check('...nothing is audited and the connection is still given back', st.audit.length === 0 && st.released === 1);

  // ================= years =================
  reset();
  await set(2026, 3, '2026-08-31', '2026-10-23');
  await set(2027, 1, '2027-01-04', '2027-04-09');
  check('a second year is NOT made the current year (the first one stays)', st.years.find((y) => y.year === 2026).is_current && !st.years.find((y) => y.year === 2027).is_current);
  check('a year set up in the future leaves payments on the running term', (await svc.listTerms({ pool })).current.term === 3);
  r = await set(2026, 1, '2026-01-05', '2026-04-10');
  check('an OLD term set later (term 1 2026) does not take over, and does not warn', r.current.term_number === 3 && r.current.year === 2026 && !r.warnings.some((w) => /CURRENT/.test(w)), r.warnings);

  // ================= no term started yet =================
  reset();
  r = await set(2027, 1, '2027-01-04', '2027-04-09');
  check('when nothing has started, it says there is no current term yet', r.current === null && r.warnings.some((w) => /No term has started yet/.test(w)), r.warnings);

  // ================= the list (show) =================
  reset();
  await set(2026, 1, '2026-01-05', '2026-04-10');
  await set(2026, 2, '2026-05-04', '2026-08-07');
  await set(2026, 3, '2026-08-31', '2026-10-23');
  await set(2027, 1, '2027-01-04', '2027-04-09');
  st.charged.push(termRow(2026, 3).id);
  let list = await svc.listTerms({ pool });
  const by = (y, t) => list.terms.find((x) => x.year === y && x.term === t);
  check('list: terms come oldest first, 6 rows for 2 years', list.terms.length === 6 && list.terms[0].year === 2026 && list.terms[5].year === 2027);
  check('list: states are ended / ended / running / coming / no dates', by(2026, 1).state === 'ended' && by(2026, 2).state === 'ended' && by(2026, 3).state === 'running' && by(2027, 1).state === 'coming' && by(2027, 2).state === 'no dates', list.terms.map((t) => t.state));
  check('list: exactly one row says payments go there (term 3 2026)', list.terms.filter((t) => t.paymentsGoHere).length === 1 && by(2026, 3).paymentsGoHere);
  check('list: shows whether fees were charged', by(2026, 3).charged === true && by(2026, 2).charged === false);
  check('list: today is reported', list.today === '2026-10-19');
  // the holiday gap: term 3 has ended but is still where payments go, until term 1 of 2027 starts
  st.today = '2026-12-20';
  list = await svc.listTerms({ pool });
  check('holiday gap: term 3 shows "ended" but payments still go there', by(2026, 3).state === 'ended' && list.current.term === 3 && list.terms.find((t) => t.year === 2026 && t.term === 3).paymentsGoHere);
  st.today = '2027-01-04';
  list = await svc.listTerms({ pool });
  check('the day term 1 of 2027 starts, payments move to it by themselves', list.current.year === 2027 && list.current.term === 1);
  st.today = '2026-01-04';
  list = await svc.listTerms({ pool });
  check('before any term started: nothing is current', list.current === null && list.terms.every((t) => !t.paymentsGoHere));

  // ================= it picks the current term the same way the payment code does =================
  const { pickCurrent } = svc;
  const T = (y, n, s, en) => ({ id: y * 10 + n, year: y, term_number: n, start_day: s, end_day: en });
  check('pickCurrent: the term whose start passed most recently', pickCurrent([T(2026, 1, '2026-01-05', '2026-04-10'), T(2026, 2, '2026-05-04', '2026-08-07'), T(2026, 3, '2026-08-31', '2026-10-23')], '2026-06-01').term_number === 2);
  check('pickCurrent: a term without a start date is never current', pickCurrent([T(2026, 1, null, null)], '2026-06-01') === null);
  check('pickCurrent: starts today counts', pickCurrent([T(2026, 1, '2026-06-01', '2026-08-01')], '2026-06-01').term_number === 1);
  check('pickCurrent: starts tomorrow does not', pickCurrent([T(2026, 1, '2026-06-02', '2026-08-01')], '2026-06-01') === null);

  console.log(failed ? `\n${failed} check(s) FAILED.` : '\nAll term setup checks pass.');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });