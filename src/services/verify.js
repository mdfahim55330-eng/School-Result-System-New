"use strict";

const crypto = require("crypto");
const QRCode = require("qrcode");
const config = require("../config");

// Every result gets a link like  /verify/123/AbC...  The last part is a signature that only this
// server can create, so nobody can guess or forge a link for a different student.
function signature(studentId) {
    return crypto
        .createHmac("sha256", config.verifySecret)
        .update("verify:" + Number(studentId))
        .digest("base64url")
        .slice(0, 22);
}

function isValidSignature(studentId, sig) {
    const expected = Buffer.from(signature(studentId));
    const given = Buffer.from(String(sig || ""));
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function baseUrl(req) {
    if (config.publicBaseUrl) return config.publicBaseUrl;
    return `${req.protocol}://${req.get("host")}`;
}

function verifyUrl(req, studentId) {
    return `${baseUrl(req)}/verify/${Number(studentId)}/${signature(studentId)}`;
}

function qrDataUrl(text) {
    return QRCode.toDataURL(text, { margin: 1, width: 240, errorCorrectionLevel: "M" });
}

function qrBuffer(text) {
    return QRCode.toBuffer(text, { margin: 1, width: 300, errorCorrectionLevel: "M" });
}

module.exports = { signature, isValidSignature, verifyUrl, qrDataUrl, qrBuffer };
