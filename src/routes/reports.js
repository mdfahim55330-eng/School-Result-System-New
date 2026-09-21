"use strict";

const express = require("express");
const ExcelJS = require("exceljs");
const db = require("../db");
const cache = require("../cache");
const audit = require("../services/audit");
const verify = require("../services/verify");
const pdf = require("../services/pdf");
const config = require("../config");
const { requireAdminRole } = require("../middleware/auth");
const { pdfLimiter } = require("../middleware/security");
const { parse, z, text, int } = require("../validation");
const { httpError } = require("../utils");
const { getExamReport, buildStatistics } = require("../services/reports");
const { buildResultData } = require("../services/results");

const router = express.Router();

const scopeSchema = z.object({
    class_name: text(50, "Class"),
    exam_name: text(150, "Exam name"),
    exam_year: int("Exam year"),
    group_name: z.string().trim().max(50).optional()
});

const report = (query) => {
    const scope = parse(scopeSchema, query);
    return cache.remember(
        `report:${scope.class_name}|${scope.exam_name}|${scope.exam_year}|${scope.group_name || ""}`,
        () => getExamReport(scope)
    );
};

// Which class / exam / year combinations exist (fills the drop-downs of the report pages)
router.get("/reports/options", async (req, res) => {
    const options = await db.all(
        `SELECT class_name, exam_name, exam_year,
                COUNT(*)::int AS students,
                (COUNT(*) FILTER (WHERE status = 'published'))::int AS published
         FROM students
         GROUP BY class_name, exam_name, exam_year
         ORDER BY exam_year DESC, class_name ASC, exam_name ASC`
    );
    res.json({ success: true, options });
});

router.get("/reports/merit", async (req, res) => {
    const data = await report(req.query);
    const students = data.students.map((s) => ({
        position: s.position, id: s.id, roll: s.roll, name: s.name, group_name: s.group_name,
        status: s.status, final_gpa: s.final_gpa, final_grade: s.final_grade, result_status: s.result_status,
        total_marks: s.total_marks, total_full_marks: s.total_full_marks, merit_marks: s.merit_marks
    }));
    res.json({ success: true, meta: data.meta, students });
});

router.get("/reports/tabulation", async (req, res) => {
    const data = await report(req.query);
    res.json({ success: true, ...data, school: config.school });
});

router.get("/reports/statistics", async (req, res) => {
    const data = await report(req.query);
    res.json({ success: true, ...buildStatistics(data) });
});

// ---------------------------------------------------------------------------
// Marksheets of a whole class as ONE pdf (one page per student)
// ---------------------------------------------------------------------------
router.get("/reports/marksheets.pdf", pdfLimiter, async (req, res) => {
    const data = await report(req.query);
    const includeDrafts = String(req.query.status || "published") === "all";
    const list = data.students.filter((s) => includeDrafts || s.status === "published");
    if (list.length === 0) throw httpError(404, "No published results found for this selection.");
    if (list.length > 600) throw httpError(400, "Too many students for one PDF. Please choose a smaller group.");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition",
        `inline; filename="marksheets-class-${String(data.meta.class_name).replace(/[^A-Za-z0-9]+/g, "-")}-${data.meta.exam_year}.pdf"`);

    const doc = pdf.createDocument("Marksheets");
    doc.on("error", (e) => console.error("PDF error:", e.message));
    doc.pipe(res);

    for (const s of list) {
        const student = await db.one(
            `SELECT id, name, roll, registration, class_name, group_name, exam_name, exam_year, institute_name, eiin, status
             FROM students WHERE id = ?`, [s.id]);
        if (!student) continue;
        const result = await buildResultData(student);
        const qr = await verify.qrBuffer(verify.verifyUrl(req, student.id));
        pdf.drawMarksheet(doc, result, { qrBuffer: qr, draft: student.status !== "published" });
    }
    doc.end();
});

// ---------------------------------------------------------------------------
// Export (admin only): CSV and Excel
// ---------------------------------------------------------------------------
function csvCell(value) {
    let v = String(value ?? "");
    // stop spreadsheet formulas ("=1+1") coming from names
    if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function exportTable(data) {
    const head = ["Position", "Roll", "Name", "Registration", "Group",
        ...data.subjects.map((s) => `${s.subject_name} (${s.subject_code})`),
        "Total Marks", "GPA", "Grade", "Result", "Status"];
    const rows = data.students.map((s) => [
        s.position ?? "", s.roll, s.name, s.registration, s.group_name,
        ...data.subjects.map((sub) => (s.marks[sub.id] === undefined ? "" : s.marks[sub.id])),
        s.total_marks, s.final_gpa.toFixed(2), s.final_grade, s.result_status, s.status
    ]);
    return { head, rows };
}

function safeName(meta, ext) {
    return `results-class-${meta.class_name}-${meta.exam_name}-${meta.exam_year}.${ext}`.replace(/[^A-Za-z0-9._-]+/g, "-");
}

router.get("/export/results.csv", requireAdminRole, async (req, res) => {
    const data = await report(req.query);
    const { head, rows } = exportTable(data);
    const csv = "\uFEFF" + [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
    await audit.log(req, "export", "exam", null,
        `Exported CSV: Class ${data.meta.class_name} - ${data.meta.exam_name} ${data.meta.exam_year}`);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName(data.meta, "csv")}"`);
    res.send(csv);
});

router.get("/export/results.xlsx", requireAdminRole, async (req, res) => {
    const data = await report(req.query);
    const { head, rows } = exportTable(data);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Results");
    ws.addRow(head);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDBEAFE" } };
    rows.forEach((r) => {
        // names starting with = + - @ are stored as plain text by exceljs (never as formulas)
        ws.addRow(r.map((v) => (typeof v === "string" ? v : v)));
    });
    ws.views = [{ state: "frozen", ySplit: 1, xSplit: 3 }];
    ws.columns.forEach((c, i) => { c.width = i === 2 ? 28 : Math.max(10, String(head[i]).length + 2); });

    await audit.log(req, "export", "exam", null,
        `Exported Excel: Class ${data.meta.class_name} - ${data.meta.exam_name} ${data.meta.exam_year}`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName(data.meta, "xlsx")}"`);
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
});

// ---------------------------------------------------------------------------
// Backup (admin only): everything except passwords
// ---------------------------------------------------------------------------
router.get("/backup", requireAdminRole, async (req, res) => {
    const [exams, subjects, students, results] = await Promise.all([
        db.all(`SELECT * FROM exams ORDER BY id`),
        db.all(`SELECT * FROM subjects ORDER BY id`),
        db.all(`SELECT * FROM students ORDER BY id`),
        db.all(`SELECT * FROM results ORDER BY id`)
    ]);

    const backup = {
        app: "school-result-system",
        version: 2,
        created_at: new Date().toISOString(),
        counts: { exams: exams.length, subjects: subjects.length, students: students.length, results: results.length },
        exams, subjects, students, results
    };

    await audit.log(req, "backup", "system", null, `Downloaded backup (${students.length} students)`);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="result-backup-${stamp}.json"`);
    res.send(JSON.stringify(backup));
});

module.exports = router;
