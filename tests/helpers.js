"use strict";

// Test settings. Needs a PostgreSQL database you do not mind wiping:
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/srs_test npm test
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL_TEST || "postgres://postgres:pw@localhost:5432/srs_test";
process.env.SESSION_SECRET = "test-session-secret";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "Admin@12345";
process.env.CACHE_SECONDS = process.env.CACHE_SECONDS || "60";

const db = require("../src/db");
const { migrate } = require("../src/migrate");
const { createApp } = require("../src/app");

async function resetDatabase() {
    await db.query(`DROP SCHEMA public CASCADE`);
    await db.query(`CREATE SCHEMA public`);
}

async function startServer({ reset = true } = {}) {
    if (reset) await resetDatabase();
    await migrate();
    const app = createApp();
    const server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        base,
        async stop() {
            await new Promise((r) => server.close(r));
            await db.close();
        }
    };
}

/** A tiny HTTP client that remembers cookies (like a browser). */
function client(base) {
    const jar = new Map();
    async function request(method, path, { json, form, headers = {}, raw } = {}) {
        const h = { ...headers };
        if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
        let body;
        if (json !== undefined) { h["content-type"] = "application/json"; body = JSON.stringify(json); }
        if (form) body = form;
        const res = await fetch(base + path, { method, headers: h, body, redirect: "manual" });
        for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
            const [pair] = c.split(";");
            const i = pair.indexOf("=");
            const name = pair.slice(0, i);
            const value = pair.slice(i + 1);
            if (/expires=Thu, 01 Jan 1970/i.test(c) || value === "") jar.delete(name); else jar.set(name, value);
        }
        if (raw) return res;
        const type = res.headers.get("content-type") || "";
        const data = type.includes("json") ? await res.json() : await res.text();
        return { status: res.status, data, headers: res.headers };
    }
    return {
        get: (p, o) => request("GET", p, o),
        post: (p, json, o = {}) => request("POST", p, { json, ...o }),
        put: (p, json, o = {}) => request("PUT", p, { json, ...o }),
        del: (p, json, o = {}) => request("DELETE", p, { json, ...o }),
        request,
        cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ")
    };
}

module.exports = { startServer, client, db, resetDatabase };
