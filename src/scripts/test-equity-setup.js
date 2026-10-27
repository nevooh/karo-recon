// Tests the "Connect Equity" credential generator, end to end, without a database.
// Run:  node src/scripts/test-equity-setup.js
const path = require('path');
const crypto = require('crypto');
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.JWT_SECRET = 'test-secret';
delete process.env.PUBLIC_BASE_URL;
const { decrypt } = require('../security/crypto');
const bcrypt = require('bcryptjs');
const PW_HASH = bcrypt.hashSync('pw12345678', 4);
const RESET = { confirm_text: 'RESET', password: 'pw12345678' };

let failed = 0;
const check = (name, ok, extra) => { if (!ok) failed++; console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (!ok && extra ? '  -> ' + extra : '')); };

// A tiny pretend database: just the one table we touch.
const conns = [];
const handler = (sql, params) => {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (/SELECT id FROM bank_providers WHERE code = \$1/.test(q)) return { rows: params[0] === 'equity' ? [{ id: 1 }] : [] };
  if (/SELECT sbc.account_number, sbc.credentials_enc, bp.code, bp.name FROM school_bank_connections/.test(q)) {
    const c = conns.find((x) => x.school_id === params[0]);
    return { rows: c && params[1] === 'equity' ? [{ account_number: c.account_number, credentials_enc: c.credentials_enc, code: 'equity', name: 'Equity' }] : [] };
  }
  if (/SELECT 1 FROM school_bank_connections sbc JOIN bank_providers/.test(q)) return { rows: conns.some((c) => c.account_number === params[0]) ? [{}] : [] };
  if (/INSERT INTO school_bank_connections/.test(q)) {
    const [school_id, provider_id, account_number, credentials_enc] = params;
    const existing = conns.find((c) => c.school_id === school_id);
    if (existing) Object.assign(existing, { account_number, credentials_enc }); else conns.push({ school_id, provider_id, account_number, credentials_enc });
    return { rows: [{ id: 1 }] };
  }
  if (/SELECT s\.\*, sbc\.credentials_enc FROM schools s/.test(q)) {
    const c = conns.find((x) => x.account_number === params[0]);
    return { rows: c ? [{ id: c.school_id, credentials_enc: c.credentials_enc }] : [] };
  }
  // --- answers for the Admin + reset rules (the logged-in test person is an Admin) ---
  if (/SELECT role FROM staff WHERE id/.test(q)) return { rows: [{ role: 'admin' }] };
  if (/SELECT status, token_version FROM staff WHERE id/.test(q)) return { rows: [{ status: 'active', token_version: 0 }] };
  if (/SELECT name FROM schools WHERE id/.test(q)) return { rows: [{ name: 'Test School' }] };
  if (/SELECT password_hash FROM staff WHERE id/.test(q)) return { rows: [{ password_hash: PW_HASH }] };
  if (/SELECT sbc.id, sbc.last_rotated_at FROM school_bank_connections sbc JOIN bank_providers/.test(q)) return { rows: conns.some((c) => c.school_id === params[0]) ? [{ id: 1, last_rotated_at: null }] : [] };
  if (/UPDATE school_bank_connections SET last_rotated_at = NOW\(\)/.test(q)) return { rows: [{ id: 1 }] };
  return { rows: [] };
};
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { require.cache[path.join(root, rel)] = { id: rel, filename: rel, loaded: true, exports }; };
const ingested = [];
stub('db/db.js', { pool: { query: async (s, p) => handler(s, p) }, initSchema: async () => {} });
stub('services/ingest.js', { ingestPayment: async (p) => { ingested.push(p); return { alreadyProcessed: false, transactionId: 1, match: { status: 'needs_review', confidence: 0.5 } }; } });
const app = require(path.join(root, 'app.js'));
const { generateToken, generatePinToken } = require(path.join(root, 'security/auth.js'));

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const tok = (schoolId) => ({ Authorization: 'Bearer ' + generateToken({ staffId: 5, schoolId }), 'X-Pin-Token': generatePinToken({ staffId: 5, schoolId }), 'Content-Type': 'application/json' });
  const generate = async (schoolId, token, body) => { const r = await fetch(`${base}/api/schools/${schoolId}/bank-connections/equity/credentials`, { method: 'POST', headers: token, body: JSON.stringify(body || {}) }); return { status: r.status, headers: r.headers, body: await r.json() }; };
  const payment = { callbackType: 'ALT', customer: { name: 'A', reference: 'ADM101' }, transaction: { reference: 'T1', amount: 50, status: 'SUCCESS', billNumber: 'B1' }, bank: { reference: 'B1', transactionType: 'Credit' } };
  const push = async (user, pass) => (await fetch(`${base}/webhooks/equity/ipn`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(user + ':' + pass).toString('base64') }, body: JSON.stringify(payment) })).status;

  let r = await generate(1, { 'Content-Type': 'application/json' });
  check('no login -> 401', r.status === 401);
  r = await generate(1, tok(2));
  check("another school's staff -> 403", r.status === 403);

  r = await generate(1, tok(1));
  const first = r.body;
  check('school 1 gets a username like karo_xxxxxxxxxx', r.status === 200 && /^karo_[a-z0-9]{10}$/.test(first.username), JSON.stringify(first));
  check('password is 32 letters/numbers only (safe to paste anywhere)', /^[A-Za-z0-9]{32}$/.test(first.password), first.password);
  check('marked show-once, not cached, 4 steps for the school', first.show_once === true && /no-store/.test(r.headers.get('cache-control') || '') && first.steps.length === 4);
  check('no PUBLIC_BASE_URL set -> placeholder address, clearly flagged', first.callback_url === 'https://YOUR-DOMAIN/webhooks/equity/ipn' && first.callback_url_is_placeholder === true);
  check('first call is not a rotation', first.rotated === false);

  const stored = conns.find((c) => c.school_id === 1);
  const readable = decrypt(stored.credentials_enc);
  check('the password itself is NOT stored anywhere (only a fingerprint)', !readable.includes(first.password) && !stored.credentials_enc.includes(first.password) && JSON.parse(readable).ipn_password_hash.length === 64);
  check('username is stored as the routing key', stored.account_number === first.username);

  check('webhook with the generated login -> accepted and saved for school 1', (await push(first.username, first.password)) === 200 && ingested.length === 1 && ingested[0].school_id === 1);
  check('webhook with a wrong password -> 401', (await push(first.username, first.password + 'x')) === 401 && ingested.length === 1);

  r = await generate(1, tok(1));
  check('a second call WITHOUT confirmation is refused (400) and the old password still works', r.status === 400 && (await push(first.username, first.password)) === 200, r.status);

  r = await generate(1, tok(1), RESET);
  const second = r.body;
  check('second call rotates: SAME username, NEW password', second.rotated === true && second.username === first.username && second.password !== first.password);
  check('after rotating, the OLD password stops working at once', (await push(first.username, first.password)) === 401);
  check('after rotating, the NEW password works', (await push(second.username, second.password)) === 200);

  r = await generate(2, tok(2));
  check('school 2 gets a DIFFERENT username (no collision)', r.status === 200 && r.body.username !== first.username && /^karo_/.test(r.body.username));
  check("school 2's login only reaches school 2", (await push(r.body.username, r.body.password)) === 200 && ingested[ingested.length - 1].school_id === 2);

  process.env.PUBLIC_BASE_URL = 'https://karo.example.com/';
  r = await generate(1, tok(1), RESET);
  check('with PUBLIC_BASE_URL set -> real address, trailing slash handled', r.body.callback_url === 'https://karo.example.com/webhooks/equity/ipn' && r.body.callback_url_is_placeholder === false, r.body.callback_url);

  const many = new Set(); for (let i = 0; i < 40; i++) { const g = await generate(100 + i, tok(100 + i)); many.add(g.body.password); many.add(g.body.username); }
  check('40 more schools: every username and password is different', many.size === 80);

  console.log('\n' + (failed === 0 ? 'All Equity setup checks pass.' : failed + ' check(s) FAILED.'));
  server.close(); process.exit(failed ? 1 : 0);
});