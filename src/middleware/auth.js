"use strict";

const db = require("../db");

// These paths stay open while an admin still has to choose a new password.
const OPEN_WHILE_MUST_CHANGE = new Set([
    "/api/admin/me",
    "/api/admin/logout",
    "/api/admin/change-password"
]);

/**
 * Must be logged in. The account is re-checked in the database on every request, so
 * disabling an account or changing its role takes effect immediately.
 */
async function requireLogin(req, res, next) {
    try {
        if (!req.session || !req.session.adminId) {
            return res.status(401).json({ success: false, message: "Admin login required." });
        }

        const admin = await db.one(
            `SELECT id, username, role, active, must_change_password FROM admins WHERE id = ?`,
            [req.session.adminId]
        );

        if (!admin || !admin.active) {
            return req.session.destroy(() => {
                res.status(401).json({ success: false, message: "Your account is not active. Please contact the admin." });
            });
        }

        req.user = { id: admin.id, username: admin.username, role: admin.role };
        req.session.role = admin.role;
        req.session.adminUsername = admin.username;

        const fullPath = (req.baseUrl || "") + (req.path || "");
        if (admin.must_change_password && !OPEN_WHILE_MUST_CHANGE.has(fullPath)) {
            return res.status(403).json({
                success: false,
                code: "PASSWORD_CHANGE_REQUIRED",
                message: "Please set a new password first."
            });
        }
        next();
    } catch (error) {
        next(error);
    }
}

/** Use AFTER requireLogin: only the listed roles may continue. */
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                message: "You do not have permission to do this. Please ask an admin."
            });
        }
        next();
    };
}

const requireAdminRole = requireRole("admin");

module.exports = { requireLogin, requireRole, requireAdminRole };
