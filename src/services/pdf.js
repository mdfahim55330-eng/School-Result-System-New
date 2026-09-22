"use strict";

const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");

const ROOT = path.join(__dirname, "..", "..");
const FONT_REGULAR = path.join(ROOT, "assets", "fonts", "HindSiliguri-Regular.ttf");
const FONT_BOLD = path.join(ROOT, "assets", "fonts", "HindSiliguri-Bold.ttf");
const LOGO = path.join(ROOT, "public", "6716-removebg-preview.png");
const SIGNATURE = path.join(ROOT, "public", "head-signature.png");

const COLORS = { ink: "#111827", muted: "#4b5563", line: "#9ca3af", head: "#e5e7eb", brand: "#1e3a8a" };

function createDocument(title) {
    const doc = new PDFDocument({
        size: "A4",
        margin: 0,
        autoFirstPage: false,
        info: { Title: title, Author: "School Result System" }
    });
    doc.registerFont("body", FONT_REGULAR);
    doc.registerFont("bold", FONT_BOLD);
    return doc;
}

// Shorten text with "..." so it never runs into the next column (pdfkit would wrap it instead).
function fit(doc, value, width) {
    let t = clean(value);
    if (doc.widthOfString(t) <= width) return t;
    while (t.length > 1 && doc.widthOfString(t + "\u2026") > width) t = t.slice(0, -1);
    return t.trimEnd() + "\u2026";
}

function fmt(value, digits) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(digits) : "-";
}

function clean(value) {
    // pdfkit cannot draw control characters
    return String(value ?? "").replace(/[\u0000-\u001f]/g, " ").trim();
}

/**
 * Draw one marksheet on a NEW page.
 * data:  { student, school, subjects, summary }  (same as buildResultData)
 * extra: { qrBuffer, verifyUrl }
 */
