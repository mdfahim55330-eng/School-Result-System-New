"use strict";

const express = require("express");
const db = require("../db");
const audit = require("../services/audit");
const { requireAdminRole } = require("../middleware/auth");
const { parse, z, text, int } = require("../validation");
const { httpError } = require("../utils");
const { calculateFinalGPA } = require("../services/grading");

const router = express.Router();

// ===========================================================================
// CLASSES
// ===========================================================================

router.get("/classes", async (req, res) => {
    const classes = await db.all(`SELECT id, class_name, created_at FROM classes ORDER BY class_name ASC`);
    res.json({ success: true, classes });
});

const classSchema = z.object({
    class_name: text(50, "Class")
});

router.post("/classes", requireAdminRole, async (req, res) => {
    const data = parse(classSchema, req.body || {});
    const existing = await db.one(`SELECT id FROM classes WHERE LOWER(TRIM(class_name)) = LOWER(TRIM(?))`, [data.class_name]);
    if (existing) throw httpError(400, "This class already exists.");

    let inserted;
    try {
        inserted = await db.one(`INSERT INTO classes (class_name) VALUES (?) RETURNING id`, [data.class_name]);
    } catch (error) {
        if (error.code === "23505") throw httpError(400, "This class already exists.");
        throw error;
    }

    await audit.log(req, "class_created", "class", inserted.id, `Added class ${data.class_name}`, data);
    res.json({ success: true, message: "Class added successfully.", id: inserted.id });
});

router.delete("/classes/:id", requireAdminRole, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(400, "Invalid class id.");

    const item = await db.one(`SELECT * FROM classes WHERE id = ?`, [id]);
    if (!item) throw httpError(404, "Class not found.");

    const usage = await db.one(`SELECT
        (SELECT COUNT(*) FROM students WHERE class_name = ?) +
        (SELECT COUNT(*) FROM exams WHERE class_name = ?) +
        (SELECT COUNT(*) FROM subjects WHERE class_name = ?) AS total`,
        [item.class_name, item.class_name, item.class_name]
    );
    if (Number(usage.total) > 0) {
        throw httpError(409, `Class "${item.class_name}" is already used by existing students, exams or subjects. Delete those records first.`);
    }

    await db.query(`DELETE FROM classes WHERE id = ?`, [id]);
    await audit.log(req, "class_deleted", "class", id, `Deleted class ${item.class_name}`, item);
    res.json({ success: true, message: "Class deleted successfully." });
});

// ===========================================================================
// SUBJECTS
// ===========================================================================

router.get("/subjects", async (req, res) => {
    const subjects = await db.all(`SELECT * FROM subjects ORDER BY class_name ASC, subject_code ASC`);
    res.json({ success: true, subjects });
});

const subjectSchema = z.object({
    class_name: text(50, "Class"),
    subject_name: text(150, "Subject name"),
    subject_code: text(30, "Subject code"),
    full_marks: int("Full marks").min(1, "Full marks must be at least 1.").max(1000, "Full marks is too large."),
    subject_type: z.enum(["main", "fourth"]).optional().default("main")
});

router.post("/subjects", requireAdminRole, async (req, res) => {
    const body = req.body || {};
    if (!body.class_name || !body.subject_name || !body.subject_code || !body.full_marks) {
        throw httpError(400, "Class, subject name, subject code and full marks are required.");
    }
    const data = parse(subjectSchema, { ...body, subject_type: body.subject_type || "main" });

    const existing = await db.one(
        `SELECT id FROM subjects WHERE class_name = ? AND subject_code = ?`,
        [data.class_name, data.subject_code]
    );
    if (existing) throw httpError(400, "This subject already exists for this class.");

    let inserted;
    try {
        inserted = await db.one(
            `INSERT INTO subjects (class_name, subject_name, subject_code, full_marks, subject_type)
             VALUES (?, ?, ?, ?, ?) RETURNING id`,
            [data.class_name, data.subject_name, data.subject_code, data.full_marks, data.subject_type]
        );
    } catch (error) {
        if (error.code === "23505") throw httpError(400, "This subject already exists for this class.");
        throw error;
    }

    await audit.log(req, "subject_created", "subject", inserted.id,
        `Added subject ${data.subject_name} (${data.subject_code}) to Class ${data.class_name}`, data);
    res.json({ success: true, message: "Subject added successfully.", id: inserted.id });
});

