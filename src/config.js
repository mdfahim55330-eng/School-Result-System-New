"use strict";

require("dotenv").config();
const crypto = require("crypto");

const env = process.env;
const isProduction = env.NODE_ENV === "production";
const isTest = env.NODE_ENV === "test";

function toInt(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

const config = {
    isProduction,
    isTest,
    port: toInt(env.PORT, 3000),

    databaseUrl: env.DATABASE_URL || "",
    dbPoolMax: toInt(env.DB_POOL_MAX, 10),
    // DATABASE_SSL=true/false. Default: SSL on, unless the database is on this same machine.
    dbSsl: env.DATABASE_SSL,

    // Used to sign login sessions AND the QR-code verification links.
    // Keep it stable: if it changes, every printed QR code stops verifying.
    sessionSecret: env.SESSION_SECRET || "",
    verifySecret: env.VERIFY_SECRET || "",

    // e.g. https://your-school.onrender.com  (used inside QR codes)
    publicBaseUrl: (env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""),

    school: {
        name: env.SCHOOL_NAME || "Shaheed Nur Hossain Memorial School",
        address: env.SCHOOL_ADDRESS || "Biral, Dinajpur",
        eiin: env.SCHOOL_EIIN || ""
    },

    // "gpa"   -> pass students first: GPA (high to low), then total marks. Fail = no position.
    // "marks" -> pass students are ranked by total/merit marks only. Fail = no position.
    // Default is "marks" so class position follows total marks; set MERIT_MODE=gpa only if GPA-first ranking is required.
    meritMode: (env.MERIT_MODE || "marks").toLowerCase() === "gpa" ? "gpa" : "marks",

    upload: {
        maxBytes: toInt(env.UPLOAD_MAX_MB, 5) * 1024 * 1024,
        maxRows: toInt(env.UPLOAD_MAX_ROWS, 3000)
    },

    cacheSeconds: toInt(env.CACHE_SECONDS, 60),

    // Bootstrap admin (only used when the admins table is empty)
    bootstrapAdmin: {
        username: env.ADMIN_USERNAME || "",
        password: env.ADMIN_PASSWORD || ""
    }
};

// Secrets --------------------------------------------------------------
if (!config.sessionSecret) {
    if (isProduction && config.databaseUrl) {
        // Render may not have SESSION_SECRET configured yet. Derive a stable secret from
        // the already-private DATABASE_URL so the app can boot without a hard-coded secret.
        // A separately configured SESSION_SECRET is still preferred and should be used when available.
        config.sessionSecret = crypto
            .createHmac("sha256", "school-result-system-session-secret-v1")
            .update(config.databaseUrl)
            .digest("hex");
        console.warn("WARNING: SESSION_SECRET is not set. Using a stable derived secret from DATABASE_URL. Configure SESSION_SECRET in Render for best practice.");
    } else if (isProduction) {
        console.error(
            "\nFATAL: SESSION_SECRET is not set and DATABASE_URL is unavailable.\n" +
            "Set SESSION_SECRET in your hosting environment variables.\n"
        );
        process.exit(1);
    } else {
        config.sessionSecret = "dev-only-secret-change-me";
        if (!isTest) {
            console.warn("WARNING: SESSION_SECRET is not set. Using a development-only secret.");
        }
    }
}
if (!config.verifySecret) {
    config.verifySecret = config.sessionSecret;
}

config.classesWithFourthSubjectRule = ["nine", "ten", "9", "10", "ix", "x"];

module.exports = config;
