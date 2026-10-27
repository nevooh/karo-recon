const { pool } = require('../db/db');
const { encrypt, decrypt } = require('../security/crypto');

/**
 * Creates a school with its own M-Pesa credentials, encrypted before they
 * ever touch the database. This replaces the single shared .env approach -
 * each school now has its own keys, so you can onboard a second, third,
 * etc. school without ever editing server config again.
 */
async function createSchoolWithCredentials({ name, mpesaShortcode, mpesaConsumerKey, mpesaConsumerSecret }) {
  const result = await pool.query(
    `INSERT INTO schools (name, mpesa_shortcode, mpesa_consumer_key_enc, mpesa_consumer_secret_enc)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, mpesa_shortcode`,
    [name, mpesaShortcode, encrypt(mpesaConsumerKey), encrypt(mpesaConsumerSecret)]
  );
  return result.rows[0];
}

/**
 * Fetches a school and returns its M-Pesa credentials decrypted, ready to
 * hand to the mpesa connector functions. Only call this right before you
 * need the actual keys (e.g. registering URLs, simulating a payment) -
 * never log or store the decrypted result anywhere.
 */
async function getSchoolCredentials(schoolId) {
  const result = await pool.query(
    `SELECT id, name, mpesa_shortcode, mpesa_consumer_key_enc, mpesa_consumer_secret_enc
     FROM schools WHERE id = $1`,
    [schoolId]
  );
  const school = result.rows[0];
  if (!school) return null;

  return {
    id: school.id,
    name: school.name,
    shortcode: school.mpesa_shortcode,
    consumerKey: decrypt(school.mpesa_consumer_key_enc),
    consumerSecret: decrypt(school.mpesa_consumer_secret_enc),
  };
}

module.exports = { createSchoolWithCredentials, getSchoolCredentials };