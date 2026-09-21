"use strict";

const express = require("express");
const bcrypt = require("bcrypt");
const db = require("../db");
const audit = require("../services/audit");
const { requireLogin } = require("../middleware/auth");
const { loginLimiter } = require("../middleware/security");
const { parse, z, password } = require("../validation");
const { httpError } = require("../utils");

const router = express.Router();

// A real bcrypt hash of a random value: used so a wrong username takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password-" + Date.now(), 10);

const loginSchema = z.object({
    username: z.string({ required_error: "Username and password are required." }).trim().min(1, "Username and password are required.").max(100),
    password: z.string({ required_error: "Username and password are required." }).min(1, "Username and password are required.").max(200)
});

function regenerate(req) {
    return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}
function save(req) {
    return new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

// ---- LOGIN ---------------------------------------------------------------
router.post("/login", loginLimiter, async (req, res) => {
    const { username, password: plain } = parse(loginSchema, req.body || {});

    const admin = await db.one(`SELECT * FROM admins WHERE username = ?`, [username]);
    const match = await bcrypt.compare(plain, admin ? admin.password : DUMMY_HASH);

    if (!admin || !match || !admin.active) {
        await audit.log(req, "login_failed", "admin", null, `Failed login for "${username.slice(0, 60)}"`);
        return res.status(401).json({ success: false, message: "Invalid username or password." });
    }

    // brand-new session id after login (prevents session fixation)
    await regenerate(req);
    req.session.adminId = admin.id;
    req.session.adminUsername = admin.username;
    req.session.role = admin.role;
    await save(req);

    await db.query(`UPDATE admins SET last_login = now() WHERE id = ?`, [admin.id]);
    await audit.log(req, "login", "admin", admin.id, `${admin.username} logged in`);

    res.json({
        success: true,
        message: "Login successful.",
        username: admin.username,
        role: admin.role,
        must_change_password: !!admin.must_change_password
    });
});

// ---- WHO AM I ------------------------------------------------------------
router.get("/me", async (req, res) => {
    if (!req.session || !req.session.adminId) return res.json({ loggedIn: false });

    const admin = await db.one(
        `SELECT username, role, active, must_change_password FROM admins WHERE id = ?`,
        [req.session.adminId]
    );
    if (!admin || !admin.active) return res.json({ loggedIn: false });

    res.json({
        loggedIn: true,
        username: admin.username,
        role: admin.role,
        mustChangePassword: !!admin.must_change_password
    });
});

// ---- LOGOUT --------------------------------------------------------------
router.post("/logout", (req, res, next) => {
    if (!req.session) return res.json({ success: true, message: "Logout successful." });
    req.session.destroy((err) => {
        if (err) return next(err);
        res.clearCookie("srs.sid");
        res.json({ success: true, message: "Logout successful." });
    });
});

// ---- CHANGE OWN PASSWORD -------------------------------------------------
const changeSchema = z.object({
    current_password: z.string({ required_error: "Current password is required." }).min(1, "Current password is required."),
    new_password: password
});

router.post("/change-password", requireLogin, async (req, res) => {
    const { current_password, new_password } = parse(changeSchema, req.body || {});

    const admin = await db.one(`SELECT id, username, password FROM admins WHERE id = ?`, [req.user.id]);
    const ok = await bcrypt.compare(current_password, admin.password);
    if (!ok) throw httpError(400, "Current password is not correct.");
    if (new_password === current_password) throw httpError(400, "The new password must be different from the current one.");
    if (new_password.toLowerCase() === admin.username.toLowerCase()) {
        throw httpError(400, "The password must not be the same as the username.");
    }

    const hash = await bcrypt.hash(new_password, 12);
    await db.query(`UPDATE admins SET password = ?, must_change_password = FALSE WHERE id = ?`, [hash, admin.id]);
    await audit.log(req, "password_changed", "admin", admin.id, `${admin.username} changed their password`);

    res.json({ success: true, message: "Password changed successfully." });
});

module.exports = router;
