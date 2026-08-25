const { Pool } = require('pg');

// Enable SSL for any remote/hosted Postgres (Render, Supabase, etc.) but not
// for a plain local database during development, which usually has no SSL cert.
const isLocal = process.env.DATABASE_URL && (
    process.env.DATABASE_URL.includes('localhost') ||
    process.env.DATABASE_URL.includes('127.0.0.1')
);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false }
});

module.exports = pool;
