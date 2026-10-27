/* activityLog.js - the Activity log page: reads audit_log and turns each line into plain words.
   audit_log only ever grows (a database trigger refuses edits and deletes). Names are looked up when the page is read,
   so a line says "Ann Bursar recorded KES 5,000 for Amina Wanjiru", never "student 12".
   Times are shown in Kenya time. Sign-ins are hidden unless asked for; failed sign-ins and lockouts always show. */
const { pool } = require('../db/db');

const TZ = 'Africa/Nairobi';
const PAGE = 40;

const GROUPS = [['money', 'Money'], ['students', 'Students'], ['fees', 'Fees & terms'], ['staff', 'Staff & access'], ['setup', 'Setup'], ['signins', 'Sign-ins']];
const GROUP_OF = {
  manual_payment_added: 'money', manual_payment_reversed: 'money', payment_confirmed: 'money', payment_rejected: 'money', stk_payment_received: 'money',
  student_admitted: 'students', student_updated: 'students', student_marked_left: 'students', student_returned: 'students', students_moved: 'students', school_promoted: 'students',
  fees_set: 'fees', fees_copied: 'fees', optional_prices_set: 'fees', optional_fee_name_added: 'fees', optional_fee_name_removed: 'fees', optional_fee_dropped: 'fees', terms_set: 'fees', term_billed: 'fees',
  staff_invited: 'staff', invite_resent: 'staff', staff_joined: 'staff', staff_role_changed: 'staff', staff_suspended: 'staff', staff_reactivated: 'staff', staff_name_changed: 'staff', staff_email_change_requested: 'staff', staff_email_changed: 'staff',
  ownership_transferred: 'staff', password_changed: 'staff', password_set: 'staff', password_reset_requested: 'staff', password_reset_sent: 'staff', password_reset_done: 'staff', staff_created: 'staff', login_failed: 'staff', login_locked: 'staff',
  channels_changed: 'setup', mpesa_keys_saved: 'setup', mpesa_keys_replaced: 'setup', mpesa_keys_checked: 'setup', mpesa_urls_registered: 'setup', mpesa_registration_failed: 'setup', credentials_created: 'setup', credentials_rotated: 'setup',
  credentials_reset_wrong_password: 'setup', classes_changed: 'setup', stream_added: 'setup', stream_renamed: 'setup', stream_removed: 'setup', streams_merged: 'setup', school_created: 'setup',
  school_profile_changed: 'setup', school_logo_changed: 'setup', school_logo_removed: 'setup', pin_set: 'staff', pin_changed: 'staff', pin_failed: 'staff', pin_locked: 'staff',
  login: 'signins',
};
const actionsOf = (g) => Object.keys(GROUP_OF).filter((a) => GROUP_OF[a] === g);
const BAD = new Set(['pin_failed', 'pin_locked', 'login_failed', 'login_locked', 'credentials_reset_wrong_password', 'payment_rejected', 'manual_payment_reversed', 'staff_suspended', 'mpesa_registration_failed']);

