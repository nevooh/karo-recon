// Tests the M-Pesa setup rules (src/services/mpesaSetup.js, mpesaUrlToken.js) without a database or the internet.
// Run:  node src/scripts/test-mpesa-setup.js
const crypto = require('crypto');
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.JWT_SECRET = 'login-secret-for-test';
delete process.env.C2B_URL_SECRET; delete process.env.PUBLIC_BASE_URL; delete process.env.MPESA_ENV;

let failed = 0;
const check = (name, ok, extra) => { if (!ok) failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---- a pretend database: one school row + a log of every write, in order ----
const db = { row: null, log: [], hasPayments: false, dupPaybill: false };
const freshRow = () => ({ mpesa_shortcode: '174379', keys_saved: true, mpesa_urls_registered_at: null, mpesa_urls_registered_base: null, mpesa_url_token_enc: null, mpesa_url_token_pending_enc: null });
const handler = (sql, params) => {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (/has_payments/.test(q)) return { rows: [{ ...db.row, has_payments: db.hasPayments }] };
  if (/mpesa_url_token_enc\s+FROM schools WHERE id = \$1/.test(q) && /keys_saved/.test(q)) return { rows: [db.row] };
  if (/^SELECT mpesa_url_token_enc FROM schools WHERE id/.test(q)) return { rows: [{ mpesa_url_token_enc: db.row.mpesa_url_token_enc }] };
  if (/SELECT mpesa_urls_registered_at FROM schools WHERE id/.test(q)) return { rows: [{ mpesa_urls_registered_at: db.row.mpesa_urls_registered_at }] };
  if (/^UPDATE schools SET mpesa_url_token_pending_enc = \$2/.test(q)) { db.log.push('pending:set'); db.row.mpesa_url_token_pending_enc = params[1]; return { rows: [] }; }
  if (/^UPDATE schools SET mpesa_url_token_pending_enc = NULL/.test(q)) { db.log.push('pending:clear'); db.row.mpesa_url_token_pending_enc = null; return { rows: [] }; }
  if (/^UPDATE schools SET mpesa_url_token_enc = mpesa_url_token_pending_enc/.test(q)) {
    db.log.push('promote'); db.row.mpesa_url_token_enc = db.row.mpesa_url_token_pending_enc; db.row.mpesa_url_token_pending_enc = null;
    db.row.mpesa_urls_registered_at = new Date(); db.row.mpesa_urls_registered_base = params[1]; return { rows: [] };
  }
  if (/^UPDATE schools SET mpesa_shortcode = \$2/.test(q)) {
    if (db.dupPaybill) { const e = new Error('duplicate key'); e.code = '23505'; throw e; }
    db.log.push({ keys: params }); db.row.mpesa_shortcode = params[1]; db.row.keys_saved = true; return { rows: [] };
  }
  if (/^INSERT INTO audit_log/.test(q)) { db.log.push({ audit: params }); return { rows: [] }; }
  return { rows: [] };
};
require.cache[require.resolve('../db/db')] = { id: require.resolve('../db/db'), filename: require.resolve('../db/db'), loaded: true, exports: { pool: { query: async (s, p) => handler(s, p) }, initSchema: async () => {} } };
const svc = require('../services/mpesaSetup');
const tok = require('../services/mpesaUrlToken');
const mpesa = require('../connectors/mpesa');
const reset = () => { db.row = freshRow(); db.log.length = 0; db.hasPayments = false; db.dupPaybill = false; };

const school = { id: 1, name: 'Test School', shortcode: '174379', consumerKey: 'KEY-123456', consumerSecret: 'SECRET-654321' };
const creds = async () => school;
const BASE = 'https://fees.example.com';
const FIXED = 'ab12cd34'.padEnd(40, '9');                 // a fixed code, so tests can look for it
const ok200 = { ResponseCode: '0', ResponseDescription: 'Success' };

(async () => {
  // ================= the code itself =================
  const a = tok.generateUrlToken(), b = tok.generateUrlToken();
  check('a code is 40 characters (0-9, a-f)', /^[0-9a-f]{40}$/.test(a), a);
  check('every code is different (random, not worked out from anything)', a !== b);
  check('a code survives being locked away and read back', tok.reveal(tok.protect(a)) === a);
  check('the locked-away form does not contain the code', !tok.protect(a).includes(a));
  check('an unreadable stored code reads as nothing (no crash)', tok.reveal('garbage') === null && tok.reveal(null) === null);

  const withStored = { mpesa_url_token_enc: tok.protect(FIXED) };
  check('ACCEPTED: the school\'s own stored code', tok.tokenAccepted(FIXED, '174379', withStored) === true);
  check('REFUSED: a different code', tok.tokenAccepted('f'.repeat(40), '174379', withStored) === false);
  check('REFUSED: empty / missing code', tok.tokenAccepted('', '174379', withStored) === false && tok.tokenAccepted(undefined, '174379', withStored) === false);
  const PENDING = 'ee55'.padEnd(40, '1');
  check('ACCEPTED: a "pending" code (registration in progress or interrupted)', tok.tokenAccepted(PENDING, '174379', { ...withStored, mpesa_url_token_pending_enc: tok.protect(PENDING) }) === true);
  const legacy = mpesa.c2bUrlToken('174379');
  check('LEGACY: the older shared-secret code still works for a school with NO stored code', tok.tokenAccepted(legacy, '174379', { mpesa_url_token_enc: null }) === true);
  check('LEGACY: ...and for a Paybill we do not know (as before)', tok.tokenAccepted(legacy, '174379', null) === true);
  check('once a school has its OWN code, the older code is REFUSED for it', tok.tokenAccepted(legacy, '174379', withStored) === false);
  check('a stored code that cannot be read fails CLOSED (nothing accepted, not even the older code)', tok.tokenAccepted(legacy, '174379', { mpesa_url_token_enc: 'garbage' }) === false);
  const savedJwt = process.env.JWT_SECRET; delete process.env.JWT_SECRET;
  check('no shared secret and no stored code: refused, without crashing', tok.tokenAccepted(legacy, '174379', { mpesa_url_token_enc: null }) === false);
  process.env.JWT_SECRET = savedJwt;
  check('one school\'s code cannot be used for another school', tok.tokenAccepted(FIXED, '999999', { mpesa_url_token_enc: tok.protect('1'.repeat(40)) }) === false);

  // ================= the public address =================
  check('address: empty -> not ok, says it is not set', svc.baseState('').ok === false && /not set/.test(svc.baseState('').problem));
  check('address: http:// -> refused', svc.baseState('http://fees.example.com').ok === false && /https/.test(svc.baseState('http://fees.example.com').problem));
  check('address: localhost -> refused', svc.baseState('https://localhost:3000').ok === false);
  check('address: contains "mpesa" -> refused (Safaricom blocks it)', svc.baseState('https://mpesa-fees.example.com').ok === false);
  check('address: good https address (trailing slash removed) -> ok', svc.baseState('https://fees.example.com/').base === BASE && svc.baseState(BASE).ok === true);

  const full = BASE + '/webhooks/c2b/' + 'ab12cd34ef56'.padEnd(40, '9') + '/confirmation';
  const masked = svc.maskUrl(full);
  check('mask: keeps the address and the first 4 characters only', masked === BASE + '/webhooks/c2b/ab12\u2026/confirmation', masked);
  check('Safaricom answer: success vs error', svc.looksSuccessful({ ResponseCode: '0' }) && svc.looksSuccessful({ ResponseDescription: 'Success' }) && !svc.looksSuccessful({ errorCode: '500.003.1001' }) && !svc.looksSuccessful(null));
  const built = mpesa.buildUrlsFromToken(BASE + '/', FIXED);
  check('both addresses carry the SAME code and differ only at the end', built.confirmationUrl === `${BASE}/webhooks/c2b/${FIXED}/confirmation` && built.validationUrl === `${BASE}/webhooks/c2b/${FIXED}/validation`);

  // ================= status for the screen =================
  process.env.PUBLIC_BASE_URL = BASE;
  reset(); db.row.keys_saved = false; let st = await svc.mpesaStatus(1);
  check('status: nothing saved -> "no_keys", cannot register, says why', st.stage === 'no_keys' && st.can_register === false && st.blockers.some((x) => /Save the Paybill/.test(x)) && st.preview === null);
  reset(); st = await svc.mpesaStatus(1);
  check('status: keys saved, no code yet -> "keys_saved", can register, no preview, kind "none"', st.stage === 'keys_saved' && st.can_register === true && st.token_kind === 'none' && st.preview === null && st.blockers.length === 0);
  reset(); db.row.mpesa_url_token_enc = tok.protect(FIXED); db.row.mpesa_urls_registered_at = new Date('2026-10-01'); st = await svc.mpesaStatus(1);
  check('status: registered with its own code -> "registered", kind "stored"', st.stage === 'registered' && st.token_kind === 'stored' && st.registered_at);
  check('status: masked preview shows the first 4 characters of ITS code', st.preview && st.preview.confirmation === `${BASE}/webhooks/c2b/ab12\u2026/confirmation`, st.preview);
  check('status NEVER contains the full code or any key', !JSON.stringify(st).includes(FIXED) && !JSON.stringify(st).includes('KEY-123456'));
  reset(); db.row.mpesa_urls_registered_at = new Date(); st = await svc.mpesaStatus(1);
  check('status: registered the older way -> kind "legacy" (with a preview of the old address)', st.token_kind === 'legacy' && st.preview && /c2b\/[0-9a-f]{4}\u2026\/confirmation$/.test(st.preview.confirmation) && st.legacy_secret_source === 'login_secret_fallback');
  reset(); st = await svc.mpesaStatus(1, true);
  check('status: payments already arriving -> counts as "registered" (kind "legacy")', st.stage === 'registered' && st.token_kind === 'legacy');
  process.env.MPESA_ENV = 'production'; reset(); db.row.mpesa_urls_registered_at = new Date(); st = await svc.mpesaStatus(1);
  check('status: production + registered -> cannot register again, says why', st.can_register === false && st.blockers.some((x) => /one time only/.test(x)));
  delete process.env.MPESA_ENV; delete process.env.PUBLIC_BASE_URL; reset(); st = await svc.mpesaStatus(1);
  check('status: no public address -> cannot register, says why', st.can_register === false && st.public_address_ok === false && st.blockers.some((x) => /PUBLIC_BASE_URL/.test(x)));

  // ================= saving the Paybill and keys =================
  const good = { schoolId: 1, paybill: '174 379', consumerKey: 'abcdefgh12345678', consumerSecret: 'zyxwvuts87654321' };
  for (const [label, bad] of [['letters in the Paybill', { paybill: 'abc123' }], ['Paybill too short', { paybill: '1234' }], ['Paybill too long', { paybill: '12345678' }], ['key with a space', { consumerKey: 'abcd efgh1234' }], ['key too short', { consumerKey: 'abc' }], ['secret empty', { consumerSecret: '' }]]) {
    reset(); const e = await rejects(() => svc.saveMpesaKeys({ ...good, ...bad }));
    check(`save keys: ${label} -> 400, nothing written`, e && e.status === 400 && !db.log.length, e && e.message);
  }
  reset(); db.row.keys_saved = false;
  let out = await svc.saveMpesaKeys(good);
  check('save keys: first time saves and says replaced:false (spaces in the Paybill ignored)', out.replaced === false && db.row.mpesa_shortcode === '174379');
  const written = JSON.stringify(db.log);
  check('save keys: the keys are written ENCRYPTED, never as plain text', !written.includes('abcdefgh12345678') && !written.includes('zyxwvuts87654321') && db.log.some((x) => x.keys && x.keys[2] && x.keys[2] !== 'abcdefgh12345678'));
  reset(); out = await svc.saveMpesaKeys(good);
  check('save keys: replacing existing keys says replaced:true', out.replaced === true);
  reset(); db.row.mpesa_urls_registered_at = new Date();
  let e = await rejects(() => svc.saveMpesaKeys({ ...good, paybill: '999999' }));
  check('save keys: the Paybill CANNOT change after registration (409), nothing written', e && e.status === 409 && !db.log.length);
  out = await svc.saveMpesaKeys(good);
  check('save keys: ...but new keys for the SAME Paybill are fine', out.replaced === true);
  reset(); db.hasPayments = true; e = await rejects(() => svc.saveMpesaKeys({ ...good, paybill: '999999' }));
  check('save keys: the Paybill cannot change once payments are arriving either', e && e.status === 409);
  reset(); db.dupPaybill = true; e = await rejects(() => svc.saveMpesaKeys(good));
  check('save keys: a Paybill another school has -> 409 with a clear message (not a crash)', e && e.status === 409 && /already registered to another school/.test(e.message), e && e.message);

  // ================= "check keys" =================
  let r = await svc.checkKeys(1, { getCredentials: async () => ({ ...school, consumerKey: null }), verify: async () => true });
  check('check keys: nothing saved -> "no_keys"', r.ok === false && r.reason === 'no_keys');
  r = await svc.checkKeys(1, { getCredentials: creds, verify: async () => true });
  check('check keys: Safaricom accepts -> ok', r.ok === true);
  r = await svc.checkKeys(1, { getCredentials: creds, verify: async () => { const x = new Error('x'); x.response = { status: 400 }; throw x; } });
  check('check keys: HTTP 400 -> "rejected" (wrong keys)', r.reason === 'rejected');
  r = await svc.checkKeys(1, { getCredentials: creds, verify: async () => { const x = new Error('x'); x.response = { status: 403 }; throw x; } });
  check('check keys: a 403 (firewall) is NOT blamed on the school -> "unexpected"', r.reason === 'unexpected' && /does not mean the keys are wrong/.test(r.message));
  r = await svc.checkKeys(1, { getCredentials: creds, verify: async () => { throw new Error('ECONNREFUSED'); } });
  check('check keys: no answer at all -> "unreachable"; message has no key', r.reason === 'unreachable' && !/KEY-123456|SECRET-654321/.test(r.message));

  // ================= registering =================
  let calls = 0; const sent = [];
  const register = async (args) => { calls++; sent.push(args); return ok200; };
  const deps = (extra) => ({ getCredentials: creds, register, generateToken: () => FIXED, ...(extra || {}) });
  const run = (opts, d) => svc.registerForSchool({ schoolId: 1, staffId: 7, base: BASE, ...opts }, d || deps());

  process.env.MPESA_ENV = 'production';          // NOTE: no C2B_URL_SECRET set - and that is now fine
  reset(); calls = 0;
  out = await run({});
  check('PRODUCTION with NO shared secret: registers fine (the school has its own code)', out.dry === false && calls === 1);
  check('the order was: pending saved -> Safaricom called -> promoted -> audited', db.log[0] === 'pending:set' && db.log[1] === 'promote' && !!db.log[2].audit, db.log.map((x) => (typeof x === 'string' ? x : Object.keys(x)[0])));
  check('Safaricom got BOTH addresses with the SAME code, and the school\'s Paybill and keys', sent[0].confirmationUrl === `${BASE}/webhooks/c2b/${FIXED}/confirmation` && sent[0].validationUrl === `${BASE}/webhooks/c2b/${FIXED}/validation` && sent[0].shortcode === '174379' && sent[0].consumerKey === 'KEY-123456');
  check('after success the school\'s code is stored and no pending code is left', tok.reveal(db.row.mpesa_url_token_enc) === FIXED && db.row.mpesa_url_token_pending_enc === null && db.row.mpesa_urls_registered_base === BASE);
  check('what comes back is MASKED only (the code is not in it)', out.preview.confirmation === `${BASE}/webhooks/c2b/ab12\u2026/confirmation` && !JSON.stringify(out.preview).includes(FIXED) && !JSON.stringify(out).includes(FIXED.slice(4)));
  check('the audit entry names the staff member and the address, with NO code or key', (() => { const a = db.log.find((x) => x.audit); return a && a.audit[1] === 7 && JSON.parse(a.audit[3]).base === BASE && !a.audit.join(' ').includes(FIXED) && !/KEY-123456|SECRET-654321/.test(a.audit.join(' ')); })());
  const fullUrls = await svc.getFullUrls(1, BASE);
  check('getFullUrls (internal tools only) gives the exact addresses that were registered', fullUrls.confirmationUrl === sent[0].confirmationUrl && fullUrls.validationUrl === sent[0].validationUrl);

  // already registered, in production
  calls = 0; db.log.length = 0;
  e = await rejects(() => run({}));
  check('PRODUCTION already registered -> 409 "one time only", nothing sent, nothing written', e && e.status === 409 && /one time only/.test(e.message) && calls === 0 && !db.log.length);
  e = await rejects(() => run({ dry: true }));
  check('...a dry run is refused too (so the mistake shows up early)', e && e.status === 409);
  const before = db.row.mpesa_url_token_enc;
  out = await run({ force: true }, deps({ generateToken: () => 'cd34'.padEnd(40, '7') }));
  check('...with force (command line only) it goes through and replaces the code', out.dry === false && tok.reveal(db.row.mpesa_url_token_enc) === 'cd34'.padEnd(40, '7') && db.row.mpesa_url_token_enc !== before);

  // a school that was set up the older way and already receives payments, but has no recorded date
  reset(); db.hasPayments = true; calls = 0;
  e = await rejects(() => run({}));
  check('PRODUCTION: payments already arriving (no recorded date) counts as already registered -> 409', e && e.status === 409 && /already arriving/.test(e.message) && calls === 0 && !db.log.length, e && e.message);
  reset(); db.row.mpesa_urls_registered_at = new Date('2026-10-01'); db.row.mpesa_url_token_enc = tok.protect(FIXED); db.hasPayments = false;

  // failure cases never disturb what already works
  const working = db.row.mpesa_url_token_enc; db.log.length = 0; calls = 0;
  e = await rejects(() => run({ force: true }, deps({ register: async () => ({ errorCode: '500.003.1001', errorMessage: 'URLs are already registered' }) })));
  check('Safaricom refuses -> 502 with the reason; the pending code is thrown away; the WORKING code is untouched', e && e.status === 502 && /did not confirm/.test(e.message) && db.log.includes('pending:clear') && !db.log.includes('promote') && db.row.mpesa_url_token_enc === working && db.row.mpesa_url_token_pending_enc === null, db.log);
  db.log.length = 0;
  e = await rejects(() => run({ force: true }, deps({ register: async () => { throw new Error('network down'); } })));
  check('Safaricom unreachable -> error passes up; pending thrown away; working code untouched; nothing audited', e && /network down/.test(e.message) && db.log.includes('pending:clear') && db.row.mpesa_url_token_enc === working && !db.log.some((x) => x.audit));

  // sandbox: re-registering is allowed
  process.env.MPESA_ENV = 'sandbox'; calls = 0;
  out = await run({});
  check('SANDBOX: registering again is allowed (testing)', out.dry === false && calls === 1);
  process.env.MPESA_ENV = 'production';

  // bad addresses, bad schools
  for (const [label, base] of [['http', 'http://fees.example.com'], ['localhost', 'https://localhost:3000'], ['"mpesa" in it', 'https://mpesa.example.com'], ['empty', '']]) {
    reset(); calls = 0; e = await rejects(() => run({ base }));
    check(`bad address (${label}) -> refused, nothing sent, nothing written`, e && e.status === 400 && calls === 0 && !db.log.length);
  }
  reset(); calls = 0; out = await run({ dry: true });
  check('DRY RUN: masked preview only, Safaricom not called, NOTHING written', out.dry === true && /\/c2b\/[0-9a-f]{4}\u2026\/confirmation$/.test(out.preview.confirmation) && calls === 0 && !db.log.length);
  e = await rejects(() => svc.registerForSchool({ schoolId: 9, base: BASE }, { getCredentials: async () => null, register }));
  check('unknown school -> 404', e && e.status === 404);
  e = await rejects(() => svc.registerForSchool({ schoolId: 1, base: BASE }, { getCredentials: async () => ({ ...school, consumerSecret: null }), register }));
  check('school without keys -> refused', e && /no Paybill number or Daraja keys/.test(e.message));
  reset(); e = await rejects(() => svc.getFullUrls(1));
  check('getFullUrls for a school with no stored code -> 404', e && e.status === 404);

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nAll M-Pesa setup checks pass.');
  process.exit(failed ? 1 : 0);
})();