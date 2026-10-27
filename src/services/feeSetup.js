/**
 * The FEE STRUCTURE: a reusable template of what each class pays in Term 1, 2 and 3. From the terminal today and
 * from the screens later (same engine).
 *
 * The rules (decided by the owner):
 *   - A template is for one school + one class + one TERM NUMBER (1, 2 or 3). It has NO year: set it once and it is
 *     reused every year. Term 3 is shorter, so each term has its own prices.
 *   - It can be edited ANY day. Editing never changes a term that is already billed: billing (termBilling.js)
 *     copies a pointer to the latest version into that term and locks it there until the term is over.
 *   - Every save is a NEW VERSION. Old versions are never changed or deleted (a database trigger refuses it).
 *     The newest version is the "latest" and is shown first. Saving the same list again changes nothing.
 *   - A class's fees come in two kinds, saved together in one version:
 *       mandatory  paid by every student in the class                       Tuition=50000
 *       optional   a parent chooses it when the student is admitted         Lunch=3000
 *     A class has an optional fee in a term only if it is in that class's version for that term. No fee, no row.
 *   - The school keeps ONE list of its optional fee NAMES (Lunch, Bus ...). A class's optional fee is CHOSEN from that
 *     list (or the name is added in the same step with newOptional), so "Bus" can never turn into "Buss".
 *   - Removing an optional fee that students have chosen would make them lose it at the next billing: refused unless
 *     allowDrop is given, and it says how many students are affected.
 *   - Only classes the school has switched ON can have fees.
 *   - All or nothing: one transaction, one change at a time per school. dry: true changes nothing.
 */
const { pool } = require('../db/db');
const { logAudit } = require('./audit');
const { nameKey } = require('./feeLedger');
const { resolveClasses } = require('./classSetup');
const { LINE_UP_KEY } = require('./termBilling');

const MAX_AMOUNT = 10000000;
const MAX_ITEMS = 30;
const TERMS = [1, 2, 3];

function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const cleanText = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const hasControl = (s) => /[\u0000-\u001f\u007f]/.test(s);
const money = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

/* ------------------------------------------------------------------ */
/* reading what is typed                                               */
function parseAmount(raw, what) {
  const text = String(raw == null ? '' : raw).replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw refuse(`${what}: "${raw}" is not an amount. Write it like 50000 or 2500.50.`);
  const n = Number(text);
  if (n <= 0) throw refuse(`${what}: the amount must be more than 0.`);
  if (n > MAX_AMOUNT) throw refuse(`${what}: ${money(n)} looks like a typing mistake.`);
  return n;
}

function cleanFeeName(raw, what) {
  const name = cleanText(raw);
  if (!name) throw refuse(`${what} needs a name.`);
  if (name.length > 60 || hasControl(name)) throw refuse(`${what}: a fee name must be 60 characters or fewer.`);
  return name;
}

// "Tuition=50000" or { name, amount } -> { name, amount }
function parseItem(item, kind) {
  if (typeof item === 'string') {
    const at = item.lastIndexOf('=');
    if (at < 1) throw refuse(`"${item}" is not written right. Write the name, an equals sign, then the amount: ${kind === 'optional' ? 'Lunch=3000' : 'Tuition=50000'}.`);
    const name = cleanFeeName(item.slice(0, at), `"${item}"`);
    return { name, amount: parseAmount(item.slice(at + 1), `"${item}"`) };
  }
  if (item && typeof item === 'object') {
    const name = cleanFeeName(item.name, 'A fee');
    return { name, amount: parseAmount(item.amount, `"${name}"`) };
  }
  throw refuse('A fee must be written like Tuition=50000.');
}

function parseItems(list, kind) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw refuse('The fees must be a list.');
  return list.map((i) => parseItem(i, kind));
}

