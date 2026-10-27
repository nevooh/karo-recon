/**
 * Admitting ONE student, the safe way.
 *
 * The Admit student screen (and anything else, later) calls these functions, so the rules live in one place.
 *
 * What it checks BEFORE saving anything:
 *   - Admission number and full name are filled in. Class is a must.
 *   - The class is switched ON for this school.
 *   - Streams: if the class has streams this year, one MUST be chosen and it must belong to that class
 *     and year. If the class has NO streams, no stream can be given (the screen hides the box).
 *   - The admission number is not used already in this school, and does not CLASH with one that is:
 *     the payment matcher reads "ADM343" and "343" as the same number (it only looks at the number
 *     part), so a payment saying 343 would match both students and always need a person.
 *   - Contacts (parents / guardians) are optional, any number, up to 10. Each needs a name or a phone.
 *   - Optional fees can only be ones the class really offers for the term the student starts in.
 *   - A starting balance (money owed, or paid ahead, before joining the system) is a number with at
 *     most 2 decimals.
 *
 * What it does, all or nothing (one database transaction, one change at a time per school):
 *   - saves the student, their contacts, their optional-fee choices (by NAME) and the starting balance
 *   - if the term they start in has already begun, bills them straight away (fees + starting balance),
 *     so they are not left at 0 for the whole term. If the term has not begun yet, the daily charge
 *     picks them up on the first day.
 *   - writes one line to the audit log (never phone numbers).
 *
 * "The term they start in": the running term. If the running term has already ended (school holiday),
 * the NEXT term that has dates. If no term has dates at all, admission is refused (set the terms first).
 *
 * dry: true does every check and changes NOTHING.
 */
const { pool } = require('../db/db');
const { logAudit } = require('./audit');
const { getSchoolActiveYear } = require('./promotion');
const { chargeStudentForTerm, getPreviousTerm, nameKey } = require('./feeLedger');
const { getClassFees, lockAndChargeClass } = require('./termBilling');
const { splitAdmission } = require('../matching/matcher');

const LINE_UP_KEY = 7771003;        // the same number classSetup.js and promotion.js use: moves, promotion and admissions line up per school
const MAX_CONTACTS = 10;
const MAX_OPTIONAL = 20;

function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const cleanText = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const hasControl = (s) => /[\u0000-\u001f\u007f]/.test(s);

/* ------------------------------------------------------------------ */
/* reading what the person typed                                       */
function cleanContacts(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw refuse('contacts must be a list.');
  const out = [];
  raw.forEach((c, i) => {
    const where = `Contact ${i + 1}`;
    if (c == null || typeof c !== 'object' || Array.isArray(c)) throw refuse(`${where} is not filled in properly.`);
    const name = cleanText(c.name);
    const phoneRaw = cleanText(c.phone);
    const relationship = cleanText(c.relationship);
    if (!name && !phoneRaw && !relationship) return;            // an empty row the person never used: ignored
    if (!name && !phoneRaw) throw refuse(`${where} needs a name or a phone number.`);
    if (name.length > 100 || hasControl(name)) throw refuse(`${where}: the name must be 100 characters or fewer.`);
    if (relationship.length > 30 || hasControl(relationship)) throw refuse(`${where}: the relationship must be 30 characters or fewer (for example Mother or Guardian).`);
    let phone = null;
    if (phoneRaw) {
      const squeezed = phoneRaw.replace(/[\s\-().]/g, '');
      if (!/^\+?\d{7,15}$/.test(squeezed)) throw refuse(`${where}: "${phoneRaw}" does not look like a phone number.`);
      phone = squeezed;
    }
    out.push({ name: name || null, phone, relationship: relationship || null });
  });
  if (out.length > MAX_CONTACTS) throw refuse(`A student can have at most ${MAX_CONTACTS} contacts.`);
  return out;
}

function cleanOptionalNames(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw refuse('optional_fees must be a list of fee names.');
  const seen = new Map();
  for (const item of raw) {
    if (typeof item !== 'string') throw refuse('optional_fees must be a list of fee names, for example ["Lunch", "Bus"].');
    const name = cleanText(item);
    if (!name) continue;
    if (name.length > 60 || hasControl(name)) throw refuse('A fee name must be 60 characters or fewer.');
    if (!seen.has(nameKey(name))) seen.set(nameKey(name), name);
  }
  if (seen.size > MAX_OPTIONAL) throw refuse(`At most ${MAX_OPTIONAL} optional fees can be chosen.`);
  return Array.from(seen.values());
}

