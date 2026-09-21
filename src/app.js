"use strict";

const path = require("path");
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const compression = require("compression");
const multer = require("multer");

const config = require("./config");
const db = require("./db");
const cache = require("./cache");
const { securityHeaders, sameOriginOnly } = require("./middleware/security");
const { requireLogin } = require("./middleware/auth");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

// Pages that only logged-in staff may open (the server redirects everybody else to the login page)
const STAFF_PAGES = {
    "admin": "any",
    "classes": "any",
    "subjects": "any",
    "exams": "any",
    "individual-result": "any",
    "result-list": "any",
    "bulk-result": "any",
    "merit-list": "any",
    "tabulation": "any",
    "statistics": "any",
    "marksheet-management": "any",
    "users": "admin"
};

async function guardStaffPages(req, res, next) {
    const match = req.path.match(/^\/([A-Za-z0-9-]+)\.html$/);
    if (!match || !Object.prototype.hasOwnProperty.call(STAFF_PAGES, match[1])) return next();

    res.setHeader("Cache-Control", "no-store");
    if (!req.session || !req.session.adminId) return res.redirect("/pages/admin-login.html");

    const admin = await db.one(`SELECT role, active, must_change_password FROM admins WHERE id = ?`, [req.session.adminId]);
    if (!admin || !admin.active) return res.redirect("/pages/admin-login.html");
    if (admin.must_change_password) return res.redirect("/pages/change-password.html");
    if (STAFF_PAGES[match[1]] === "admin" && admin.role !== "admin") return res.redirect("/pages/admin.html");
    next();
}

function invalidateCacheAfterChanges(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") {
        res.on("finish", () => {
            if (res.statusCode < 400) cache.clear();
        });
    }
    next();
}

function createApp() {
    const app = express();

    app.set("trust proxy", 1);
    app.disable("x-powered-by");

    app.use(securityHeaders());
    app.use(compression());
    app.use(express.json({ limit: "1mb" }));
    app.use(express.urlencoded({ extended: false, limit: "100kb" }));

    app.use(session({
        name: "srs.sid",
        store: new PgSession({ pool: db.pool, tableName: "session", createTableIfMissing: false, pruneSessionInterval: 900 }),
        secret: config.sessionSecret,
        resave: false,
        saveUninitialized: false,
        rolling: true,
        cookie: {
            httpOnly: true,
            secure: "auto",
            sameSite: "lax",
            maxAge: 8 * 60 * 60 * 1000
        }
    }));

    app.use(sameOriginOnly);

    // ---- pages ----
    app.use("/pages", guardStaffPages);
    app.use(express.static(PUBLIC_DIR, {
        index: "index.html",
        setHeaders(res, file) {
            if (/\.(html)$/i.test(file)) res.setHeader("Cache-Control", "no-cache");
            else res.setHeader("Cache-Control", "public, max-age=3600");
        }
    }));

    // ---- public API + verify page ----
    app.use(require("./routes/public"));

    // ---- staff API ----
    const staff = express.Router();
    staff.use(require("./routes/auth"));   // login / me / logout / change-password
    staff.use(requireLogin);               // everything below needs a logged-in account
    staff.use(invalidateCacheAfterChanges);
    staff.use(require("./routes/catalog"));
    staff.use(require("./routes/results"));
    staff.use(require("./routes/bulk"));
    staff.use(require("./routes/reports"));
    staff.use(require("./routes/users"));
    app.use("/api/admin", staff);

    app.use("/api", (req, res) => res.status(404).json({ success: false, message: "Not found." }));

    // ---- errors ----
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (res.headersSent) return next(err);

        let status = err.status || err.statusCode || 500;
        let message = err.message;

        if (err instanceof multer.MulterError) {
            status = 400;
            message = err.code === "LIMIT_FILE_SIZE"
                ? `The file is too large (maximum ${Math.round(config.upload.maxBytes / 1024 / 1024)} MB).`
                : "The file could not be uploaded.";
        } else if (err.type === "entity.parse.failed") {
            status = 400;
            message = "Invalid request data.";
        } else if (err.type === "entity.too.large") {
            status = 413;
            message = "The request is too large.";
        } else if (err.code === "23505") {
            status = 409;
            message = "This record already exists.";
        } else if (status >= 500) {
            console.error(`Server error on ${req.method} ${req.originalUrl}:`, err);
            message = "Server error. Please try again.";
            status = 500;
        }

        if (req.originalUrl.startsWith("/api")) {
            return res.status(status).json({ success: false, message });
        }
        res.status(status).type("text/plain").send(message);
    });

    return app;
}

module.exports = { createApp };
