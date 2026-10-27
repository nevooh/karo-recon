const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// DATABASE_URL is the one connection string every Postgres host (Neon,
// Supabase, Render Postgres) gives you - format:
// postgres://user:password@host:port/dbname
const dbUrl = process.env.DATABASE_URL || '';

if (!dbUrl) {
  console.error(
    '\nDATABASE_URL is not set. This usually means there is no .env file ' +
    'in this folder (it is not included in the zip on purpose, since it ' +
    'holds real credentials). Copy .env.example to .env and fill it in.\n'
  );
}

const isLocalDb = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1') || dbUrl === '';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon/Supabase/Render all require SSL for external connections; a local
  // Postgres install does not support SSL at all by default. Missing
  // DATABASE_URL entirely is treated as "local dev", not "needs SSL" -
  // getting this backwards is what caused a real bug earlier.
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

async function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  const feeSchema = fs.readFileSync(path.join(__dirname, 'fee_structure_schema.sql'), 'utf8');
  await pool.query(feeSchema);
  const stkSchema = fs.readFileSync(path.join(__dirname, 'stk_schema.sql'), 'utf8');
  await pool.query(stkSchema);
  const parentSchema = fs.readFileSync(path.join(__dirname, 'parent_schema.sql'), 'utf8');   // must come after stk_schema.sql
  await pool.query(parentSchema);
  const ownerSchema = fs.readFileSync(path.join(__dirname, 'owner_schema.sql'), 'utf8');
  await pool.query(ownerSchema);
}

module.exports = { pool, initSchema };