router.delete("/subjects/:id", requireAdminRole, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(400, "Invalid subject id.");

    const subject = await db.one(`SELECT * FROM subjects WHERE id = ?`, [id]);
    if (!subject) throw httpError(404, "Subject not found.");

    const usage = await db.one(`SELECT COUNT(*) AS n FROM results WHERE subject_id = ?`, [id]);
    const used = Number(usage.n);
    const force = String(req.query.force || "").toLowerCase() === "true";

    if (used > 0 && !force) {
        // Deleting a subject that already has marks would silently wipe those marks.
        return res.status(409).json({
            success: false,
            needs_force: true,
            message:
                `"${subject.subject_name}" already has marks saved for ${used} result(s). ` +
                `If you delete it, those marks are removed permanently and every affected GPA is recalculated.`
        });
    }

    await db.tx(async (client) => {
        const affected = await client.query(`SELECT DISTINCT student_id FROM results WHERE subject_id = $1`, [id]);
        await client.query(`DELETE FROM subjects WHERE id = $1`, [id]); // results are removed by ON DELETE CASCADE

        // re-calculate GPA for everybody who had this subject
        for (const row of affected.rows) {
            const list = await client.query(
                `SELECT grade, grade_point, is_fourth_subject FROM results WHERE student_id = $1`,
                [row.student_id]
            );
            const final = calculateFinalGPA(list.rows);
            await client.query(
                `UPDATE students SET final_gpa = $1, final_grade = $2, result_status = $3, updated_at = now() WHERE id = $4`,
                [final.gpa, final.grade, final.status, row.student_id]
            );
        }
    });

    await audit.log(req, "subject_deleted", "subject", id,
        `Deleted subject ${subject.subject_name} (${subject.subject_code}) from Class ${subject.class_name}` +
        (used > 0 ? ` (removed marks of ${used} result(s))` : ""),
        { subject, results_removed: used });

    res.json({ success: true, message: "Subject deleted successfully." });
});

// ===========================================================================
// EXAMS
// ===========================================================================

router.get("/exams", async (req, res) => {
    const exams = await db.all(`SELECT * FROM exams ORDER BY exam_year DESC, id DESC`);
    res.json({ success: true, exams });
});

const examSchema = z.object({
    exam_name: text(150, "Exam name"),
    exam_year: int("Exam year").min(2000, "Exam year is not valid.").max(2100, "Exam year is not valid."),
    class_name: text(50, "Class")
});

router.post("/exams", requireAdminRole, async (req, res) => {
    const body = req.body || {};
    if (!body.exam_name || !body.exam_year || !body.class_name) {
        throw httpError(400, "All fields are required.");
    }
    const data = parse(examSchema, body);

    const existing = await db.one(
        `SELECT id FROM exams WHERE exam_name = ? AND exam_year = ? AND class_name = ?`,
        [data.exam_name, data.exam_year, data.class_name]
    );
    if (existing) throw httpError(400, "This exam already exists for this class and year.");

    let inserted;
    try {
        inserted = await db.one(
            `INSERT INTO exams (exam_name, exam_year, class_name) VALUES (?, ?, ?) RETURNING id`,
            [data.exam_name, data.exam_year, data.class_name]
        );
    } catch (error) {
        if (error.code === "23505") throw httpError(400, "This exam already exists for this class and year.");
        throw error;
    }

    await audit.log(req, "exam_created", "exam", inserted.id,
        `Added exam ${data.exam_name} ${data.exam_year} (Class ${data.class_name})`, data);
    res.json({ success: true, message: "Exam added successfully.", id: inserted.id });
});

router.delete("/exams/:id", requireAdminRole, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(400, "Invalid exam id.");

    const exam = await db.one(`SELECT * FROM exams WHERE id = ?`, [id]);
    // (the old system answered "success" even when nothing was deleted; keep that friendly behaviour)
    await db.query(`DELETE FROM exams WHERE id = ?`, [id]);

    if (exam) {
        await audit.log(req, "exam_deleted", "exam", id,
            `Deleted exam ${exam.exam_name} ${exam.exam_year} (Class ${exam.class_name})`, exam);
    }
    res.json({ success: true, message: "Exam deleted successfully." });
});

module.exports = router;
