"use strict";

const { Pool } = require("pg");
const config = require("./config");

function shouldUseSsl(url) {
    if (config.dbSsl !== undefined && config.dbSsl !== "") {
        return String(config.dbSsl).toLowerCase() === "true";
    }
    if (!url) return false;
    try {
        const host = new URL(url).hostname;
        return !["localhost", "127.0.0.1", "::1", ""].includes(host);
    } catch (e) {
        return true;
    }
}

if (!config.databaseUrl) {
    console.error("DATABASE_URL is not set.");
}

const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: shouldUseSsl(config.databaseUrl) ? { rejectUnauthorized: false } : false,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000
});

pool.on("error", (err) => {
    console.error("PostgreSQL pool error:", err.message);
});

// Convert "?" placeholders to $1, $2 ... so SQL can be written either way.
function convertPlaceholders(sql) {
    if (!sql.includes("?")) return sql;
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
}

/** Run one query. Returns the pg result ({ rows, rowCount }). */
function query(sql, params = []) {
    return pool.query(convertPlaceholders(sql), params);
}

/** First row or null. */
async function one(sql, params = []) {
    const result = await query(sql, params);
    return result.rows[0] || null;
}

/** All rows. */
async function all(sql, params = []) {
    const result = await query(sql, params);
    return result.rows;
}

/**
 * Run work inside a real transaction on its own connection.
 *   await tx(async (client) => { await client.query(...); return value; });
 * Commits on success, rolls back on any error, always releases the connection.
 */
async function tx(work) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const value = await work(client);
        await client.query("COMMIT");
        return value;
    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch (rollbackError) {
            console.error("Rollback error:", rollbackError.message);
        }
        throw error;
    } finally {
        client.release();
    }
}

async function close() {
    await pool.end();
}

module.exports = { pool, query, one, all, tx, close };
