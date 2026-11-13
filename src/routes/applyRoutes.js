const express = require('express');
const { pool } = require('../db/db');
const router = express.Router();

// This form is public, so anyone on the internet can send to it. It is guarded three ways:
// a hidden field that real people never fill, a limit per connection, and strict length limits.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  if (hits.size > 5000) hits.clear();
  const h = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  h.push(now); hits.set(ip, h);
  return h.length > 5;
}
const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const pick = (v, list) => (list.includes(v) ? v : null);

router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (clean(b.website, 50)) return res.json({ ok: true });            // a robot filled the hidden field: pretend it worked
    if (limited(req.ip)) return res.status(429).json({ error: 'Too many tries. Please wait a while and try again.' });
    const school = clean(b.school_name, 120), contact = clean(b.contact_name, 100);
    const phone = clean(b.phone, 25), email = clean(b.email, 120).toLowerCase();
    if (!school || !contact) return res.status(400).json({ error: 'Please fill in the school name and your name.' });
    if (!/^\+?[0-9 ()-]{9,20}$/.test(phone)) return res.status(400).json({ error: 'Please check the phone number.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please check the email address.' });
    await pool.query(
      `INSERT INTO school_applications (school_name, town, contact_name, contact_role, phone, email, students_range, bank, collects_via, start_when, message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [school, clean(b.town, 80), contact, clean(b.contact_role, 60), phone, email,
       pick(b.students_range, ['Under 200', '200 to 500', '500 to 1000', 'Over 1000']), clean(b.bank, 60),
       pick(b.collects_via, ['Bank paybill', 'Own M-Pesa paybill or till', 'Both', 'Not sure']),
       pick(b.start_when, ['This term', 'Next term', 'Just exploring']), clean(b.message, 500)]);
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error('apply failed:', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;