"use strict";

const express = require("express");
const multer = require("multer");
const db = require("../db");
const config = require("../config");
const audit = require("../services/audit");
const { requireAdminRole } = require("../middleware/auth");
const { httpError } = require("../utils");
const { gradeSubjects } = require("../services/grading");
const excel = require("../services/excel");
const { insertStudentWithResults, replaceResults } = require("../services/results");

const router = express.Router();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.upload.maxBytes, files: 1 },
    fileFilter: (req, file, cb) => {
        if (!/\.xlsx$/i.test(file.originalname || "")) {
            return cb(httpError(400, "Please upload an Excel (.xlsx) file."));
        }
        cb(null, true);
    }
});

async function loadExamContext(examId) {
    const exam = await db.one(`SELECT * FROM exams WHERE id = ?`, [examId]);
    if (!exam) throw httpError(404, "Exam not found.");

    const subjects = await db.all(`SELECT * FROM subjects WHERE class_name = ? ORDER BY id ASC`, [exam.class_name]);
    if (subjects.length === 0) throw httpError(400, `No subjects found for class ${exam.class_name}.`);

    const students = await db.all(
        `SELECT id, roll, status FROM students WHERE class_name = ? AND exam_name = ? AND exam_year = ?`,
        [exam.class_name, exam.exam_name, exam.exam_year]
    );
    const existing = new Map(students.map((s) => [String(s.roll), { id: s.id, status: s.status }]));
    return { exam, subjects, existing };
}

function duplicateModeOf(value) {
    return String(value || "").toLowerCase() === "update" ? "update" : "skip";
}

// --------------------------------------------------------------------------
// PREVIEW: reads the file. With exam_id it also checks every row (same checks as the import).
// --------------------------------------------------------------------------
router.post("/bulk-preview", upload.single("excelFile"), async (req, res) => {
    if (!req.file) throw httpError(400, "Please select an Excel file.");

    const sheet = await excel.readSheet(req.file.buffer, { maxRows: config.upload.maxRows });
    const rawRows = sheet.rows.map(({ __row, ...rest }) => rest);

    const response = { success: true, total_rows: rawRows.length, columns: sheet.columns, rows: rawRows };

    const examId = Number(req.body && req.body.exam_id);
    if (examId) {
        const { exam, subjects, existing } = await loadExamContext(examId);
        const analysis = excel.analyzeRows({
            columns: sheet.columns,
            rows: sheet.rows,
            subjects,
            existing,
            duplicateMode: duplicateModeOf(req.body.duplicate_mode),
            lockPublished: req.user.role !== "admin"
        });
        response.exam = { id: exam.id, exam_name: exam.exam_name, exam_year: exam.exam_year, class_name: exam.class_name };
        response.counts = analysis.counts;
        response.analysis = analysis.rows.map((r) => ({
            row: r.row, name: r.name, roll: r.roll, registration: r.registration,
            valid: r.valid, state: r.state, errors: r.errors, gpa: r.gpa, grade: r.grade, result: r.result
        }));
    }
    res.json(response);
});

// --------------------------------------------------------------------------
// IMPORT
// --------------------------------------------------------------------------
router.post("/bulk-import", upload.single("excelFile"), async (req, res) => {
    if (!req.file) throw httpError(400, "Please select an Excel file.");
    const examId = Number(req.body && req.body.exam_id);
    if (!examId) throw httpError(400, "Please select an exam.");

    const mode = duplicateModeOf(req.body.duplicate_mode);
    const isAdmin = req.user.role === "admin";

    // Only an admin can publish while importing. Default (no choice sent) = publish, like the old system.
    const publishRaw = String(req.body.publish === undefined ? "true" : req.body.publish).toLowerCase();
    const publish = isAdmin && publishRaw !== "false";

    const sheet = await excel.readSheet(req.file.buffer, { maxRows: config.upload.maxRows });
    const { exam, subjects, existing } = await loadExamContext(examId);
    const analysis = excel.analyzeRows({
        columns: sheet.columns,
        rows: sheet.rows,
        subjects,
        existing,
        duplicateMode: mode,
        lockPublished: !isAdmin
    });

    const subjectsById = new Map(subjects.map((s) => [Number(s.id), s]));
    const good = analysis.rows.filter((r) => r.valid);
    let created = 0;
    let updated = 0;

    await db.tx(async (client) => {
        for (const item of good) {
            const { processed, final } = gradeSubjects(subjectsById, item.marks);
            const student = { name: item.name, roll: item.roll, registration: item.registration, group_name: item.group_name };

            if (item.state === "update") {
                await client.query(
                    `UPDATE students
                     SET name = $1, registration = $2, group_name = $3,
                         final_gpa = $4, final_grade = $5, result_status = $6,
                         status = CASE WHEN $7 THEN 'published' ELSE status END,
                         updated_at = now()
                     WHERE id = $8`,
                    [student.name, student.registration, student.group_name,
                     final.gpa, final.grade, final.status, publish, item.existing_id]
                );
                await replaceResults(client, item.existing_id, processed);
                updated++;
            } else {
                await insertStudentWithResults(client, {
                    exam, student, processed, final, status: publish ? "published" : "draft"
                });
                created++;
            }
        }
    });

    const errors = analysis.rows
        .filter((r) => !r.valid)
        .map((r) => ({ row: r.row, name: r.name, roll: r.roll, error: r.errors.join(" ") }));

    await audit.log(req, "bulk_import", "exam", exam.id,
        `Excel import for Class ${exam.class_name} - ${exam.exam_name} ${exam.exam_year}: ` +
        `${created} new, ${updated} updated, ${errors.length} not imported` + (publish ? " (published)" : " (draft)"),
        { file: req.file.originalname, mode, published: publish, created, updated, not_imported: errors.length });

    res.json({
        success: true,
        message: errors.length === 0
            ? "Bulk import completed successfully."
            : `Import finished: ${good.length} saved, ${errors.length} row(s) NOT imported.`,
        total: analysis.rows.length,
        processed: good.length,
        created,
        updated,
        failed: errors.length,
        errors,
        published: publish
    });
});

// --------------------------------------------------------------------------
// Excel template
// --------------------------------------------------------------------------
router.get("/download-excel-demo", async (req, res) => {
    const examId = Number(req.query.exam_id);
    let subjects = null;
    let exam = null;
    let filename = "result-template.xlsx";

    if (examId) {
        const ctx = await loadExamContext(examId);
        subjects = ctx.subjects;
        exam = ctx.exam;
        filename = `result-template-class-${exam.class_name}-${exam.exam_year}.xlsx`.replace(/[^A-Za-z0-9._-]+/g, "-");
    }

    const buffer = await excel.buildTemplate({ subjects, exam });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
});

module.exports = router;