function checkNoDuplicates(mandatory, optional) {
  const seen = new Set();
  for (const it of [...mandatory, ...optional]) {
    const k = nameKey(it.name);
    if (seen.has(k)) throw refuse(`"${it.name}" is written twice. A fee name can appear only once in a class's list, as either a fee everyone pays or an optional one.`);
    seen.add(k);
  }
  if (mandatory.length + optional.length === 0) throw refuse('Give at least one fee, for example --fee "Tuition=50000".');
  if (mandatory.length + optional.length > MAX_ITEMS) throw refuse(`A class can have at most ${MAX_ITEMS} fees.`);
}

function parseTerm(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 3) throw refuse(`"${raw}" is not a term. Use 1, 2 or 3.`);
  return n;
}

function parseTerms(raw) {
  const list = (Array.isArray(raw) ? raw : [raw]).map(parseTerm);
  if (!list.length) throw refuse('Say which terms: 1, 2 or 3.');
  return Array.from(new Set(list)).sort();
}

/* ------------------------------------------------------------------ */
/* classes                                                             */
async function loadSchoolClasses(db, schoolId) {
  return (await db.query(
    `SELECT c.id, c.name, c.sort_order, COALESCE(sc.enabled, FALSE) AS enabled
     FROM classes c LEFT JOIN school_classes sc ON sc.class_id = c.id AND sc.school_id = $1
     ORDER BY c.sort_order`,
    [schoolId]
  )).rows;
}

const offMessage = (off) => `${off.map((c) => c.name).join(', ')} ${off.length === 1 ? 'is' : 'are'} switched off for this school, so ${off.length === 1 ? 'it' : 'they'} cannot have fees.`;

// "Grade 1,Grade 2" or "Grade 1..Grade 3" (every switched-on class between, ends included) -> class rows.
// (The .. form is only a typing shortcut for the terminal. The screens show one card per class.)
function expandClasses(all, specs) {
  const parts = [];
  for (const spec of (Array.isArray(specs) ? specs : [specs])) {
    for (const piece of String(spec == null ? '' : spec).split(',')) {
      const t = cleanText(piece);
      if (t) parts.push(t);
    }
  }
  if (!parts.length) throw refuse('Say which classes, for example: "Grade 1,Grade 2" or "Grade 1..Grade 3".');
  const names = [];
  for (const p of parts) {
    if (p.includes('..')) {
      const [a, b] = p.split('..').map(cleanText);
      const [first] = resolveClasses(all, [a]);
      const [last] = resolveClasses(all, [b]);
      const lo = Math.min(first.sort_order, last.sort_order), hi = Math.max(first.sort_order, last.sort_order);
      for (const c of all) if (c.sort_order >= lo && c.sort_order <= hi && (c.enabled || c.id === first.id || c.id === last.id)) names.push(c.name);
    } else names.push(p);
  }
  const found = resolveClasses(all, names);
  const off = found.filter((c) => !c.enabled);
  if (off.length) throw refuse(`${offMessage(off)} Switch on first: node src/scripts/set-classes.js "<school>" on "${off[0].name}"`, 409);
  return found;
}

// Classes given by id (what a screen sends) instead of by name.
function classesByIds(all, ids) {
  if (!Array.isArray(ids) || !ids.length || !ids.every((n) => Number.isInteger(n))) throw refuse('Choose at least one class.');
  const found = [];
  for (const id of ids) {
    const c = all.find((x) => x.id === id);
    if (!c) throw refuse('One of the chosen classes does not exist.');
    if (!found.includes(c)) found.push(c);
  }
  const off = found.filter((c) => !c.enabled);
  if (off.length) throw refuse(offMessage(off), 409);
  return found.sort((a, b) => a.sort_order - b.sort_order);
}
const pickClasses = (all, input, idsKey = 'classIds', namesKey = 'classNames') => (input[idsKey] ? classesByIds(all, input[idsKey]) : expandClasses(all, input[namesKey]));

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