function cleanStartingBalance(raw) {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) throw refuse('The starting balance must be a number, for example 12500.');
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) throw refuse('The starting balance can have at most 2 decimals.');
  if (Math.abs(n) > 100000000) throw refuse('That starting balance looks like a typing mistake.');
  return n === 0 ? null : Math.round(n * 100) / 100;
}

// New admission numbers are digits, with / or - inside if the school writes them that way: 215, 2024/015, 12-07. No letters.
// (Numbers that already exist with letters keep working everywhere; this only checks what is typed now.)
const ADMISSION_RE = /^[0-9][0-9/-]*$/;
function checkAdmissionFormat(no) {
  if (!ADMISSION_RE.test(no)) throw refuse('The admission number can only have digits, / and - (for example 215 or 2024/015). No letters.');
  return no;
}

// The number most schools would give the next student: the last NUMBER-style one admitted, plus 1 (the last group of digits goes up,
// leading zeros kept: 2024/015 -> 2024/016). Skips any number that is already taken or would be confused with one.
async function nextAdmissionNo(db, schoolId) {
  const rows = (await db.query('SELECT id, admission_no FROM students WHERE school_id = $1 ORDER BY id DESC', [schoolId])).rows;
  const last = rows.find((r) => ADMISSION_RE.test(r.admission_no));
  if (!last) return rows.length ? null : '1';
  let n = last.admission_no;
  for (let k = 0; k < 2000; k++) {
    n = n.replace(/(\d+)([^\d]*)$/, (m, d, tail) => { const up = String(BigInt(d) + 1n); return up.padStart(d.length, '0') + tail; });
    if (!findClash(rows, n) && n.length <= 40) return n;
  }
  return null;
}

function validateInput(input) {
  const i = input || {};
  const admissionNo = cleanText(i.admissionNo);
  if (!admissionNo) throw refuse('Enter the admission number.');
  if (admissionNo.length > 40 || hasControl(admissionNo)) throw refuse('The admission number must be 40 characters or fewer.');
  checkAdmissionFormat(admissionNo);
  const fullName = cleanText(i.fullName);
  if (fullName.length < 2) throw refuse('Enter the full name of the student.');
  if (fullName.length > 100 || hasControl(fullName)) throw refuse('The full name must be 100 characters or fewer.');
  if (!Number.isInteger(i.classId)) throw refuse('Choose the class. A student cannot be admitted without one.');
  if (i.streamId != null && !Number.isInteger(i.streamId)) throw refuse('The stream is not valid.');
  return {
    admissionNo, fullName, classId: i.classId, streamId: i.streamId == null ? null : i.streamId,
    contacts: cleanContacts(i.contacts),
    optionalNames: cleanOptionalNames(i.optionalFees),
    startingBalance: cleanStartingBalance(i.startingBalance),
  };
}

/* ------------------------------------------------------------------ */
/* the term a new student is first billed for                          */
// terms: [{ id, term_number, year, academic_year_id, start_day, end_day }], dates as 'YYYY-MM-DD' text
function pickStartTerm(terms, todayText) {
  const dated = terms.filter((t) => t.start_day).sort((a, b) => (a.start_day < b.start_day ? -1 : a.start_day > b.start_day ? 1 : 0));
  const started = dated.filter((t) => t.start_day <= todayText);
  const running = started.length ? started[started.length - 1] : null;
  if (running && (!running.end_day || running.end_day >= todayText)) return running;     // a term is running now
  const upcoming = dated.find((t) => t.start_day > todayText);                          // holiday: the next term
  return upcoming || running || null;
}

