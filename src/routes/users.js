"use strict";

const express = require("express");
const bcrypt = require("bcrypt");
const db = require("../db");
const audit = require("../services/audit");
const { requireAdminRole } = require("../middleware/auth");
const { parse, z, text, password } = require("../validation");
const { httpError } = require("../utils");

const router = express.Router();

const ROLES = ["admin", "teacher"];

router.get("/users", requireAdminRole, async (req, res) => {
    const users = await db.all(
        `SELECT id, username, role, active, must_change_password, last_login, created_at
         FROM admins ORDER BY id ASC`
    );
    res.json({ success: true, users });
});

const createSchema = z.object({
    username: text(50, "Username").regex(/^[A-Za-z0-9._-]{3,50}$/, "Username: 3-50 letters, numbers, dot, dash or underscore."),
    password,
    role: z.enum(ROLES, { errorMap: () => ({ message: "Role must be admin or teacher." }) })
});

router.post("/users", requireAdminRole, async (req, res) => {
    const data = parse(createSchema, req.body || {});
    if (data.password.toLowerCase() === data.username.toLowerCase()) {
        throw httpError(400, "The password must not be the same as the username.");
    }

    const exists = await db.one(`SELECT id FROM admins WHERE LOWER(username) = LOWER(?)`, [data.username]);
    if (exists) throw httpError(400, "This username is already taken.");

    const hash = await bcrypt.hash(data.password, 12);
    // the new person must choose their own password at the first login
    const created = await db.one(
        `INSERT INTO admins (username, password, role, must_change_password) VALUES (?, ?, ?, TRUE) RETURNING id`,
        [data.username, hash, data.role]
    );

    await audit.log(req, "user_created", "admin", created.id, `Created ${data.role} account "${data.username}"`);
    res.json({ success: true, message: "User created. They must set a new password at first login.", id: created.id });
});

const updateSchema = z.object({
    role: z.enum(ROLES).optional(),
    active: z.boolean().optional()
});

async function activeAdminCount(exceptId) {
    const row = await db.one(
        `SELECT COUNT(*)::int AS n FROM admins WHERE role = 'admin' AND active = TRUE AND id <> ?`,
        [exceptId]
    );
    return row.n;
}

router.put("/users/:id", requireAdminRole, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(400, "Invalid user id.");
    const data = parse(updateSchema, req.body || {});

    const target = await db.one(`SELECT * FROM admins WHERE id = ?`, [id]);
    if (!target) throw httpError(404, "User not found.");

    const newRole = data.role ?? target.role;
    const newActive = data.active ?? target.active;

    if (id === req.user.id && (newRole !== "admin" || !newActive)) {
        throw httpError(400, "You cannot remove your own admin access or disable your own account.");
    }
    // there must always be at least one active admin
    if (target.role === "admin" && target.active && (newRole !== "admin" || !newActive)) {
        if ((await activeAdminCount(id)) === 0) throw httpError(400, "There must be at least one active admin.");
    }

    await db.query(`UPDATE admins SET role = ?, active = ? WHERE id = ?`, [newRole, newActive, id]);
    await audit.log(req, "user_updated", "admin", id,
        `Updated "${target.username}": role ${target.role} -> ${newRole}, ${target.active ? "active" : "disabled"} -> ${newActive ? "active" : "disabled"}`);
    res.json({ success: true, message: "User updated." });
});

const resetSchema = z.object({ new_password: password });

router.post("/users/:id/reset-password", requireAdminRole, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(400, "Invalid user id.");
    const { new_password } = parse(resetSchema, req.body || {});

    const target = await db.one(`SELECT id, username FROM admins WHERE id = ?`, [id]);
    if (!target) throw httpError(404, "User not found.");
    if (new_password.toLowerCase() === target.username.toLowerCase()) {
        throw httpError(400, "The password must not be the same as the username.");
    }

    const hash = await bcrypt.hash(new_password, 12);
    await db.query(`UPDATE admins SET password = ?, must_change_password = TRUE WHERE id = ?`, [hash, id]);
    await audit.log(req, "password_reset", "admin", id, `Reset the password of "${target.username}"`);
    res.json({ success: true, message: "Password reset. The user must choose a new one at next login." });
});

// ---- audit log ----------------------------------------------------------
router.get("/audit", requireAdminRole, async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const action = String(req.query.action || "").trim();
    const q = String(req.query.q || "").trim().slice(0, 100);

    const where = [];
    const params = [];
    if (action) { where.push(`action = ?`); params.push(action); }
    if (q) {
        where.push(`(summary ILIKE ? OR username ILIKE ?)`);
        const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
        params.push(like, like);
    }
    const clause = where.length ? "WHERE " + where.join(" AND ") : "";

    const total = (await db.one(`SELECT COUNT(*)::int AS n FROM audit_log ${clause}`, params)).n;
    const rows = await db.all(
        `SELECT id, created_at, username, role, action, entity, entity_id, summary, details, ip
         FROM audit_log ${clause} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`,
        params
    );
    const actions = (await db.all(`SELECT DISTINCT action FROM audit_log ORDER BY action`)).map((r) => r.action);
    res.json({ success: true, total, logs: rows, actions });
});

module.exports = router;
