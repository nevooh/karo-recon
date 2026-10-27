const { pool } = require('../db/db');

// The payment channels we support. (More banks later = add the code here and in the table's CHECK.)
const CHANNELS = ['mpesa', 'kcb', 'equity', 'coop'];

// Which channels the school picked.
async function getSelected(schoolId) {
  const r = await pool.query(`SELECT channel FROM school_channels WHERE school_id = $1`, [schoolId]);
  return r.rows.map((x) => x.channel);
}

// Replace the school's whole pick list in ONE statement (so it is all-or-nothing).
// Unpicking only hides a channel. It never touches the bank connection.
async function setSelected(schoolId, channels) {
  await pool.query(
    `WITH removed AS (DELETE FROM school_channels WHERE school_id = $1 AND channel <> ALL($2::text[]) RETURNING 1)
     INSERT INTO school_channels (school_id, channel) SELECT $1, c FROM unnest($2::text[]) AS c ON CONFLICT DO NOTHING`,
    [schoolId, channels]
  );
}

// Used when a bank is connected: connecting a channel means the school uses it,
// so it can never be "connected but hidden".
async function ensureSelected(schoolId, channel) {
  if (!CHANNELS.includes(channel)) return;
  await pool.query(
    `INSERT INTO school_channels (school_id, channel) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [schoolId, channel]
  );
}

// setup_needed     = nothing saved for this channel yet
// waiting_for_bank = saved, but no payment has arrived yet
// connected        = at least one payment arrived through it
function statusFor(setUp, payments) {
  if (!setUp) return 'setup_needed';
  return payments > 0 ? 'connected' : 'waiting_for_bank';
}

module.exports = { CHANNELS, getSelected, setSelected, ensureSelected, statusFor };