async function loadStartTerm(db, schoolId) {
  const today = (await db.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today`)).rows[0].today;
  const terms = (await db.query(
    `SELECT t.id, t.term_number, t.academic_year_id, ay.year,
            to_char(d.start_date, 'YYYY-MM-DD') AS start_day, to_char(d.end_date, 'YYYY-MM-DD') AS end_day
     FROM school_term_dates d JOIN terms t ON t.id = d.term_id JOIN academic_years ay ON ay.id = t.academic_year_id
     WHERE d.school_id = $1
     ORDER BY ay.year, t.term_number`, [schoolId]
  )).rows;
  return { today, term: pickStartTerm(terms, today) };
}

const NO_TERM = 'No term has dates yet, so there is nothing to bill the student for. Set the terms first (Academic years & terms).';

/* ------------------------------------------------------------------ */
/* what a class offers                                                 */
async function loadClass(db, schoolId, classId) {
  const r = await db.query(
    `SELECT c.id, c.name, COALESCE(sc.enabled, FALSE) AS enabled
     FROM classes c LEFT JOIN school_classes sc ON sc.class_id = c.id AND sc.school_id = $1
     WHERE c.id = $2`,
    [schoolId, classId]
  );
  const cls = r.rows[0];
  if (!cls) throw refuse('There is no such class.', 404);
  if (!cls.enabled) throw refuse(`${cls.name} is switched off for this school. Switch it on first: node src/scripts/set-classes.js "<school>" on "${cls.name}"`, 409);
  return cls;
}

async function loadStreams(db, schoolId, classId, yearId) {
  const r = await db.query(
    `SELECT id, name FROM streams WHERE school_id = $1 AND class_id = $2 AND academic_year_id = $3 ORDER BY lower(name)`,
    [schoolId, classId, yearId]
  );
  return r.rows;
}

// The optional fees this class offers in this term, one line per name. If the class is already billed for the
// term these are the LOCKED ones (final); otherwise the latest version of the class's fees for that term number.
async function loadOptionalFees(db, schoolId, classId, term) {
  if (!term) return [];
  const fees = await getClassFees(db, schoolId, classId, term);
  return fees.items.filter((i) => !i.is_mandatory).map((i) => ({ name: i.name, amount: Number(i.amount) })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Everything the Admit screen needs once a class is chosen: does it need a stream (and which), and which
 * optional fees does it offer. Changes nothing.
 */
async function getAdmissionOptions(schoolId, classId, deps = {}) {
  const db = deps.pool || pool;
  const school = (await db.query('SELECT id, name FROM schools WHERE id = $1', [schoolId])).rows[0];
  if (!school) throw refuse(`There is no school with number ${schoolId}.`, 404);
  if (!Number.isInteger(classId)) throw refuse('Choose a class first.');
  const cls = await loadClass(db, schoolId, classId);
  const year = await getSchoolActiveYear(schoolId, db);
  if (!year) throw refuse('There is no academic year yet. Set the terms first (Academic years & terms).', 409);
  const streams = await loadStreams(db, schoolId, classId, year.id);
  const { term } = await loadStartTerm(db, schoolId);
  const optional = await loadOptionalFees(db, schoolId, classId, term);
  return {
    class: { id: cls.id, name: cls.name },
    year: { id: year.id, year: year.year },
    needs_stream: streams.length > 0,
    streams: streams.map((s) => ({ id: s.id, name: s.name })),
    term: term ? { id: term.id, term_number: term.term_number, year: term.year, starts: term.start_day } : null,
    optional_fees: optional.map((o) => ({ name: o.name, amount: o.amount })),
    next_admission_no: await nextAdmissionNo(db, schoolId),
  };
}

/* ------------------------------------------------------------------ */
/* the admission itself                                                */
async function inTransaction(deps, schoolId, dry, work) {
  const db = deps.pool || pool;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [LINE_UP_KEY, schoolId]);
    const school = (await client.query('SELECT id, name FROM schools WHERE id = $1', [schoolId])).rows[0];
    if (!school) throw refuse(`There is no school with number ${schoolId}.`, 404);
    const out = await work(client, school);
    await client.query(dry ? 'ROLLBACK' : 'COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* the connection is already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

// Same number, or a number the payment matcher cannot tell apart from an existing one?
function findClash(existing, admissionNo) {
  const mine = nameKey(admissionNo);
  const myKey = splitAdmission(admissionNo).key.join('/');
  for (const s of existing) {
    if (nameKey(s.admission_no) === mine) return { kind: 'same', student: s };
  }
  for (const s of existing) {
    if (splitAdmission(s.admission_no).key.join('/') === myKey) return { kind: 'clash', student: s };
  }
  return null;
}

/**
 * input: { admissionNo, fullName, classId, streamId?, contacts?: [{name, phone, relationship}],
 *          optionalFees?: ['Lunch', 'Bus'], startingBalance? }
 * Returns { dry, student, contacts, optional_fees, starting_balance, term, billed } or throws an Error with .status.
 */
async function admitStudent(schoolId, input, { dry = false, staffId = null } = {}, deps = {}) {
  const v = validateInput(input);
  let result;
  await inTransaction(deps, schoolId, dry, async (client) => {
    const cls = await loadClass(client, schoolId, v.classId);

    const year = await getSchoolActiveYear(schoolId, client);
    if (!year) throw refuse('There is no academic year yet. Set the terms first (Academic years & terms).', 409);

    // streams: required when the class has them, not allowed when it has none
    const streams = await loadStreams(client, schoolId, cls.id, year.id);
    let stream = null;
    if (streams.length > 0) {
      if (v.streamId == null) throw refuse(`Choose a stream for ${cls.name}: ${streams.map((s) => s.name).join(', ')}.`);
      stream = streams.find((s) => s.id === v.streamId);
      if (!stream) throw refuse(`That stream is not part of ${cls.name} for ${year.year}. Choose one of: ${streams.map((s) => s.name).join(', ')}.`);
    } else if (v.streamId != null) {
      throw refuse(`${cls.name} has no streams for ${year.year}, so no stream can be chosen.`);
    }

    // the admission number
    const existing = (await client.query(`SELECT id, admission_no, full_name FROM students WHERE school_id = $1`, [schoolId])).rows;
    const clash = findClash(existing, v.admissionNo);
    if (clash && clash.kind === 'same') throw refuse(`Admission number ${clash.student.admission_no} is already used by ${clash.student.full_name}.`, 409);
    if (clash) {
      throw refuse(`"${v.admissionNo}" would be confused with "${clash.student.admission_no}" (${clash.student.full_name}): a payment that mentions the number matches both students. Use a different admission number.`, 409);
    }

    // the term they start in, and the optional fees on offer there
    const { today, term } = await loadStartTerm(client, schoolId);
    if (!term) throw refuse(NO_TERM, 409);
    const offered = await loadOptionalFees(client, schoolId, cls.id, term);
    const chosen = v.optionalNames.map((name) => {
      const hit = offered.find((o) => nameKey(o.name) === nameKey(name));
      if (!hit) {
        throw refuse(`${cls.name} does not offer "${name}"` + (offered.length ? `. It offers: ${offered.map((o) => o.name).join(', ')}.` : ' (it has no optional fees set up for this term).'));
      }
      return hit.name;                                                    // the school's own spelling
    });

    // save
    const first = v.contacts[0] || null;
    let student;
    try {
      student = (await client.query(
        `INSERT INTO students (school_id, admission_no, full_name, class_id, stream_id, guardian_name, guardian_phone, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active') RETURNING id, admission_no, full_name, class_id, stream_id`,
        [schoolId, v.admissionNo, v.fullName, cls.id, stream ? stream.id : null, first ? first.name : null, first ? first.phone : null]
      )).rows[0];
    } catch (e) {
      if (e.code === '23505') throw refuse(`Admission number ${v.admissionNo} is already used in this school.`, 409);
      throw e;
    }
    for (let i = 0; i < v.contacts.length; i++) {
      const c = v.contacts[i];
      await client.query(
        `INSERT INTO student_contacts (student_id, full_name, phone, relationship, sort_order) VALUES ($1, $2, $3, $4, $5)`,
        [student.id, c.name, c.phone, c.relationship, i]
      );
    }
    for (const name of chosen) {
      await client.query(`INSERT INTO student_optional_choices (student_id, name, name_key) VALUES ($1, $2, $3)`, [student.id, name, nameKey(name)]);
    }
    if (v.startingBalance != null) {
      await client.query(`INSERT INTO student_starting_balance (student_id, term_id, amount) VALUES ($1, $2, $3)`, [student.id, term.id, v.startingBalance]);
    }

    // bill now if the term has already begun (otherwise billing does it by itself on the first day).
    // If the class is not locked for this term yet and has fees, locking it charges the class, new student included.
    let billed = null;
    if (term.start_day <= today) {
      const running = !term.end_day || term.end_day >= today;
      if (running) await lockAndChargeClass(client, schoolId, term, cls);
      const previous = await getPreviousTerm(term, client);
      const b = await chargeStudentForTerm(client, { id: student.id, school_id: schoolId, class_id: cls.id }, term, previous);
      billed = { fees: b.feesCharged, starting_balance: b.openingBalance, owed: b.feesCharged + b.openingBalance };
    }

    result = {
      dry,
      student: { id: student.id, admission_no: student.admission_no, full_name: student.full_name, class: cls.name, stream: stream ? stream.name : null },
      contacts: v.contacts.length,
      optional_fees: chosen,
      starting_balance: v.startingBalance,
      term: { id: term.id, term_number: term.term_number, year: term.year, started: term.start_day <= today },
      billed,
    };
    return {};
  });
  if (!dry) {
    await logAudit({
      schoolId, staffId, action: 'student_admitted',
      detail: {
        student_id: result.student.id, class: result.student.class, stream: result.student.stream, term_id: result.term.id,
        contacts: result.contacts, optional_fees: result.optional_fees, starting_balance: result.starting_balance, billed_now: !!result.billed,
      },
    });
  }
  return result;
}

module.exports = { checkAdmissionFormat, nextAdmissionNo, admitStudent, getAdmissionOptions, validateInput, pickStartTerm, findClash, cleanContacts, cleanText, MAX_CONTACTS, LINE_UP_KEY };