/**
 * Academic years and term dates, PER SCHOOL.
 *
 * Every school has its own calendar. The year and its 3 term slots (academic_years, terms) are shared and hold NO
 * dates; the dates live in school_term_dates, one row per school and term. A school admin sets their own dates
 * (route: src/routes/terms.js), the operator can use the command line (src/scripts/set-terms.js). Both use this
 * one engine, so the rules are never copied.
 *
 * Why dates matter: the "current term" of a school is worked out from its dates only (the term whose start date passed
 * most recently), and billing runs by itself when a term starts. So a date is never just a label.
 *
 * The lock rules (a date locks when it is reached):
 *   - A term that has NOT started: start and end can change freely.
 *   - A term that has started and is running: the start date is locked for good (fees are charged from it).
 *     The end date can still change (not to a day before today).
 *   - A term that has ended: fully locked.
 *   - Saving a term that starts today or in the past needs an explicit confirmation, because it starts billing now.
 *     The answer to "what happens if I confirm" is returned first (every class, how many students, who has no fees yet).
 *
 * Other guarantees:
 *   - The year and its 3 terms are made together the first time a year is used. Only last year, this year and the
 *     next two years can be started (a typo like 2062 would otherwise make a junk year).
 *   - Real dates, written YEAR-MONTH-DAY, both inside the year, end after start, a term is 14 to 180 days.
 *   - Terms of one school never overlap and stay in order (term 2 after term 1, term 1 after last year's term 3).
 *   - One change at a time per school (the same line-up lock billing and admissions use), all or nothing.
 *   - dry: true does every check and changes NOTHING.
 *   - Every real change is written to the audit log. It never touches a student, a fee or a payment by itself.
 *   - The database also refuses to move a reached start date or change an ended term (a trigger), even if this code were bypassed.
 *   - A term that is saved as already running is billed straight away (the same once-only billing the hourly check uses).
 */
const { pool } = require('../db/db');
const { logAudit } = require('./audit');
const { billSchool } = require('./termBilling');

const LINE_UP_KEY = 7771003;          // same number as billing, admissions, promotion and fee edits: one change at a time per school
const MIN_DAYS = 14;
const MAX_DAYS = 180;
const DAY_MS = 86400000;

function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }

// "2026-08-31" -> { text, ms, year }. Strict: a real calendar date, nothing else accepted.
function parseDay(value, label) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value == null ? '' : value).trim());
  if (!m) throw refuse(`${label} must be written year-month-day, for example 2026-08-31.`);
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw refuse(`${label} "${String(value).trim()}" is not a real date.`);
  }
  return { text: m[0], ms: dt.getTime(), year: y };
}

// Checks what was typed. Returns the clean values or throws a 400 a person can act on.
function validateTermInput({ year, term, start, end }) {
  const y = Number(year), t = Number(term);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw refuse('The year must be 4 digits, for example 2026.');
  if (!Number.isInteger(t) || t < 1 || t > 3) throw refuse('The term must be 1, 2 or 3.');
  const s = parseDay(start, 'The start date');
  const e = parseDay(end, 'The end date');
  if (s.year !== y || e.year !== y) throw refuse(`Both dates must be inside ${y}. Check the year you typed.`);
  const days = Math.round((e.ms - s.ms) / DAY_MS);
  if (days <= 0) throw refuse('The end date must be AFTER the start date.');
  if (days < MIN_DAYS) throw refuse(`A term of ${days} days looks like a typing mistake (the shortest allowed is ${MIN_DAYS} days).`);
  if (days > MAX_DAYS) throw refuse(`A term of ${days} days looks like a typing mistake (the longest allowed is ${MAX_DAYS} days).`);
  return { year: y, term: t, start: s.text, end: e.text };
}

const label = (t) => `Term ${t.term_number} ${t.year}`;
const order = (t) => t.year * 10 + t.term_number;     // chronological order of terms

