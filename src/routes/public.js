"use strict";\n\nconst crypto = require("crypto");

const express = require("express");
const db = require("../db");
const cache = require("../cache");
const config = require("../config");
const verify = require("../services/verify");
const pdf = require("../services/pdf");
const view = require("../views/verify");
const { publicLimiter, pdfLimiter } = require("../middleware/security");
const { parse, z, text, int } = require("../validation");
const { httpError } = require("../utils");
const { lookupPublished, buildResultData } = require("../services/results");

const router = express.Router();

const NOT_FOUND = "Result not found or result has not been published.";

router.get("/api/result/options", publicLimiter, async (req, res) => {
    const options = await cache.remember("public:options", () =>
        db.all(
            `SELECT class_name, exam_name, exam_year
             FROM students WHERE status = 'published'
             GROUP BY class_name, exam_name, exam_year
             ORDER BY class_name ASC, exam_year DESC`
        )
    );
    res.setHeader("Cache-Control", "private, max-age=30");
    res.json({ success: true, options });
});

const searchSchema = z.object({
    roll: text(50, "Roll"),
    class_name: text(50, "Class"),
    exam_name: text(150, "Exam name"),
    exam_year: int("Exam year")
});

function readSearch(query) {
    if (!query.roll || !query.class_name || !query.exam_name || !query.exam_year) {
        throw httpError(400, "Roll, Class, Exam Name and Exam Year are required.");
    }
    return parse(searchSchema, query);
}

async function findResult(query) {
    const q = readSearch(query);
    const found = await lookupPublished(q);
    if (found.kind === "none") throw httpError(404, NOT_FOUND);
    if (found.kind === "ambiguous") {
        throw httpError(409, "More than one result was found for this roll. Please contact the school office.");
    }
    return found.student;
}

router.get("/api/result/captcha", publicLimiter, (req, res) => {
    const a = crypto.randomInt(2, 10);
    const b = crypto.randomInt(1, 10);
    req.session.resultCaptcha = { answer: String(a + b), expires: Date.now() + 5 * 60 * 1000 };
    const noise = Array.from({ length: 7 }, (_, i) =>
        '<line x1="' + crypto.randomInt(0, 180) + '" y1="' + crypto.randomInt(5, 42) +
        '" x2="' + crypto.randomInt(0, 180) + '" y2="' + crypto.randomInt(5, 42) +
        '" stroke="#94a3b8" stroke-width="1"/>').join("");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="48" viewBox="0 0 180 48">' +
        '<rect width="180" height="48" rx="7" fill="#f1f5f9"/>' + noise +
        '<text x="90" y="32" text-anchor="middle" font-family="Arial,sans-serif" font-size="23" font-weight="700" fill="#1e3a8a">' +
        a + ' + ' + b + ' = ?</text></svg>';
    res.setHeader("Cache-Control", "no-store");
    res.type("image/svg+xml").send(svg);
});

router.post("/api/result/search", publicLimiter, async (req, res) => {
    const challenge = req.session.resultCaptcha;
    delete req.session.resultCaptcha;
    const answer = String(req.body.captcha || "").trim();
    if (!challenge || challenge.expires < Date.now() || !/^\d{1,2}$/.test(answer) || answer !== challenge.answer) {
        throw httpError(400, "Invalid or expired CAPTCHA. Please try again.");
    }
    delete req.session.resultAccessStudentId;
    const student = await findResult(req.body);
    req.session.resultAccessStudentId = Number(student.id);
    const data = await buildResultData(student);

    const url = verify.verifyUrl(req, student.id);
    data.verify_url = url;
    data.qr = await verify.qrDataUrl(url);

    res.setHeader("Cache-Control", "private, max-age=30");
    res.json({ success: true, ...data });
});

router.get("/api/result/marksheet-data", publicLimiter, async (req, res) => {
    const student = await findResult(req.query);
    if (!req.session.resultAccessStudentId || Number(req.session.resultAccessStudentId) !== Number(student.id)) {
        throw httpError(403, "Please complete the CAPTCHA and search for this result first.");
    }
    const data = await buildResultData(student);
    const url = verify.verifyUrl(req, student.id);
    data.verify_url = url;
    data.qr = await verify.qrDataUrl(url);
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, ...data });
});

router.get("/api/result/marksheet.pdf", pdfLimiter, async (req, res) => {
    const student = await findResult(req.query);
    if (!req.session.resultAccessStudentId || Number(req.session.resultAccessStudentId) !== Number(student.id)) {
        throw httpError(403, "Please complete the CAPTCHA and search for this result first.");
    }
    const data = await buildResultData(student);
    const qr = await verify.qrBuffer(verify.verifyUrl(req, student.id));

    const doc = pdf.createDocument(`Marksheet - ${student.name}`);
    doc.on("error", (e) => console.error("PDF error:", e.message));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition",
        `inline; filename="marksheet-${String(student.roll).replace(/[^A-Za-z0-9]+/g, "-")}-${student.exam_year}.pdf"`);
    res.setHeader("Cache-Control", "private, max-age=30");
    doc.pipe(res);
    pdf.drawMarksheet(doc, data, { qrBuffer: qr });
    doc.end();
});

// The page a scanned QR code opens
router.get("/verify/:id/:sig", publicLimiter, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex");

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !verify.isValidSignature(id, req.params.sig)) {
        return res.status(404).send(view.invalid("This verification link is not valid."));
    }

    const student = await db.one(
        `SELECT id, name, roll, registration, class_name, group_name, exam_name, exam_year, institute_name, eiin, status
         FROM students WHERE id = ? AND status = 'published'`,
        [id]
    );
    if (!student) {
        return res.status(404).send(view.invalid("This result is not available (it may have been withdrawn)."));
    }
    const data = await buildResultData(student);
    res.send(view.valid(config.school, data));
});

router.get("/healthz", async (req, res) => {
    try {
        await db.query("SELECT 1");
        res.json({ ok: true });
    } catch (e) {
        res.status(503).json({ ok: false });
    }
});

module.exports = router;
