"use strict";

const db = require("../db");
const { clientIp } = require("../utils");

/**
 * Write one line to the audit log. Never throws (an audit problem must not break the real work).
 *   actor: req (uses the logged-in admin) or { username } for system events.
 */
async function log(actor, action, entity, entityId, summary, details) {
    try {
        const session = actor && actor.session ? actor.session : {};
        await db.query(
            `INSERT INTO audit_log (admin_id, username, role, action, entity, entity_id, summary, details, ip)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                session.adminId || null,
                session.adminUsername || (actor && actor.username) || null,
                session.role || null,
                action,
                entity || null,
                entityId === undefined || entityId === null ? null : String(entityId),
                summary || null,
                details ? JSON.stringify(details) : null,
                actor && actor.ip !== undefined ? clientIp(actor) : null
            ]
        );
    } catch (error) {
        console.error("Audit log error:", error.message);
    }
}

module.exports = { log };
