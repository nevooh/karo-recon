const { pool } = require('../db/db');
const { decrypt } = require('../security/crypto');
const coop = require('../connectors/coop');
const { ingestPayment } = require('./ingest');

// How often to ask Co-op for new transactions, per school. 5 minutes is a
// reasonable balance: frequent enough that a payment shows up promptly,
// infrequent enough not to hammer their API for no real benefit - school
// fee payments aren't the kind of thing where a few minutes' delay matters.
const POLL_INTERVAL_MS = 5 * 60 * 1000;

let isPolling = false; // guards against overlapping runs if one poll is slow

/**
 * Polls Co-op for every school that's connected to it, feeding whatever
 * comes back through the exact same ingestPayment() every webhook uses -
 * the matching engine doesn't know or care that this arrived via polling
 * instead of a push notification.
 */
async function pollAllCoopConnections() {
  const result = await pool.query(
    `SELECT sbc.school_id, sbc.account_number, sbc.credentials_enc
     FROM school_bank_connections sbc
     JOIN bank_providers bp ON bp.id = sbc.provider_id
     WHERE bp.code = 'coop'`
  );

  for (const row of result.rows) {
    try {
      const credentials = JSON.parse(decrypt(row.credentials_enc) || '{}');
      const transactions = await coop.fetchRecentTransactions({
        apiKey: credentials.api_key,
        accountNumber: row.account_number,
      });

      for (const raw of transactions) {
        const payment = coop.normalizeTransaction(raw);
        const result = await ingestPayment({ ...payment, school_id: row.school_id });
        if (!result.alreadyProcessed) {
          console.log(`Ingested Co-op ${payment.external_ref} for school ${row.school_id}: ${result.match.status}`);
        }
      }
    } catch (err) {
      // One school's Co-op connection failing (bad creds, their API down,
      // etc.) should never stop the other schools from being polled.
      console.error(`Co-op poll failed for school ${row.school_id}:`, err.message);
    }
  }
}

/**
 * Starts the recurring poll. Call this once when the server boots.
 */
function startCoopPolling() {
  setInterval(async () => {
    if (isPolling) return; // previous run still in progress, skip this tick
    isPolling = true;
    try {
      await pollAllCoopConnections();
    } finally {
      isPolling = false;
    }
  }, POLL_INTERVAL_MS);

  console.log(`Co-op polling scheduler started (every ${POLL_INTERVAL_MS / 60000} minutes)`);
}

module.exports = { pollAllCoopConnections, startCoopPolling };