async function mustHaveSchool(db, schoolId) {
  const school = (await db.query('SELECT id, name FROM schools WHERE id = $1', [schoolId])).rows[0];
  if (!school) throw refuse(`There is no school with number ${schoolId}.`, 404);
  return school;
}

/* ------------------------------------------------------------------ */
/* reading templates                                                   */
const shape = (rows) => ({
  mandatory: rows.filter((r) => r.is_mandatory).map((r) => ({ name: r.name, amount: Number(r.amount) })),
  optional: rows.filter((r) => !r.is_mandatory).map((r) => ({ name: r.name, amount: Number(r.amount) })),
});
const sum = (list) => list.reduce((a, i) => a + Number(i.amount), 0);
const totals = (s) => ({ mandatory_total: sum(s.mandatory), optional_total: sum(s.optional), grand_total: sum(s.mandatory) + sum(s.optional) });

/** The LATEST version of every template of a school: Map "classId|term" -> { id, version, created, mandatory, optional }. */
async function loadLatest(db, schoolId, classId) {
  const params = [schoolId];
  let only = '';
  if (classId != null) { params.push(classId); only = ' AND class_id = $2'; }
  const heads = (await db.query(
    `SELECT DISTINCT ON (class_id, term_number) id, class_id, term_number, version, to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created
     FROM fee_templates WHERE school_id = $1${only} ORDER BY class_id, term_number, version DESC`,
    params
  )).rows;
  const map = new Map();
  if (!heads.length) return map;
  const items = (await db.query(
    `SELECT template_id, name, amount, is_mandatory FROM fee_template_items WHERE template_id = ANY($1) ORDER BY is_mandatory DESC, id`,
    [heads.map((h) => h.id)]
  )).rows;
  for (const h of heads) {
    map.set(`${h.class_id}|${h.term_number}`, { id: h.id, version: h.version, created: h.created, ...shape(items.filter((i) => i.template_id === h.id)) });
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* the school's list of optional fee names                             */
async function loadCatalog(db, schoolId) {
  return (await db.query(`SELECT id, name, name_key FROM school_optional_fees WHERE school_id = $1 ORDER BY lower(name)`, [schoolId])).rows;
}

async function listOptionalNames(schoolId, deps = {}) {
  const db = deps.pool || pool;
  const school = await mustHaveSchool(db, schoolId);
  return { school, names: (await loadCatalog(db, schoolId)).map((r) => r.name) };
}

async function addOptionalName(schoolId, rawName, { dry = false } = {}, deps = {}) {
  const name = cleanFeeName(rawName, 'The optional fee');
  const result = await inTransaction(deps, schoolId, dry, async (client) => {
    const have = (await loadCatalog(client, schoolId)).find((r) => r.name_key === nameKey(name));
    if (have) throw refuse(`"${have.name}" is already on this school's optional fee list.`, 409);
    await client.query(`INSERT INTO school_optional_fees (school_id, name, name_key) VALUES ($1, $2, $3)`, [schoolId, name, nameKey(name)]);
    return { dry, name };
  });
  if (!dry) await logAudit({ schoolId, action: 'optional_fee_name_added', detail: { name, via: 'set-fees' } });
  return result;
}

async function removeOptionalName(schoolId, rawName, { dry = false } = {}, deps = {}) {
  const key = nameKey(rawName);
  const result = await inTransaction(deps, schoolId, dry, async (client) => {
    const have = (await loadCatalog(client, schoolId)).find((r) => r.name_key === key);
    if (!have) throw refuse(`"${cleanText(rawName)}" is not on this school's optional fee list.`, 404);
    const latest = await loadLatest(client, schoolId);
    let inFees = 0;
    for (const t of latest.values()) if (t.optional.some((o) => nameKey(o.name) === key)) inFees++;
    const chosen = (await client.query(
      `SELECT COUNT(*)::int AS n FROM student_optional_choices c JOIN students s ON s.id = c.student_id WHERE s.school_id = $1 AND c.name_key = $2`,
      [schoolId, key]
    )).rows[0].n;
    if (inFees || chosen) {
      throw refuse(`"${have.name}" is still in use` + (inFees ? ` in ${inFees} class fee ${inFees === 1 ? 'list' : 'lists'}` : '') + (chosen ? `${inFees ? ' and' : ''} chosen by ${chosen} ${chosen === 1 ? 'student' : 'students'}` : '') + '. It can be removed from the list once nothing uses it.', 409);
    }
    await client.query(`DELETE FROM school_optional_fees WHERE id = $1`, [have.id]);
    return { dry, name: have.name };
  });
  if (!dry) await logAudit({ schoolId, action: 'optional_fee_name_removed', detail: { name: result.name, via: 'set-fees' } });
  return result;
}

// Optional names must be on the school's list: chosen from it, or added in the same step (newOptional).
async function resolveOptional(client, schoolId, optional, newOptional) {
  const catalog = await loadCatalog(client, schoolId);
  const added = [];
  const resolved = [];
  for (const it of optional) {
    const have = catalog.find((r) => r.name_key === nameKey(it.name));
    if (have) { resolved.push({ name: have.name, amount: it.amount }); continue; }
    if (!newOptional) {
      throw refuse(`"${it.name}" is not on this school's optional fee list` + (catalog.length ? ` (it has: ${catalog.map((r) => r.name).join(', ')})` : ' (the list is empty)') +
        `. Add it with: set-fees.js "<school>" optional add "${it.name}"   or add --new to add it while setting the fees.`);
    }
    await client.query(`INSERT INTO school_optional_fees (school_id, name, name_key) VALUES ($1, $2, $3)`, [schoolId, it.name, nameKey(it.name)]);
    catalog.push({ name: it.name, name_key: nameKey(it.name) });
    added.push(it.name);
    resolved.push(it);
  }
  return { resolved, added };
}

/* ------------------------------------------------------------------ */
/* saving: a new version of one class's fees for one term number       */
const sig = (m, name, amount) => `${m ? 'M' : 'O'}|${nameKey(name)}|${Number(amount)}`;
const sameList = (cur, mandatory, optional) => {
  const before = cur ? [...cur.mandatory.map((i) => sig(true, i.name, i.amount)), ...cur.optional.map((i) => sig(false, i.name, i.amount))] : [];
  const after = [...mandatory.map((i) => sig(true, i.name, i.amount)), ...optional.map((i) => sig(false, i.name, i.amount))];
  return before.sort().join('\n') === after.sort().join('\n');
};

async function saveVersion(client, { schoolId, cls, termNumber, mandatory, optional, allowDrop, latest }) {
  const cur = latest.get(`${cls.id}|${termNumber}`) || null;
  if (cur && sameList(cur, mandatory, optional)) return { class: cls.name, term: termNumber, unchanged: true, version: cur.version, mandatory, optional, drops: [] };

  // an optional fee that leaves the list would be dropped from every student who chose it, at the next billing
  let drops = [];
  if (cur) {
    const keep = new Set(optional.map((i) => nameKey(i.name)));
    const leaving = cur.optional.filter((o) => !keep.has(nameKey(o.name)));
    if (leaving.length) {
      const rows = (await client.query(
        `SELECT c.name_key, COUNT(*)::int AS n FROM student_optional_choices c JOIN students s ON s.id = c.student_id
         WHERE s.school_id = $1 AND s.class_id = $2 AND s.status = 'active' AND c.name_key = ANY($3) GROUP BY c.name_key`,
        [schoolId, cls.id, leaving.map((o) => nameKey(o.name))]
      )).rows;
      drops = rows.map((r) => ({ name: leaving.find((l) => nameKey(l.name) === r.name_key).name, students: r.n }));
    }
  }
  if (drops.length && !allowDrop) {
    const e = refuse(`${cls.name} Term ${termNumber}: ` + drops.map((d) => `${d.students} ${d.students === 1 ? 'student has' : 'students have'} chosen "${d.name}"`).join(' and ') +
      `. If it leaves the list they lose it at the next billing. If that is what you want, add --allow-drop.`, 409);
    e.drops = drops.map((d) => ({ ...d, cls: cls.name }));
    throw e;
  }

  const version = cur ? cur.version + 1 : 1;
  const tpl = (await client.query(
    `INSERT INTO fee_templates (school_id, class_id, term_number, version) VALUES ($1, $2, $3, $4) RETURNING id`,
    [schoolId, cls.id, termNumber, version]
  )).rows[0];
  for (const it of mandatory) await client.query(`INSERT INTO fee_template_items (template_id, name, amount, is_mandatory) VALUES ($1, $2, $3, TRUE)`, [tpl.id, it.name, it.amount]);
  for (const it of optional) await client.query(`INSERT INTO fee_template_items (template_id, name, amount, is_mandatory) VALUES ($1, $2, $3, FALSE)`, [tpl.id, it.name, it.amount]);
  latest.set(`${cls.id}|${termNumber}`, { id: tpl.id, version, mandatory, optional });
  return { class: cls.name, term: termNumber, unchanged: false, version, previous: cur ? cur.version : null, mandatory, optional, drops };
}

/**
 * Sets the fees of one or more classes for one term number (a NEW version for each class that really changes).
 * input: { classNames: ['Grade 1,Grade 2'] or classIds: [3,4], term: 1|2|3 (or terms: [1,2,3]),
 *          fees: ['Tuition=50000'], optional: ['Lunch=3000'], newOptional, allowDrop, dry }
 */
async function setFees(schoolId, input, deps = {}) {
  const { dry = false, newOptional = false, allowDrop = false } = input;
  const mandatory = parseItems(input.fees, 'mandatory');
  const optional = parseItems(input.optional, 'optional');
  checkNoDuplicates(mandatory, optional);
  const terms = parseTerms(input.terms != null ? input.terms : input.term);
  let result;
  await inTransaction(deps, schoolId, dry, async (client, school) => {
    const classes = pickClasses(await loadSchoolClasses(client, schoolId), input);
    const { resolved, added } = await resolveOptional(client, schoolId, optional, newOptional);
    const latest = await loadLatest(client, schoolId);
    const done = [];
    for (const cls of classes) for (const t of terms) done.push(await saveVersion(client, { schoolId, cls, termNumber: t, mandatory, optional: resolved, allowDrop, latest }));
    result = { dry, school, terms, classes: done, addedToList: added };
    return {};
  });
  if (!dry && result.classes.some((c) => !c.unchanged)) {
    await logAudit({
      schoolId, action: 'fees_set',
      detail: { terms, changed: result.classes.filter((c) => !c.unchanged).map((c) => `${c.class} T${c.term} v${c.version}`), fees: mandatory.length, optional: optional.length, added_to_list: result.addedToList },
    });
  }
  return result;
}

/**
 * Copies the LATEST fees of one class + term onto other classes and/or other terms (each becomes a new version
 * only if it really differs). Handy because most schools charge the same in every term.
 * input: { fromClass: 'Grade 1' | fromClassId: 3, fromTerm: 1, toClasses: ['Grade 2,Grade 3'] | toClassIds: [4,5]  (default: the same class),
 *          toTerms: [2,3] (default: the same term), allowDrop, dry }
 */
async function copyFees(schoolId, input, deps = {}) {
  const { dry = false, allowDrop = false } = input;
  const fromTerm = parseTerm(input.fromTerm);
  let result;
  await inTransaction(deps, schoolId, dry, async (client, school) => {
    const all = await loadSchoolClasses(client, schoolId);
    const from = input.fromClassId != null ? classesByIds(all, [input.fromClassId])[0] : expandClasses(all, [input.fromClass])[0];
    const hasTargetClasses = (input.toClassIds && input.toClassIds.length) || (input.toClasses && input.toClasses.length);
    const targetClasses = hasTargetClasses ? pickClasses(all, input, 'toClassIds', 'toClasses') : [from];
    const targetTerms = input.toTerms != null && (!Array.isArray(input.toTerms) || input.toTerms.length) ? parseTerms(input.toTerms) : [fromTerm];
    const latest = await loadLatest(client, schoolId);
    const src = latest.get(`${from.id}|${fromTerm}`);
    if (!src) throw refuse(`${from.name} has no fees set for Term ${fromTerm}, so there is nothing to copy.`, 409);
    const pairs = [];
    for (const c of targetClasses) for (const t of targetTerms) if (!(c.id === from.id && t === fromTerm)) pairs.push({ c, t });
    if (!pairs.length) throw refuse('Nothing to copy to: choose another class or another term.');
    const { added } = await resolveOptional(client, schoolId, src.optional.map((o) => ({ name: o.name, amount: o.amount })), true);
    const done = [];
    for (const p of pairs) done.push(await saveVersion(client, { schoolId, cls: p.c, termNumber: p.t, mandatory: src.mandatory, optional: src.optional, allowDrop, latest }));
    result = { dry, school, from: { class: from.name, term: fromTerm, version: src.version }, classes: done, addedToList: added };
    return {};
  });
  if (!dry && result.classes.some((c) => !c.unchanged)) {
    await logAudit({ schoolId, action: 'fees_copied', detail: { from: `${result.from.class} T${result.from.term} v${result.from.version}`, changed: result.classes.filter((c) => !c.unchanged).map((c) => `${c.class} T${c.term} v${c.version}`) } });
  }
  return result;
}

/**
 * The Optional fees page writes here: set (or clear) one optional fee's price for classes and terms.
 * input: { name: 'Lunch', prices: [{ classId, term, amount }], dry, allowDrop }   amount null/'' = this class does not offer it that term.
 * Each affected class + term gets a new version of its fees (the mandatory fees are carried over unchanged), so the
 * fee structure page shows the optional fee by itself, and the history shows who-changed-what.
 */
async function setOptionalPrices(schoolId, input, deps = {}) {
  const { dry = false, allowDrop = false } = input;
  if (!Array.isArray(input.prices) || !input.prices.length) throw refuse('Give at least one class and term.');
  if (input.prices.length > 200) throw refuse('Too many changes in one go.');
  let result;
  await inTransaction(deps, schoolId, dry, async (client, school) => {
    const catalog = await loadCatalog(client, schoolId);
    const have = catalog.find((r) => r.name_key === nameKey(input.name));
    if (!have) throw refuse(`"${cleanText(input.name)}" is not on this school's optional fee list.` + (catalog.length ? ` It has: ${catalog.map((r) => r.name).join(', ')}.` : ' The list is empty.'), 404);
    const all = await loadSchoolClasses(client, schoolId);
    const latest = await loadLatest(client, schoolId);
    const wanted = new Map();
    for (const p of input.prices) {
      const cls = classesByIds(all, [p.classId])[0];
      const t = parseTerm(p.term);
      const blank = p.amount === null || p.amount === undefined || String(p.amount).trim() === '';
      wanted.set(`${cls.id}|${t}`, { cls, t, amount: blank ? null : parseAmount(p.amount, `${cls.name} Term ${t}`) });
    }
    const done = [];
    for (const w of wanted.values()) {
      const cur = latest.get(`${w.cls.id}|${w.t}`) || { mandatory: [], optional: [] };
      const optional = cur.optional.filter((o) => nameKey(o.name) !== have.name_key);
      if (w.amount != null) optional.push({ name: have.name, amount: w.amount });
      if (!cur.mandatory.length && !optional.length) {
        if (!latest.has(`${w.cls.id}|${w.t}`)) continue;                      // nothing there, nothing to clear
        throw refuse(`${w.cls.name} Term ${w.t} would be left with no fees at all. Set its mandatory fees first, or keep this optional fee.`, 409);
      }
      done.push(await saveVersion(client, { schoolId, cls: w.cls, termNumber: w.t, mandatory: cur.mandatory, optional, allowDrop, latest }));
    }
    result = { dry, school, name: have.name, classes: done };
    return {};
  });
  if (!dry && result.classes.some((c) => !c.unchanged)) {
    await logAudit({ schoolId, action: 'optional_prices_set', detail: { name: result.name, changed: result.classes.filter((c) => !c.unchanged).map((c) => `${c.class} T${c.term} v${c.version}`) } });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* showing things                                                      */

/**
 * The fee structure home: one card per class the school runs, each with its three terms (version and totals).
 * Classes with no fees set at all are included so the screen can say "not set".
 */
async function overview(schoolId, deps = {}) {
  const db = deps.pool || pool;
  const school = await mustHaveSchool(db, schoolId);
  const classes = (await loadSchoolClasses(db, schoolId)).filter((c) => c.enabled);
  const latest = await loadLatest(db, schoolId);
  return {
    school,
    classes: classes.map((c) => ({
      id: c.id, name: c.name,
      terms: TERMS.map((t) => {
        const cur = latest.get(`${c.id}|${t}`);
        return cur ? { term: t, set: true, version: cur.version, ...totals(cur) } : { term: t, set: false, version: null, mandatory_total: 0, optional_total: 0, grand_total: 0 };
      }),
    })),
  };
}

// What changed between two versions of a class's fee list, in plain facts.
function diffItems(older, newer) {
  const changes = [];
  const map = (list) => new Map(list.map((i) => [nameKey(i.name), i]));
  const a = map(older), b = map(newer);
  for (const [k, n] of b) {
    const o = a.get(k);
    if (!o) changes.push({ kind: 'added', name: n.name, to: n.amount, optional: !n.is_mandatory });
    else if (Number(o.amount) !== Number(n.amount)) changes.push({ kind: 'price', name: n.name, from: Number(o.amount), to: Number(n.amount), optional: !n.is_mandatory });
    else if (!!o.is_mandatory !== !!n.is_mandatory) changes.push({ kind: n.is_mandatory ? 'now_mandatory' : 'now_optional', name: n.name });
  }
  for (const [k, o] of a) if (!b.has(k)) changes.push({ kind: 'removed', name: o.name, from: Number(o.amount), optional: !o.is_mandatory });
  return changes;
}

/**
 * One class's page: the three terms (tabs, each with its latest fees, totals and history, newest version first),
 * and which real terms each version was locked into by billing.
 * Returns { school, class, terms: [{ term, set, latest: { version, created, mandatory, optional, ...totals } | null,
 *           versions: [{ version, current, created, items, changes }], locked: [{ label, version }] }] }
 */
async function classFees(schoolId, classId, deps = {}) {
  const db = deps.pool || pool;
  const school = await mustHaveSchool(db, schoolId);
  if (!Number.isInteger(classId)) throw refuse('Choose a class.');
  const cls = (await loadSchoolClasses(db, schoolId)).find((c) => c.id === classId);
  if (!cls) throw refuse('There is no such class.', 404);
  const tpls = (await db.query(
    `SELECT id, term_number, version, to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created FROM fee_templates
     WHERE school_id = $1 AND class_id = $2 ORDER BY term_number, version DESC`,
    [schoolId, classId]
  )).rows;
  const items = tpls.length ? (await db.query(
    `SELECT template_id, name, amount, is_mandatory FROM fee_template_items WHERE template_id = ANY($1) ORDER BY is_mandatory DESC, id`,
    [tpls.map((t) => t.id)]
  )).rows : [];
  const locks = (await db.query(
    `SELECT t.term_number, ay.year, ft.version FROM term_fee_locks l
     JOIN terms t ON t.id = l.term_id JOIN academic_years ay ON ay.id = t.academic_year_id JOIN fee_templates ft ON ft.id = l.template_id
     WHERE l.school_id = $1 AND l.class_id = $2 ORDER BY ay.year DESC, t.term_number DESC`,
    [schoolId, classId]
  )).rows;
  return {
    school, class: { id: cls.id, name: cls.name },
    terms: TERMS.map((t) => {
      const mine = tpls.filter((x) => x.term_number === t);                       // newest first
      const versions = mine.map((x, i) => {
        const its = items.filter((r) => r.template_id === x.id).map((r) => ({ name: r.name, amount: Number(r.amount), is_mandatory: r.is_mandatory }));
        return { version: x.version, current: i === 0, created: x.created, items: its };
      });
      versions.forEach((v, i) => { const older = versions[i + 1]; v.changes = older ? diffItems(older.items, v.items) : null; });
      const head = versions[0];
      const latest = head ? { version: head.version, created: head.created, ...shape(head.items), ...totals(shape(head.items)) } : null;
      return { term: t, set: !!head, latest, versions, locked: locks.filter((l) => l.term_number === t).map((l) => ({ label: `Term ${l.term_number} ${l.year}`, version: l.version })) };
    }),
  };
}

/**
 * The Optional fees page: every optional fee name (the school's list, plus any in use that is not on it), the price
 * each class charges for it in each term, how many students take it, and whether it can be removed from the list.
 * names: [{ name, inList, prices: { classId: { 1: 3000|null, 2: ..., 3: ... } }, students, removable, blockedBy }]
 */
async function optionalOverview(schoolId, deps = {}) {
  const db = deps.pool || pool;
  const school = await mustHaveSchool(db, schoolId);
  const classes = (await loadSchoolClasses(db, schoolId)).filter((c) => c.enabled);
  const catalog = await loadCatalog(db, schoolId);
  const latest = await loadLatest(db, schoolId);
  const takers = (await db.query(
    `SELECT c.name_key, COUNT(*) FILTER (WHERE s.status = 'active')::int AS active, COUNT(*)::int AS ever
     FROM student_optional_choices c JOIN students s ON s.id = c.student_id WHERE s.school_id = $1 GROUP BY c.name_key`,
    [schoolId]
  )).rows;

  const names = new Map(catalog.map((r) => [r.name_key, { name: r.name, inList: true }]));
  for (const t of latest.values()) for (const o of t.optional) if (!names.has(nameKey(o.name))) names.set(nameKey(o.name), { name: cleanText(o.name), inList: false });

  const out = [];
  for (const [k, info] of names) {
    const prices = {};
    let lines = 0;
    for (const c of classes) {
      prices[c.id] = {};
      for (const t of TERMS) {
        const cur = latest.get(`${c.id}|${t}`);
        const hit = cur && cur.optional.find((o) => nameKey(o.name) === k);
        prices[c.id][t] = hit ? hit.amount : null;
        if (hit) lines++;
      }
    }
    const tk = takers.find((x) => x.name_key === k) || { active: 0, ever: 0 };
    out.push({
      name: info.name, inList: info.inList, prices, students: tk.active,
      removable: info.inList && lines === 0 && tk.ever === 0,
      blockedBy: info.inList && (lines || tk.ever) ? { feeLists: lines, students: tk.ever } : null,
    });
  }
  out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return { school, classes: classes.map((c) => ({ id: c.id, name: c.name })), names: out };
}

module.exports = {
  setFees, copyFees, setOptionalPrices, overview, classFees, optionalOverview,
  listOptionalNames, addOptionalName, removeOptionalName,
  diffItems, classesByIds, expandClasses, parseItem, parseAmount, inTransaction, refuse, LINE_UP_KEY,
};