function drawMarksheet(doc, data, extra = {}) {
    const { student, school, subjects, summary } = data;
    const W = 595.28;
    const H = 841.89;
    const M = 40;
    const innerW = W - M * 2;

    doc.addPage({ size: "A4", margin: 0 });

    // page border (double line)
    doc.lineWidth(2).strokeColor(COLORS.brand).rect(24, 24, W - 48, H - 48).stroke();
    doc.lineWidth(0.6).strokeColor(COLORS.brand).rect(29, 29, W - 58, H - 58).stroke();

    let y = 46;

    // header: logo + school name
    if (fs.existsSync(LOGO)) {
        try {
            doc.image(LOGO, W / 2 - 30, y, { fit: [60, 60], align: "center" });
        } catch (e) { /* logo is optional */ }
    }
    y += 66;

    doc.font("bold").fontSize(20).fillColor(COLORS.brand)
        .text(clean(school.name), M, y, { width: innerW, align: "center", lineBreak: false });
    y += 26;
    doc.font("body").fontSize(11).fillColor(COLORS.muted)
        .text(clean(school.address), M, y, { width: innerW, align: "center", lineBreak: false });
    y += 15;
    if (school.eiin) {
        doc.text("EIIN: " + clean(school.eiin), M, y, { width: innerW, align: "center", lineBreak: false });
        y += 15;
    }
    y += 6;

    // title
    doc.moveTo(M, y).lineTo(W - M, y).lineWidth(0.8).strokeColor(COLORS.line).stroke();
    y += 8;
    doc.font("bold").fontSize(15).fillColor(COLORS.ink)
        .text("ACADEMIC MARKSHEET", M, y, { width: innerW, align: "center", lineBreak: false });
    y += 21;
    doc.font("body").fontSize(11.5).fillColor(COLORS.ink)
        .text(`${clean(student.exam_name)} - ${clean(student.exam_year)}`, M, y,
            { width: innerW, align: "center", lineBreak: false });
    y += 20;

    if (extra.draft) {
        doc.font("bold").fontSize(10).fillColor("#b91c1c")
            .text("DRAFT - NOT PUBLISHED YET", M, y, { width: innerW, align: "center", lineBreak: false });
        y += 16;
    }
    y += 4;

    // student info (2 columns)
    const info = [
        ["Student Name", student.name],
        ["Roll", student.roll],
        ["Registration", student.registration || "-"],
        ["Class", student.class_name],
        ["Group", student.group_name || "-"],
        ["Year", student.exam_year]
    ];
    const colW = innerW / 2;
    doc.fontSize(11);
    for (let i = 0; i < info.length; i += 2) {
        for (let j = 0; j < 2; j++) {
            const item = info[i + j];
            if (!item) continue;
            const x = M + j * colW;
            doc.font("bold").fillColor(COLORS.muted).text(item[0] + ":", x, y, { width: 84, lineBreak: false });
            doc.font("body").fillColor(COLORS.ink)
                .text(fit(doc, item[1], colW - 96), x + 88, y, { width: colW - 90, lineBreak: false });
        }
        y += 19;
    }
    y += 8;

    // table
    const cols = [
        { label: "Subject", w: 200, align: "left" },
        { label: "Code", w: 60, align: "center" },
        { label: "Full Marks", w: 70, align: "center" },
        { label: "Marks", w: 60, align: "center" },
        { label: "Grade", w: 55, align: "center" },
        { label: "Grade Point", w: 70, align: "center" }
    ];
    const tableW = cols.reduce((a, c) => a + c.w, 0);
    const scale = innerW / tableW;
    cols.forEach((c) => { c.w *= scale; });

    const rowH = 21;
    const drawRow = (cells, opts = {}) => {
        let x = M;
        if (opts.fill) doc.rect(M, y, innerW, rowH).fill(opts.fill);
        doc.fillColor(COLORS.ink).font(opts.bold ? "bold" : "body").fontSize(10.5);
        cols.forEach((c, i) => {
            doc.text(fit(doc, cells[i], c.w - 12), x + 6, y + 5, {
                width: c.w - 10, align: c.align, lineBreak: false
            });
            x += c.w;
        });
        doc.lineWidth(0.5).strokeColor(COLORS.line).rect(M, y, innerW, rowH).stroke();
        let vx = M;
        cols.slice(0, -1).forEach((c) => {
            vx += c.w;
            doc.moveTo(vx, y).lineTo(vx, y + rowH).stroke();
        });
        y += rowH;
    };

    drawRow(cols.map((c) => c.label), { bold: true, fill: COLORS.head });
    subjects.forEach((s) => {
        if (y > H - 250) {
            // very long subject lists: continue on the next page
            doc.addPage({ size: "A4", margin: 0 });
            doc.lineWidth(2).strokeColor(COLORS.brand).rect(24, 24, W - 48, H - 48).stroke();
            y = 46;
            drawRow(cols.map((c) => c.label), { bold: true, fill: COLORS.head });
        }
        drawRow([
            s.subject_name,
            s.subject_code,
            s.full_marks,
            s.marks,
            s.grade,
            fmt(s.grade_point, 2)
        ]);
    });
    y += 16;

    // summary boxes
    const boxes = [
        ["Total Marks", `${summary.total_marks} / ${summary.total_full_marks}`],
        ["GPA", fmt(summary.gpa, 2)],
        ["Result", summary.result],
        ["Position", summary.position === null || summary.position === undefined ? "-" : summary.position]
    ];
    const gap = 10;
    const boxW = (innerW - gap * (boxes.length - 1)) / boxes.length;
    boxes.forEach((b, i) => {
        const x = M + i * (boxW + gap);
        doc.lineWidth(0.8).strokeColor(COLORS.line).roundedRect(x, y, boxW, 46, 4).stroke();
        doc.font("body").fontSize(9.5).fillColor(COLORS.muted)
            .text(b[0], x, y + 7, { width: boxW, align: "center", lineBreak: false });
        const failed = b[0] === "Result" && String(b[1]).toLowerCase() === "fail";
        doc.font("bold").fontSize(15).fillColor(failed ? "#b91c1c" : COLORS.ink)
            .text(fit(doc, b[1], boxW - 10), x, y + 22, { width: boxW, align: "center", lineBreak: false });
    });
    y += 46;

    // footer: QR (left) + signature (right), pinned near the bottom
    const footY = H - 190;
    if (extra.qrBuffer) {
        doc.image(extra.qrBuffer, M + 4, footY, { fit: [96, 96] });
        doc.font("body").fontSize(8.5).fillColor(COLORS.muted)
            .text("Scan to verify this result", M, footY + 100, { width: 108, align: "center", lineBreak: false });
    }

    const sigX = W - M - 170;
    if (fs.existsSync(SIGNATURE)) {
        try {
            doc.image(SIGNATURE, sigX + 20, footY, { fit: [130, 60] });
        } catch (e) { /* signature is optional */ }
    }
    doc.lineWidth(0.8).strokeColor(COLORS.ink).moveTo(sigX, footY + 68).lineTo(sigX + 170, footY + 68).stroke();
    doc.font("bold").fontSize(11).fillColor(COLORS.ink)
        .text("Head Teacher", sigX, footY + 72, { width: 170, align: "center", lineBreak: false });

    doc.font("body").fontSize(8).fillColor(COLORS.muted)
        .text(
            "This is a computer generated marksheet. Its authenticity can be checked by scanning the QR code.",
            M, H - 52, { width: innerW, align: "center", lineBreak: false }
        );
}

module.exports = { createDocument, drawMarksheet };