const num = (x) => Number(x) || 0;
const kes = (n) => 'KES ' + num(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
const METHOD = { cash: 'cash', cheque: 'cheque', bank: 'bank', bank_deposit: 'bank slip', bank_slip: 'bank slip', mpesa: 'M-Pesa', other: 'other' };
const list = (a) => (Array.isArray(a) ? a : []).filter(Boolean);
const FIELD = { full_name: 'name', admission_no: 'admission number', class_id: 'class', stream_id: 'stream', guardian_name: 'guardian', contacts: 'contacts', phone: 'phone' };

// ctx: { student(id) -> name, person(id) -> name }
function describe(action, d, ctx) {
  d = d || {};
  const stu = (id) => (id && ctx.student(id)) || (d.admission_no ? 'student ' + d.admission_no : 'a student');
  const per = (id) => (id && ctx.person(id)) || (d.name || 'a staff member');
  const out = (text, extra, extraObj) => ({ text, extra: extra || null, ...(extraObj || {}) });
  const sid = d.student_id || null;
  switch (action) {
    case 'login': return out('signed in');
    case 'login_failed': return out('had a wrong password typed on their account');
    case 'login_locked': return out('was locked out for 15 minutes after too many wrong passwords');
    case 'password_changed': return out('changed their password');
    case 'password_set': return out(d.for_staff_id ? 'set a new password for ' + per(d.for_staff_id) : 'set a password');
    case 'password_reset_requested': return out('asked for a password reset link');
    case 'password_reset_sent': return out('sent a password reset link to ' + per(d.staff_id));
    case 'password_reset_done': return out('chose a new password using the reset link');
    case 'staff_invited': return out('invited ' + (d.name || per(d.staff_id)) + ' to join as ' + (d.role === 'admin' ? 'an Admin' : 'Staff'));
    case 'invite_resent': return out('sent the invite again to ' + per(d.staff_id));
    case 'staff_joined': return out('joined and chose their password');
    case 'staff_role_changed': return out('changed ' + per(d.staff_id) + ' from ' + (d.from === 'admin' ? 'Admin' : 'Staff') + ' to ' + (d.to === 'admin' ? 'Admin' : 'Staff'));
    case 'staff_suspended': return out('suspended ' + per(d.staff_id));
    case 'staff_reactivated': return out('reactivated ' + per(d.staff_id));
    case 'staff_name_changed': return out('changed the name of ' + per(d.staff_id));
    case 'staff_email_change_requested': return out('asked to change the email of ' + per(d.staff_id));
    case 'staff_email_changed': return out(d.before_joining ? 'corrected the email of ' + per(d.staff_id) + ' before they joined' : 'confirmed a new email address');
    case 'ownership_transferred': return out('handed the Main Admin role to ' + per(d.to_staff_id));
    case 'staff_created': return out('added a staff member');
    case 'manual_payment_added': return out('recorded ' + kes(d.amount) + ' (' + (METHOD[d.method] || d.method || 'payment') + ') for ' + stu(sid),
      [d.receipt_no && 'Receipt ' + d.receipt_no, d.term, d.reference && 'Ref ' + d.reference, d.note].filter(Boolean).join(' · '), { studentId: sid });
    case 'manual_payment_reversed': return out('reversed the ' + kes(d.amount) + ' payment for ' + stu(sid), [d.receipt_no && 'Receipt ' + d.receipt_no, d.term, d.reason && 'Reason: ' + d.reason].filter(Boolean).join(' · '), { studentId: sid });
    case 'payment_confirmed': return out('confirmed ' + kes(d.amount) + (d.payer ? ' from ' + d.payer : '') + ' to ' + stu(sid), d.source ? 'via ' + d.source : null, { studentId: sid });
    case 'payment_rejected': return out('rejected ' + kes(d.amount) + (d.payer ? ' from ' + d.payer : ''), d.source ? 'via ' + d.source : null);
    case 'student_admitted': return out('admitted ' + stu(sid) + (d.class ? ' to ' + d.class + (d.stream ? ' ' + d.stream : '') : ''),
      [d.starting_balance ? 'Brought-forward balance ' + kes(d.starting_balance) : null, d.billed_now ? 'Billed straight away' : null].filter(Boolean).join(' · '), { studentId: sid });
    case 'student_updated': {
      const keys = Object.keys(d.after || {}).filter((k) => JSON.stringify((d.before || {})[k]) !== JSON.stringify((d.after || {})[k])).map((k) => FIELD[k] || k.replace(/_/g, ' '));
      return out('edited the details of ' + stu(sid), keys.length ? 'Changed: ' + keys.join(', ') : null, { studentId: sid });
    }
    case 'student_marked_left': return out('marked ' + stu(sid) + ' as left', [d.reason && 'Reason: ' + d.reason, d.balance != null && 'Balance then ' + kes(d.balance)].filter(Boolean).join(' · '), { studentId: sid });
    case 'student_returned': return out('brought ' + stu(sid) + ' back as an active student', d.reason || null, { studentId: sid });
    case 'students_moved': return out('moved ' + plural(num(d.count), 'student') + ' into ' + (d.class || 'a class') + (d.stream ? ' ' + d.stream : ''));
    case 'school_promoted': return out('ran the school promotion into ' + (d.incoming_year || 'the new year'),
      [d.promoted != null && plural(num(d.promoted), 'promoted', 'promoted'), num(d.repeating) && num(d.repeating) + ' repeating', num(d.graduated) && num(d.graduated) + ' graduated', num(d.left) && num(d.left) + ' left'].filter(Boolean).join(' · '));
    case 'fees_set': return out('set the fees', list(d.changed).length ? list(d.changed).slice(0, 6).join(', ') + (list(d.changed).length > 6 ? '...' : '') : 'No changes in the amounts');
    case 'fees_copied': return out('copied fees' + (d.from ? ' from ' + d.from : ''), list(d.changed).slice(0, 6).join(', ') || null);
    case 'optional_prices_set': return out('set prices for the optional fee "' + (d.name || '') + '"', list(d.changed).slice(0, 6).join(', ') || null);
    case 'optional_fee_name_added': return out('added the optional fee "' + (d.name || '') + '"');
    case 'optional_fee_name_removed': return out('removed the optional fee "' + (d.name || '') + '"');
    case 'optional_fee_dropped': return out('"' + (d.fee || 'An optional fee') + '" was dropped for ' + plural(num(d.students), 'student') + ' because the class no longer offers it');
    case 'terms_set': return out('set ' + (d.year || '') + ' Term ' + (d.term || '') + ' dates', (d.start || '') + ' to ' + (d.end || '') + (d.previous_start ? ' (was ' + d.previous_start + ' to ' + d.previous_end + ')' : ''));
    case 'term_billed': return out('Billed ' + (d.term || 'the term') + ' automatically', plural(list(d.classes).length, 'class', 'classes') + ' · ' + plural(list(d.classes).reduce((s, c) => s + num(c.students), 0), 'student') + ' · total fees ' + kes(d.total_fees));
    case 'channels_changed': return out('changed the payment channels', list(d.selected).join(', ') || 'none on');
    case 'mpesa_keys_saved': return out(d.what === 'stk passkey' ? 'saved the M-Pesa STK passkey' : 'saved the M-Pesa keys');
    case 'mpesa_keys_replaced': return out(d.what === 'stk passkey' ? 'replaced the M-Pesa STK passkey' : 'replaced the M-Pesa keys');
    case 'mpesa_keys_checked': return out(d.ok ? 'checked the M-Pesa keys: they work' : 'checked the M-Pesa keys: they did not work', d.ok ? null : d.reason);
    case 'mpesa_urls_registered': return out('registered the M-Pesa payment addresses');
    case 'mpesa_registration_failed': return out('tried to register the M-Pesa addresses but it failed');
    case 'credentials_created': return out('created the ' + (d.bank || 'bank') + ' connection details');
    case 'credentials_rotated': return out('replaced the ' + (d.bank || 'bank') + ' connection details');
    case 'credentials_reset_wrong_password': return out('typed a wrong password while trying to reset bank details');
    case 'classes_changed': return out('changed which classes the school runs', [list(d.switched_on).length && 'On: ' + list(d.switched_on).join(', '), list(d.switched_off).length && 'Off: ' + list(d.switched_off).join(', ')].filter(Boolean).join(' · ') || null);
    case 'stream_added': return out('added the stream ' + (d.stream || '') + ' to ' + (d.class || 'a class'));
    case 'stream_renamed': return out('renamed the stream ' + (d.from || '') + ' to ' + (d.to || '') + ' in ' + (d.class || 'a class'));
    case 'stream_removed': return out('removed the stream ' + (d.stream || '') + ' from ' + (d.class || 'a class'));
    case 'streams_merged': return out('merged the stream ' + (d.from || '') + ' into ' + (d.into || '') + ' in ' + (d.class || 'a class'));
    case 'school_profile_changed': return out(d.name_to ? 'renamed the school from "' + d.name_from + '" to "' + d.name_to + '"' : 'changed the school profile', list(d.fields).filter((f) => f !== 'name').map((f) => ({ motto: 'motto', phone: 'phone', phone2: 'second phone', email: 'email', address: 'address', county: 'county', receipt_footer: 'receipt footer' }[f] || f)).join(', ') || null);
    case 'school_logo_changed': return out('changed the school logo');
    case 'school_logo_removed': return out('removed the school logo');
    case 'pin_set': return out('set their PIN');
    case 'pin_changed': return out('changed their PIN');
    case 'pin_failed': return out('typed a wrong PIN');
    case 'pin_locked': return out('was locked out of PIN use for 15 minutes after too many wrong PINs');
    case 'school_created': return out('The school was set up');
    case 'stk_payment_received': return out('received ' + kes(d.amount) + ' by M-Pesa from a parent on the portal for ' + stu(sid),
      [d.receipt && 'M-Pesa ' + d.receipt, d.how === 'settled_from_review' ? 'settled a payment that was waiting in the Review queue' : null].filter(Boolean).join(' · '), { studentId: sid });
    default: return out(action.replace(/_/g, ' '));
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
async function rangeBounds(schoolId, { range, from, to }, db) {
    const plus = (s, n) => { const x = new Date(s + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const t = (await db.query(`SELECT to_char((NOW() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;     // text, so no time-zone shifting
  if (range === 'today') return { from: t, to: t };
  if (range === '7d') return { from: plus(t, -6), to: t };
  if (range === '30d') return { from: plus(t, -29), to: t };
  if (range === 'term') {
    const term = (await db.query(`SELECT to_char(d.start_date, 'YYYY-MM-DD') AS s FROM school_term_dates d WHERE d.school_id = $1 AND d.start_date <= (NOW() AT TIME ZONE '${TZ}')::date ORDER BY d.start_date DESC LIMIT 1`, [schoolId])).rows[0];
    return term ? { from: term.s, to: t } : { from: null, to: null };
  }
  if (range === 'custom') return { from: DAY.test(from || '') ? from : null, to: DAY.test(to || '') ? to : null };
  return { from: null, to: null };
}

async function listActivity(schoolId, o = {}, db = pool) {
  const limit = Math.min(Math.max(parseInt(o.limit, 10) || PAGE, 1), 100);
  const where = ['a.school_id = $1'], p = [schoolId];
  const add = (sql, v) => { p.push(v); where.push(sql.replace('?', '$' + p.length)); };
  const group = GROUPS.some((g) => g[0] === o.group) ? o.group : null;
  if (group) add('a.action = ANY(?)', actionsOf(group));
  else if (!o.signIns) where.push(`a.action <> 'login'`);
  if (o.staffId) add('a.staff_id = ?', Number(o.staffId));
  const b = await rangeBounds(schoolId, o, db);
  if (b.from) add(`a.created_at >= (?::date)::timestamp AT TIME ZONE '${TZ}'`, b.from);
  if (b.to) add(`a.created_at < ((?::date) + 1)::timestamp AT TIME ZONE '${TZ}'`, b.to);
  if (o.before) add('a.id < ?', Number(o.before));
  const q = String(o.q || '').trim().slice(0, 80);
  if (q) {
    p.push('%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'); const i = '$' + p.length;
    where.push(`(act.full_name ILIKE ${i} OR stu.full_name ILIKE ${i} OR stu.admission_no ILIKE ${i} OR tgt.full_name ILIKE ${i} OR a.detail::text ILIKE ${i})`);
  }
  const rows = (await db.query(
    `SELECT a.id, a.action, a.detail, a.ip, a.created_at, a.staff_id, act.full_name AS actor_name, act.role AS actor_role, act.is_owner AS actor_owner
     FROM audit_log a
     LEFT JOIN staff act ON act.id = a.staff_id
     LEFT JOIN students stu ON stu.school_id = a.school_id AND (CASE WHEN a.detail->>'student_id' ~ '^[0-9]+$' THEN (a.detail->>'student_id')::int END) = stu.id
     LEFT JOIN staff tgt ON tgt.school_id = a.school_id AND (CASE WHEN COALESCE(a.detail->>'staff_id', a.detail->>'to_staff_id', a.detail->>'for_staff_id') ~ '^[0-9]+$' THEN COALESCE(a.detail->>'staff_id', a.detail->>'to_staff_id', a.detail->>'for_staff_id')::int END) = tgt.id
     WHERE ${where.join(' AND ')}
     ORDER BY a.id DESC LIMIT ${limit + 1}`, p)).rows;
  const more = rows.length > limit; if (more) rows.pop();

  // names for the page's lines, in one go
  const sIds = new Set(), pIds = new Set();
  for (const r of rows) {
    const d = r.detail || {};
    if (d.student_id) sIds.add(Number(d.student_id));
    for (const k of ['staff_id', 'to_staff_id', 'for_staff_id']) if (d[k]) pIds.add(Number(d[k]));
  }
  const sName = new Map((sIds.size ? (await db.query('SELECT id, full_name FROM students WHERE school_id = $1 AND id = ANY($2)', [schoolId, [...sIds]])).rows : []).map((x) => [x.id, x.full_name]));
  const pName = new Map((pIds.size ? (await db.query('SELECT id, full_name FROM staff WHERE school_id = $1 AND id = ANY($2)', [schoolId, [...pIds]])).rows : []).map((x) => [x.id, x.full_name]));
  const ctx = { student: (id) => sName.get(Number(id)), person: (id) => pName.get(Number(id)) };

  const out = rows.map((r) => {
    const g = GROUP_OF[r.action] || 'setup';
    const x = describe(r.action, r.detail, ctx);
    return { id: r.id, when: r.created_at, group: g, tone: BAD.has(r.action) ? 'bad' : 'ok', action: r.action, text: x.text, extra: x.extra, student_id: x.studentId || null,
      who: r.actor_name ? { id: r.staff_id, name: r.actor_name, label: r.actor_owner ? 'Main Admin' : (r.actor_role === 'admin' ? 'Admin' : 'Staff') } : { id: null, name: 'System', label: '' },
      ip: r.ip || null };
  });
  const people = (await db.query(`SELECT id, full_name FROM staff WHERE school_id = $1 AND status <> 'removed' ORDER BY lower(full_name)`, [schoolId])).rows.map((x) => ({ id: x.id, name: x.full_name }));
  return { rows: out, next: more ? rows[rows.length - 1].id : null, people, groups: GROUPS.map((g) => ({ key: g[0], label: g[1] })) };
}

module.exports = { listActivity, describe, GROUPS, GROUP_OF, TZ };