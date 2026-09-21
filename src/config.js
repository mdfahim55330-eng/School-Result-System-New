"use strict";

require("dotenv").config();

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
    // "marks" -> old behaviour: only total marks decide the position.
    meritMode: (env.MERIT_MODE || "gpa").toLowerCase() === "marks" ? "marks" : "gpa",

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
    if (isProduction) {
        // Refuse to start: a public default secret would make sessions and QR links forgeable.
        console.error(
            "\nFATAL: SESSION_SECRET is not set.\n" +
            "Set a long random value in your hosting environment variables, e.g.:\n" +
            "  node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"\n"
        );
        process.exit(1);
    }
    config.sessionSecret = "dev-only-secret-change-me";
    if (!isTest) {
        console.warn("WARNING: SESSION_SECRET is not set. Using a development-only secret.");
    }
}
if (!config.verifySecret) {
    config.verifySecret = config.sessionSecret;
}

config.classesWithFourthSubjectRule = ["nine", "ten", "9", "10", "ix", "x"];

module.exports = config;
