const { pool } = require('../db/db');
const { encrypt, decrypt } = require('../security/crypto');

/**
 * Returns the list of banks the platform supports, including which
 * credential fields each one needs - this is what a frontend dropdown
 * would call to build the "which bank do you use?" step, and then render
 * the right form fields once a bank is picked.
 */
async function listBankProviders() {
  const result = await pool.query(
    `SELECT id, code, name, credential_fields FROM bank_providers ORDER BY name`
  );
  return result.rows;
}

/**
 * Connects a school to a specific bank, encrypting whatever credentials
 * that bank needs as one JSON blob (different banks need different fields -
 * see credential_fields on bank_providers).
 */
async function connectSchoolToBank({ schoolId, providerCode, accountNumber, credentials }) {
  const providerResult = await pool.query(
    `SELECT id FROM bank_providers WHERE code = $1`,
    [providerCode]
  );
  const provider = providerResult.rows[0];
  if (!provider) throw new Error(`Unknown bank provider: ${providerCode}`);

  const encryptedBlob = encrypt(JSON.stringify(credentials || {}));

  const result = await pool.query(
    `INSERT INTO school_bank_connections (school_id, provider_id, account_number, credentials_enc)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (school_id, provider_id)
     DO UPDATE SET account_number = $3, credentials_enc = $4
     RETURNING id`,
    [schoolId, provider.id, accountNumber, encryptedBlob]
  );
  return result.rows[0];
}

/**
 * Fetches and decrypts a school's connection to a specific bank. Only call
 * this right before you need the actual credentials (e.g. calling that
 * bank's API) - never log or store the decrypted result.
 */
async function getSchoolBankConnection(schoolId, providerCode) {
  const result = await pool.query(
    `SELECT sbc.account_number, sbc.credentials_enc, bp.code, bp.name
     FROM school_bank_connections sbc
     JOIN bank_providers bp ON bp.id = sbc.provider_id
     WHERE sbc.school_id = $1 AND bp.code = $2`,
    [schoolId, providerCode]
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    providerCode: row.code,
    providerName: row.name,
    accountNumber: row.account_number,
    credentials: JSON.parse(decrypt(row.credentials_enc) || '{}'),
  };
}

/**
 * Lists which banks a school has connected, WITHOUT decrypting anything -
 * safe to use for a "your connected banks" settings screen.
 */
async function listSchoolBankConnections(schoolId) {
  const result = await pool.query(
    `SELECT bp.code, bp.name, sbc.account_number, sbc.created_at
     FROM school_bank_connections sbc
     JOIN bank_providers bp ON bp.id = sbc.provider_id
     WHERE sbc.school_id = $1`,
    [schoolId]
  );
  return result.rows;
}

module.exports = { listBankProviders, connectSchoolToBank, getSchoolBankConnection, listSchoolBankConnections };