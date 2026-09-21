"use strict";

const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const config = require("../config");

function securityHeaders() {
    return helmet({
        contentSecurityPolicy: {
            useDefaults: false,
            directives: {
                defaultSrc: ["'self'"],
                // the existing pages use inline <script>/<style>, so 'unsafe-inline' is needed for now
                scriptSrc: ["'self'", "'unsafe-inline'"],
                scriptSrcAttr: ["'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", "data:"],
                fontSrc: ["'self'", "data:"],
                connectSrc: ["'self'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"]
            }
        },
        crossOriginEmbedderPolicy: false,
        // "cross-origin" would let other sites embed our images; default same-origin is fine.
        hsts: config.isProduction ? undefined : false
    });
}

function limiter({ windowMs, limit, message, skipSuccessfulRequests = false }) {
    if (config.isTest) {
        return (req, res, next) => next();
    }
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        skipSuccessfulRequests,
        handler: (req, res) => {
            res.status(429).json({ success: false, message });
        }
    });
}

const loginLimiter = limiter({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    message: "Too many login attempts. Please wait 15 minutes and try again."
});

const publicLimiter = limiter({
    windowMs: 60 * 1000,
    limit: 90,
    message: "Too many requests. Please wait a minute and try again."
});

const pdfLimiter = limiter({
    windowMs: 10 * 60 * 1000,
    limit: 40,
    message: "Too many downloads. Please wait a few minutes and try again."
});

/**
 * Blocks "cross-site" changes: if the browser says the request comes from another website
 * (Origin header), it is refused. Normal same-site use and tools without Origin are fine.
 */
function sameOriginOnly(req, res, next) {
    const method = req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();

    const origin = req.get("origin");
    if (!origin) return next();

    try {
        const originHost = new URL(origin).host;
        const allowed = new Set([req.get("host")]);
        if (config.publicBaseUrl) allowed.add(new URL(config.publicBaseUrl).host);
        if (allowed.has(originHost)) return next();
    } catch (e) { /* fall through */ }

    return res.status(403).json({ success: false, message: "Cross-site request blocked." });
}

module.exports = { securityHeaders, loginLimiter, publicLimiter, pdfLimiter, sameOriginOnly };
