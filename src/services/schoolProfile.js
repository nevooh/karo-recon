/* schoolProfile.js - the school's name, motto, contact details and logo (School settings page).
   - Any Admin can change motto, phone, email, address, county, the receipt footer and the logo.
   - Only the Main Admin can rename the school (the name must stay unique across schools); the route also asks for the PIN for that.
   - The logo is a small PNG, JPEG or WebP kept in the database. It is checked by its real first bytes, not by what the file claims to be.
     SVG is refused on purpose (it can carry scripts). Biggest allowed: 700 KB (the screen shrinks pictures to about 400 pixels first).
   Everything is logged ("changed the school profile", "changed the school logo"). */
const { pool } = require('../db/db');
const { logAudit } = require('./audit');
const { EMAIL_RE } = require('./schoolSetup');

const MAX_LOGO = 700 * 1024;
function refuse(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const clean = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const PHONE_RE = /^[0-9+()\-\/ ,.]{6,40}$/;

const FIELDS = {
  motto: { max: 120, label: 'The motto' }, address: { max: 200, label: 'The address' }, county: { max: 60, label: 'The county' },
  receipt_footer: { max: 200, label: 'The receipt footer' }, phone: { max: 40, label: 'The phone number', re: PHONE_RE, reMsg: 'The phone number can only have digits, spaces and + ( ) - / , .' },
  phone2: { max: 40, label: 'The second phone number', re: PHONE_RE, reMsg: 'The second phone number can only have digits, spaces and + ( ) - / , .' },
  email: { max: 120, label: 'The email', re: EMAIL_RE, reMsg: 'That does not look like an email address.' },
};

async function loadActor(db, schoolId, staffId) {
  const r = await db.query('SELECT id, role, is_owner, status FROM staff WHERE id = $1 AND school_id = $2', [staffId, schoolId]);
  const a = r.rows[0];
  if (!a || a.status !== 'active') throw refuse('Your account can not do this.', 403);
  if (a.role !== 'admin') throw refuse('Only an Admin can do this.', 403);
  return a;
}

async function getProfile(schoolId, db = pool) {
  const r = (await db.query('SELECT name, motto, phone, phone2, email, address, county, receipt_footer, logo_data, logo_type, logo_updated_at FROM schools WHERE id = $1', [schoolId])).rows[0];
  if (!r) throw refuse('School not found.', 404);
  return {
    name: r.name, motto: r.motto || '', phone: r.phone || '', phone2: r.phone2 || '', email: r.email || '', address: r.address || '', county: r.county || '', receipt_footer: r.receipt_footer || '',
    logo: r.logo_data ? 'data:' + r.logo_type + ';base64,' + r.logo_data.toString('base64') : null, logo_updated_at: r.logo_updated_at,
  };
}

async function updateProfile({ schoolId, actorId, changes, ip = null }, deps = {}) {
  const db = deps.pool || pool;
  const actor = await loadActor(db, schoolId, actorId);
  const cur = await getProfile(schoolId, db);
  const next = {}; const touched = [];
  for (const k of Object.keys(changes || {})) {
    if (k === 'name') {
      const name = clean(changes.name);
      if (name.length < 2 || name.length > 120) throw refuse('The school name must be 2 to 120 characters.');
      if (name !== cur.name) {
        if (!actor.is_owner) throw refuse('Only the Main Admin can rename the school.', 403);
        const dupe = await db.query('SELECT 1 FROM schools WHERE lower(btrim(name)) = lower($1) AND id <> $2 LIMIT 1', [name, schoolId]);
        if (dupe.rows.length) throw refuse('A school with this name already exists. Use a clearly different name (for example add the town).', 409);
        next.name = name; touched.push('name');
      }
      continue;
    }
    const f = FIELDS[k];
    if (!f) continue;                                           // unknown keys are ignored
    const v = clean(changes[k]);
    if (v.length > f.max) throw refuse(f.label + ' is too long (at most ' + f.max + ' characters).');
    if (v && f.re && !f.re.test(v)) throw refuse(f.reMsg);
    const value = k === 'email' ? v.toLowerCase() : v;
    if (value !== cur[k]) { next[k] = value; touched.push(k); }
  }
  if (!touched.length) return { unchanged: true, profile: cur };
  const sets = Object.keys(next).map((k, i) => `${k} = $${i + 2}`);
  await db.query(`UPDATE schools SET ${sets.join(', ')} WHERE id = $1`, [schoolId, ...Object.keys(next).map((k) => next[k] === '' ? null : next[k])]);
  await logAudit({ schoolId, staffId: actorId, action: 'school_profile_changed', detail: { fields: touched, ...(next.name ? { name_from: cur.name, name_to: next.name } : {}) }, ip });
  return { unchanged: false, changed: touched, profile: await getProfile(schoolId, db) };
}

// What kind of picture are these bytes, really?
function sniff(buf) {
  if (buf.length > 12 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
async function setLogo({ schoolId, actorId, image, ip = null }, deps = {}) {
  const db = deps.pool || pool;
  await loadActor(db, schoolId, actorId);
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(image || ''));
  if (!m) throw refuse('Choose a PNG, JPG or WebP picture.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_LOGO) throw refuse('That picture is too big (at most 700 KB). Choose a smaller one.', 413);
  const real = sniff(buf);
  if (!real || real !== m[1]) throw refuse('That file is not a real PNG, JPG or WebP picture.');
  await db.query('UPDATE schools SET logo_data = $2, logo_type = $3, logo_updated_at = NOW() WHERE id = $1', [schoolId, buf, real]);
  await logAudit({ schoolId, staffId: actorId, action: 'school_logo_changed', detail: { kb: Math.round(buf.length / 1024) }, ip });
  return { ok: true };
}
async function removeLogo({ schoolId, actorId, ip = null }, deps = {}) {
  const db = deps.pool || pool;
  await loadActor(db, schoolId, actorId);
  const r = await db.query('UPDATE schools SET logo_data = NULL, logo_type = NULL, logo_updated_at = NOW() WHERE id = $1 AND logo_data IS NOT NULL RETURNING id', [schoolId]);
  if (r.rows.length) await logAudit({ schoolId, staffId: actorId, action: 'school_logo_removed', ip });
  return { ok: true, removed: r.rows.length > 0 };
}

module.exports = { getProfile, updateProfile, setLogo, removeLogo, sniff, MAX_LOGO };