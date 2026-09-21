"use strict";

function httpError(status, message, extra) {
    const error = new Error(message);
    error.status = status;
    if (extra) Object.assign(error, extra);
    return error;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function clientIp(req) {
    return req.ip || (req.socket && req.socket.remoteAddress) || "";
}

// Natural sort for roll numbers: "2" < "10" < "10A"
function compareRoll(a, b) {
    return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true, sensitivity: "base" });
}

// Normalise a class name so "Nine", "nine", "Class 9", "IX" can be compared.
function normalizeClassName(name) {
    return String(name ?? "").toLowerCase().replace(/^class\s*/, "").replace(/[\s._-]+/g, "");
}

module.exports = { httpError, escapeHtml, clientIp, compareRoll, normalizeClassName };