async function today(db) {
  const r = await db.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today`);
  return r.rows[0].today;
}

function stateOf(t, todayText) {
  if (!t.start_day) return 'no dates';
  if (t.start_day > todayText) return 'coming';
  if (t.end_day && t.end_day < todayText) return 'ended';
  return 'running';
}

// The terms THIS school has dates for, oldest first (dates as plain text: no time-zone surprises).
async function loadSchoolTerms(db, schoolId) {
  const r = await db.query(
    `SELECT t.id, ay.year, t.term_number,
            to_char(d.start_date, 'YYYY-MM-DD') AS start_day,
            to_char(d.end_date, 'YYYY-MM-DD') AS end_day,
            EXISTS (SELECT 1 FROM term_billing b WHERE b.term_id = t.id AND b.school_id = $1) AS billed
     FROM school_term_dates d JOIN terms t ON t.id = d.term_id JOIN academic_years ay ON ay.id = t.academic_year_id
     WHERE d.school_id = $1
     ORDER BY ay.year, t.term_number`, [schoolId]
  );
  return r.rows;
}

// Same rule as feeLedger.getCurrentTerm: the term whose start date passed most recently.
function pickCurrent(terms, todayText) {
  const started = terms.filter((t) => t.start_day && t.start_day <= todayText);
  if (!started.length) return null;
  return started.reduce((a, b) => (b.start_day > a.start_day ? b : a));
}

// What billing would do if this term were running now: every class the school runs, its active students, and whether fees exist.
async function billingPreview(db, schoolId, termNumber, termId) {
  const r = await db.query(
    `SELECT c.id, c.name,
            (SELECT COUNT(*)::int FROM students s WHERE s.school_id = $1 AND s.class_id = c.id AND s.status = 'active') AS students,
            EXISTS (SELECT 1 FROM fee_templates f WHERE f.school_id = $1 AND f.class_id = c.id AND f.term_number = $2) AS has_fees,
            EXISTS (SELECT 1 FROM term_fee_locks l WHERE l.school_id = $1 AND l.class_id = c.id AND l.term_id = $3) AS locked
     FROM school_classes sc JOIN classes c ON c.id = sc.class_id
     WHERE sc.school_id = $1 AND sc.enabled ORDER BY c.sort_order`,
    [schoolId, termNumber, termId]
  );
  const classes = r.rows.map((c) => ({
    class: c.name, students: c.students,
    action: c.locked ? 'already billed' : !c.has_fees ? 'no fees set yet (waits, billed as soon as fees are set)' : c.students === 0 ? 'fees set, no students yet' : 'will be billed',
  }));
  const willBill = r.rows.filter((c) => !c.locked && c.has_fees && c.students > 0);
  return {
    classes,
    classesBilled: willBill.length,
    studentsBilled: willBill.reduce((a, c) => a + c.students, 0),
    waitingForFees: r.rows.filter((c) => !c.has_fees && c.students > 0).map((c) => ({ class: c.name, students: c.students })),
  };
}

/**
 * Sets the dates of ONE term for ONE school (making the year and its 3 terms first, if the year is new).
 *   dry: true             checks everything and writes NOTHING
 *   confirmStarted: true  needed when the start date is today or in the past (it starts billing now)
 * Returns { dry, unchanged, school, year, term, start, end, previous, createdYear, current, warnings, startsNow, preview, needsConfirmation, billed }.
 * Without confirmStarted a real save of a started term throws a 409 that carries e.preview and e.needsConfirmation.
 */
async function setTermDates({ schoolId, year, term, start, end, dry = false, confirmStarted = false, via = 'terms', actor = null }, deps = {}) {
  const sId = Number(schoolId);
  if (!Number.isInteger(sId) || sId < 1) throw refuse('Which school? A school number is needed to set its terms.');
  const v = validateTermInput({ year, term, start, end });
  const db = deps.pool || pool;
  const client = await db.connect();
  let result;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [LINE_UP_KEY, sId]);   // one change at a time for this school
    const school = (await client.query('SELECT id, name FROM schools WHERE id = $1', [sId])).rows[0];
    if (!school) throw refuse(`There is no school with number ${sId}.`, 404);
    const todayText = await today(client);

    // 1. Only a sensible window of years.
    const thisYear = Number(todayText.slice(0, 4));
    if (v.year < thisYear - 1 || v.year > thisYear + 2) {
      throw refuse(`${v.year} is outside the years that can be set (${thisYear - 1} to ${thisYear + 2}). Check the year you typed.`);
    }

    // 2. The year and its 3 term slots (shared, made once, no dates in them). The very first year ever becomes the system's current year.
    let createdYear = false;
    let yr = (await client.query('SELECT id FROM academic_years WHERE year = $1', [v.year])).rows[0];
    if (!yr) {
      const made = await client.query(
        `INSERT INTO academic_years (year, is_current)
         VALUES ($1, NOT EXISTS (SELECT 1 FROM academic_years WHERE is_current)) ON CONFLICT (year) DO NOTHING RETURNING id`, [v.year]);
      createdYear = made.rows.length > 0;
      yr = made.rows[0] || (await client.query('SELECT id FROM academic_years WHERE year = $1', [v.year])).rows[0];
    }
    for (const n of [1, 2, 3]) {
      await client.query('INSERT INTO terms (academic_year_id, term_number, is_current) VALUES ($1, $2, FALSE) ON CONFLICT (academic_year_id, term_number) DO NOTHING', [yr.id, n]);
    }
    const slot = (await client.query('SELECT id FROM terms WHERE academic_year_id = $1 AND term_number = $2', [yr.id, v.term])).rows[0];
    if (!slot) throw refuse(`${label({ term_number: v.term, year: v.year })} was not found, so nothing was changed.`, 409);

    const before = await loadSchoolTerms(client, sId);
    const me = before.find((t) => t.id === slot.id) || { id: slot.id, year: v.year, term_number: v.term, start_day: null, end_day: null, billed: false };
    const previousCurrent = pickCurrent(before, todayText);
    const previous = { start: me.start_day, end: me.end_day };
    const state = stateOf(me, todayText);

    // 3. Nothing to do?
    if (me.start_day === v.start && me.end_day === v.end) {
      await client.query('ROLLBACK');
      return { dry, unchanged: true, school, year: v.year, term: v.term, start: v.start, end: v.end, previous, createdYear: false, current: previousCurrent, warnings: [], startsNow: false, preview: null, needsConfirmation: false, billed: null };
    }

    // 4. The lock rules.
    if (state === 'ended') {
      throw refuse(`${label(me)} ended on ${me.end_day}, so its dates are locked.`, 409);
    }
    if ((state === 'running' || me.billed) && me.start_day !== v.start) {
      throw refuse(
        `${label(me)} already started on ${me.start_day}, so its start date is locked (fees are charged from it). ` +
        `You can still change the END date: keep ${me.start_day} as the start date.`, 409);
    }
    if (state === 'running' && v.end < todayText) {
      throw refuse(`${label(me)} is running, so its end date can not be before today (${todayText}). To end it today, use ${todayText}.`, 409);
    }

    // 5. Terms of this school stay in order and never overlap.
    const others = before.filter((t) => t.id !== me.id);
    for (const t of others.filter((x) => order(x) < order(me))) {
      const over = t.end_day || t.start_day;
      if (v.start <= over) {
        throw refuse(`${label(t)} ends on ${over}. ${label(me)} must start AFTER that, so you cannot use ${v.start}.`, 409);
      }
    }
    for (const t of others.filter((x) => order(x) > order(me))) {
      if (v.end >= t.start_day) {
        throw refuse(`${label(t)} starts on ${t.start_day}. ${label(me)} must end BEFORE that, so you cannot use ${v.end}.`, 409);
      }
    }

    // 6. A start date that is today or already past starts billing NOW: it needs a "yes", with the consequences shown first.
    const startsNow = v.start <= todayText && state !== 'running';
    let preview = null;
    const alreadyOver = v.end < todayText;
    if (startsNow) {
      preview = alreadyOver
        ? { classes: [], classesBilled: 0, studentsBilled: 0, waitingForFees: [], note: 'This term is already over. Nothing is billed for it; it only becomes the school\'s latest term.' }
        : await billingPreview(client, sId, v.term, me.id);
    }
    const needsConfirmation = startsNow && !confirmStarted;
    if (needsConfirmation && !dry) {
      const e = refuse(
        alreadyOver
          ? `${label(me)} would be saved as a term that is already over (${v.start} to ${v.end}). Dates that have been reached lock for good, so please confirm.`
          : `${label(me)} would start ${v.start <= todayText ? 'now' : ''} and billing runs straight away: ${preview.studentsBilled} students in ${preview.classesBilled} classes would be charged. Dates that have been reached lock for good, so please confirm.`, 409);
      e.needsConfirmation = true; e.preview = preview;
      throw e;
    }

    // 7. Save it.
    if (me.start_day) {
      await client.query('UPDATE school_term_dates SET start_date = $1, end_date = $2, updated_at = NOW() WHERE school_id = $3 AND term_id = $4', [v.start, v.end, sId, me.id]);
    } else {
      await client.query('INSERT INTO school_term_dates (school_id, term_id, start_date, end_date) VALUES ($1, $2, $3, $4)', [sId, me.id, v.start, v.end]);
    }
    const after = await loadSchoolTerms(client, sId);
    const current = pickCurrent(after, todayText);

    const warnings = [];
    if (current && current.id === me.id && (!previousCurrent || previousCurrent.id !== me.id)) {
      warnings.push(previousCurrent
        ? `${label(me)} is now the CURRENT term (it replaces ${label(previousCurrent)}). New payments are recorded against it.`
        : `${label(me)} is now the CURRENT term. New payments are recorded against it.`);
    }
    if (!current) warnings.push('No term has started yet, so there is no current term. Payments are saved but not added to balances until one starts.');
    if (!startsNow && v.start > todayText) warnings.push(`${label(me)} has not started. On ${v.start} the system bills it by itself (the fee structure is locked into the term at that moment).`);
    if (preview && preview.waitingForFees.length) {
      warnings.push('No fees are set yet for: ' + preview.waitingForFees.map((c) => `${c.class} (${c.students} students)`).join(', ') + '. They are billed as soon as fees are set.');
    }

    if (dry) await client.query('ROLLBACK'); else await client.query('COMMIT');
    result = { dry, unchanged: false, school, year: v.year, term: v.term, start: v.start, end: v.end, previous, createdYear, current, warnings, startsNow, preview, needsConfirmation: !!needsConfirmation, billed: null };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* the connection is already gone */ }
    throw err;
  } finally {
    client.release();
  }
  if (!result.dry) {
    await logAudit({ schoolId: sId, staffId: actor, action: 'terms_set', detail: { year: v.year, term: v.term, start: v.start, end: v.end, previous_start: result.previous.start, previous_end: result.previous.end, created_year: result.createdYear, via } });
    if (result.startsNow) {
      // the term is running: bill straight away instead of waiting for the hourly check (same once-only billing)
      try { result.billed = await billSchool(sId, { via: 'auto' }, deps); }
      catch (err) { result.billed = { error: err.message }; }
    }
  }
  return result;
}

/**
 * One school's calendar: the years it uses (this year always), each with Term 1, 2 and 3, their state, whether they
 * are billed, and what can still be changed. Also which term payments go to today.
 */
async function listTerms(schoolId, deps = {}) {
  const sId = Number(schoolId);
  const db = deps.pool || pool;
  const school = (await db.query('SELECT id, name FROM schools WHERE id = $1', [sId])).rows[0];
  if (!school) throw refuse(`There is no school with number ${sId}.`, 404);
  const todayText = await today(db);
  const thisYear = Number(todayText.slice(0, 4));
  const terms = await loadSchoolTerms(db, sId);
  const current = pickCurrent(terms, todayText);

  const years = [...new Set([thisYear, ...terms.map((t) => t.year)])].sort((a, b) => a - b);
  const out = [];
  for (const y of years) {
    const row = { year: y, terms: [] };
    for (const n of [1, 2, 3]) {
      const t = terms.find((x) => x.year === y && x.term_number === n);
      const state = t ? stateOf(t, todayText) : 'no dates';
      const item = {
        term: n, start: t ? t.start_day : null, end: t ? t.end_day : null, state,
        billed: !!(t && t.billed),
        paymentsGoHere: !!current && !!t && current.id === t.id,
        canChangeStart: state === 'no dates' || state === 'coming',
        canChangeEnd: state !== 'ended',
        billing: null,
      };
      if (t && state === 'running') {
        const p = await billingPreview(db, sId, n, t.id);
        item.billing = { classes: p.classes, waitingForFees: p.waitingForFees };
      }
      row.terms.push(item);
    }
    out.push(row);
  }
  return {
    today: todayText, school,
    current: current ? { year: current.year, term: current.term_number } : null,
    years: out,
  };
}

module.exports = { setTermDates, listTerms, validateTermInput, pickCurrent, stateOf, billingPreview, LINE_UP_KEY };