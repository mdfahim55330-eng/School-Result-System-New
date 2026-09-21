"use strict";

const express = require("express");
const db = require("../db");
const audit = require("../services/audit");
const { requireAdminRole } = require("../middleware/auth");
const { parse, z, text, int } = require("../validation");
const { httpError } = require("../utils");
const { gradeSubjects } = require("../services/grading");
const { insertStudentWithResults, replaceResults, mapWriteError } = require("../services/results");

const router = express.Router();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function idParam(req) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw httpError(400, "Invalid result ID.");
    return id;
}

const isMain = (subject) => String(subject.subject_type || "main").toLowerCase() !== "fourth";

/** Every normal (non-4th) subject of the class must have marks. */
function assertAllMainSubjects(classSubjects, processed) {
    const entered = new Set(processed.map((p) => p.subject_id));
    const missing = classSubjects.filter((s) => isMain(s) && !entered.has(Number(s.id)));
    if (missing.length > 0) {
        throw httpError(400, `Marks are missing for: ${missing.map((s) => s.subject_name).join(", ")}.`);
    }
}

async function findDuplicate(client, { class_name, exam_name, exam_year, roll, exceptId }) {
    const found = await client.query(
        `SELECT id, name FROM students
         WHERE class_name = $1 AND exam_name = $2 AND exam_year = $3 AND roll = $4 AND id <> $5
         LIMIT 1`,
        [class_name, exam_name, exam_year, roll, exceptId || 0]
    );
    return found.rows[0] || null;
}

function duplicateMessage(roll, existing) {
    return `Roll ${roll} already exists for this class, exam and year (${existing.name}). ` +
        `Please use a different roll or edit the existing result.`;
}

const studentSchema = z.object({
    name: text(200, "Student name"),
    roll: text(50, "Roll"),
    registration: z.string().trim().max(100).optional().default(""),
    group_name: z.string().trim().max(50).optional().default("")
}).passthrough();

const resultsSchema = z.array(z.object({
    subject_id: z.coerce.number().int(),
    marks: z.union([z.number(), z.string()])
}).passthrough()).min(1, "At least one subject result is required.");

// ---------------------------------------------------------------------------
// LIST
// ---------------------------------------------------------------------------

router.get("/results", async (req, res) => {
    const search = String(req.query.search || "").trim().slice(0, 100);
    const status = String(req.query.status || "").trim();
    const className = String(req.query.class_name || "").trim();
    const examName = String(req.query.exam_name || "").trim();
    const examYear = String(req.query.exam_year || "").trim();

    const conditions = [];
    const params = [];

    if (search) {
        conditions.push(`(name ILIKE ? OR roll ILIKE ? OR registration ILIKE ?)`);
        const like = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
        params.push(like, like, like);
    }
    if (className) { conditions.push(`class_name = ?`); params.push(className); }
    if (examName) { conditions.push(`exam_name = ?`); params.push(examName); }
    if (examYear) {
        const y = Number(examYear);
        if (!Number.isInteger(y)) throw httpError(400, "Invalid exam year.");
        conditions.push(`exam_year = ?`);
        params.push(y);
    }
    if (status) { conditions.push(`status = ?`); params.push(status); }

    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const rows = await db.all(
        `SELECT id, name, roll, registration, class_name, group_name, exam_name, exam_year,
                final_gpa, final_grade, result_status, status, created_at
         FROM students${where}
         ORDER BY id DESC
         LIMIT 20000`,
        params
    );
    res.json({ success: true, results: rows });
});

// ---------------------------------------------------------------------------
// BULK DELETE  (must stay above "/results/:id")
// ---------------------------------------------------------------------------

const scopeSchema = z.object({
    class_name: text(50, "Class"),
    exam_name: text(150, "Exam name"),
    exam_year: int("Exam year")
});

router.delete("/results/bulk", requireAdminRole, async (req, res) => {
    const body = req.body || {};
    if (!body.class_name || !body.exam_name || !body.exam_year) {
        throw httpError(400, "Class, Exam Name and Exam Year are required.");
    }
    const scope = parse(scopeSchema, body);

    const deleted = await db.tx(async (client) => {
        const result = await client.query(
            `DELETE FROM students WHERE class_name = $1 AND exam_name = $2 AND exam_year = $3`,
            [scope.class_name, scope.exam_name, scope.exam_year]
        );
        return result.rowCount;
    });

    if (deleted === 0) {
        throw httpError(404, "No results found for the selected Class, Exam and Year.");
    }

    await audit.log(req, "results_bulk_deleted", "exam", null,
        `Deleted ALL ${deleted} results of Class ${scope.class_name} - ${scope.exam_name} ${scope.exam_year}`, scope);

    res.json({ success: true, message: "All selected results deleted successfully.", deleted_count: deleted });
});

// ---------------------------------------------------------------------------
// PUBLISH / UNPUBLISH IN BULK (one whole class + exam + year)
// ---------------------------------------------------------------------------

const publishBulkSchema = scopeSchema.extend({
    action: z.enum(["publish", "unpublish"], { errorMap: () => ({ message: "Action must be publish or unpublish." }) })
});

router.post("/results/publish-bulk", requireAdminRole, async (req, res) => {
    const data = parse(publishBulkSchema, req.body || {});
    const scopeParams = [data.class_name, data.exam_name, data.exam_year];

    const summary = await db.tx(async (client) => {
        const totalRow = await client.query(
            `SELECT COUNT(*)::int AS n FROM students WHERE class_name = $1 AND exam_name = $2 AND exam_year = $3`,
            scopeParams
        );
        const total = totalRow.rows[0].n;
        if (total === 0) throw httpError(404, "No results found for the selected Class, Exam and Year.");

        if (data.action === "unpublish") {
            const changed = await client.query(
                `UPDATE students SET status = 'draft', updated_at = now()
                 WHERE class_name = $1 AND exam_name = $2 AND exam_year = $3 AND status = 'published'`,
                scopeParams
            );
            return { total, changed: changed.rowCount, skipped_incomplete: 0 };
        }

        // PUBLISH: only results that have marks for every normal subject
        const required = await client.query(
            `SELECT COUNT(*)::int AS n FROM subjects
             WHERE class_name = $1 AND COALESCE(subject_type, 'main') <> 'fourth'`,
            [data.class_name]
        );
        const requiredMain = required.rows[0].n;

        const changed = await client.query(
            `UPDATE students s SET status = 'published', updated_at = now()
             WHERE s.class_name = $1 AND s.exam_name = $2 AND s.exam_year = $3
               AND COALESCE(s.status, 'draft') <> 'published'
               AND (
                    SELECT COUNT(*) FROM results r
                    INNER JOIN subjects sub ON sub.id = r.subject_id
                    WHERE r.student_id = s.id AND COALESCE(sub.subject_type, 'main') <> 'fourth'
               ) >= $4`,
            [...scopeParams, requiredMain]
        );

        const stillDraft = await client.query(
            `SELECT COUNT(*)::int AS n FROM students
             WHERE class_name = $1 AND exam_name = $2 AND exam_year = $3 AND COALESCE(status, 'draft') <> 'published'`,
            scopeParams
        );
        return { total, changed: changed.rowCount, skipped_incomplete: stillDraft.rows[0].n };
    });

    await audit.log(req, data.action === "publish" ? "results_bulk_published" : "results_bulk_unpublished", "exam", null,
        `${data.action === "publish" ? "Published" : "Unpublished"} ${summary.changed} result(s) of ` +
        `Class ${data.class_name} - ${data.exam_name} ${data.exam_year}`,
        { ...data, ...summary });

    let message;
    if (data.action === "publish") {
        message = `${summary.changed} result(s) published.`;
        if (summary.skipped_incomplete > 0) {
            message += ` ${summary.skipped_incomplete} result(s) were NOT published because marks are missing for some subjects.`;
        }
    } else {
        message = `${summary.changed} result(s) moved back to draft.`;
    }
    res.json({ success: true, message, ...summary });
});

// ---------------------------------------------------------------------------
// SINGLE RESULT: view
// ---------------------------------------------------------------------------

router.get("/results/:id", async (req, res) => {
    const studentId = idParam(req);

    const student = await db.one(
        `SELECT id, name, roll, registration, class_name, group_name, exam_name, exam_year,
                institute_name, eiin, status, final_gpa, final_grade, result_status
         FROM students WHERE id = ?`,
        [studentId]
    );
    if (!student) throw httpError(404, "Result not found.");

    const results = await db.all(
        `SELECT results.id, results.subject_id, results.marks, results.grade, results.grade_point,
                results.is_fourth_subject, subjects.subject_name, subjects.subject_code,
                subjects.full_marks, subjects.subject_type
         FROM results
         INNER JOIN subjects ON subjects.id = results.subject_id
         WHERE results.student_id = ?
         ORDER BY subjects.id`,
        [studentId]
    );

    res.json({ success: true, student, results });
});

// ---------------------------------------------------------------------------
// SINGLE RESULT: create
// ---------------------------------------------------------------------------

const createSchema = z.object({
    exam_id: int("Exam"),
    student: studentSchema,
    results: resultsSchema
});

router.post("/results/individual", async (req, res) => {
    const body = req.body || {};
    if (!body.exam_id || !body.student || !body.student.name || !body.student.roll ||
        !Array.isArray(body.results) || body.results.length === 0) {
        throw httpError(400, "Exam, student information and subject results are required.");
    }
    const data = parse(createSchema, body);

    const exam = await db.one(`SELECT * FROM exams WHERE id = ?`, [data.exam_id]);
    if (!exam) throw httpError(404, "Exam not found.");

    const classSubjects = await db.all(`SELECT * FROM subjects WHERE class_name = ? ORDER BY id ASC`, [exam.class_name]);
    if (classSubjects.length === 0) throw httpError(400, `No subjects found for Class ${exam.class_name}.`);

    const subjectsById = new Map(classSubjects.map((s) => [Number(s.id), s]));
    let graded;
    try {
        graded = gradeSubjects(subjectsById, data.results);
    } catch (error) {
        if (error.message === "Invalid subject found.") {
            error.message = `Invalid subject for Class ${exam.class_name}.`;
        }
        throw error;
    }
    assertAllMainSubjects(classSubjects, graded.processed);

    const student = { ...data.student, roll: data.student.roll.trim() };

    const studentId = await db.tx(async (client) => {
        const dup = await findDuplicate(client, {
            class_name: exam.class_name,
            exam_name: exam.exam_name,
            exam_year: exam.exam_year,
            roll: student.roll
        });
        if (dup) throw httpError(409, duplicateMessage(student.roll, dup));

        return insertStudentWithResults(client, {
            exam, student, processed: graded.processed, final: graded.final, status: "draft"
        });
    });

    await audit.log(req, "result_created", "student", studentId,
        `Saved result of ${student.name} (roll ${student.roll}) - Class ${exam.class_name}, ${exam.exam_name} ${exam.exam_year}`,
        { gpa: graded.final.gpa, grade: graded.final.grade, result: graded.final.status });

    res.json({
        success: true,
        message: "Result saved successfully.",
        student_id: studentId,
        gpa: graded.final.gpa,
        grade: graded.final.grade,
        result: graded.final.status
    });
});

// ---------------------------------------------------------------------------
// SINGLE RESULT: edit
// ---------------------------------------------------------------------------

const updateSchema = z.object({
    student: studentSchema,
    results: resultsSchema
});

router.put("/results/:id", async (req, res) => {
    const studentId = idParam(req);
    const body = req.body || {};
    if (!body.student || !body.student.name || !body.student.roll ||
        !Array.isArray(body.results) || body.results.length === 0) {
        throw httpError(400, "Complete student and result data are required.");
    }
    const data = parse(updateSchema, body);

    const current = await db.one(`SELECT * FROM students WHERE id = ?`, [studentId]);
    if (!current) throw httpError(404, "Student result not found.");

    if (req.user.role !== "admin" && current.status === "published") {
        throw httpError(403, "Only an admin can edit a published result. Ask an admin to unpublish it first.");
    }

    // the class / exam of an existing result never changes here
    const classSubjects = await db.all(`SELECT * FROM subjects WHERE class_name = ? ORDER BY id ASC`, [current.class_name]);
    if (classSubjects.length === 0) throw httpError(400, "No subjects found.");
    const subjectsById = new Map(classSubjects.map((s) => [Number(s.id), s]));

    const graded = gradeSubjects(subjectsById, data.results);
    assertAllMainSubjects(classSubjects, graded.processed);

    const oldRows = await db.all(
        `SELECT r.subject_id, r.marks, s.subject_name FROM results r
         INNER JOIN subjects s ON s.id = r.subject_id WHERE r.student_id = ?`,
        [studentId]
    );
    const oldMarks = new Map(oldRows.map((r) => [Number(r.subject_id), { marks: Number(r.marks), name: r.subject_name }]));

    const student = { ...data.student, roll: data.student.roll.trim() };

    await db.tx(async (client) => {
        const dup = await findDuplicate(client, {
            class_name: current.class_name,
            exam_name: current.exam_name,
            exam_year: current.exam_year,
            roll: student.roll,
            exceptId: studentId
        });
        if (dup) throw httpError(409, duplicateMessage(student.roll, dup));

        try {
            await client.query(
                `UPDATE students
                 SET name = $1, roll = $2, registration = $3, group_name = $4,
                     final_gpa = $5, final_grade = $6, result_status = $7, updated_at = now()
                 WHERE id = $8`,
                [student.name, student.roll, student.registration || "", student.group_name || "",
                 graded.final.gpa, graded.final.grade, graded.final.status, studentId]
            );
        } catch (error) {
            throw mapWriteError(error);
        }
        await replaceResults(client, studentId, graded.processed);
    });

    // what exactly changed (for the audit log)
    const changes = [];
    for (const p of graded.processed) {
        const before = oldMarks.get(p.subject_id);
        const name = (subjectsById.get(p.subject_id) || {}).subject_name;
        if (!before) changes.push({ subject: name, from: null, to: p.marks });
        else if (before.marks !== p.marks) changes.push({ subject: name, from: before.marks, to: p.marks });
    }
    const newIds = new Set(graded.processed.map((p) => p.subject_id));
    for (const [id, before] of oldMarks) {
        if (!newIds.has(id)) changes.push({ subject: before.name, from: before.marks, to: null });
    }

    const details = {
        changes,
        gpa_from: Number(current.final_gpa),
        gpa_to: graded.final.gpa,
        name_from: current.name,
        roll_from: current.roll
    };
    let summary = `Edited result of ${student.name} (roll ${student.roll})`;
    if (changes.length > 0) {
        summary += ": " + changes.map((c) => `${c.subject} ${c.from ?? "-"} -> ${c.to ?? "-"}`).join(", ");
    }
    await audit.log(req, "result_updated", "student", studentId, summary, details);

    res.json({
        success: true,
        message: "Result updated successfully.",
        final_gpa: graded.final.gpa,
        final_grade: graded.final.grade,
        result_status: graded.final.status
    });
});

// ---------------------------------------------------------------------------
// SINGLE RESULT: delete / publish / unpublish  (admin only)
// ---------------------------------------------------------------------------

router.delete("/results/:id", requireAdminRole, async (req, res) => {
    const studentId = idParam(req);

    const snapshot = await db.one(`SELECT * FROM students WHERE id = ?`, [studentId]);
    if (!snapshot) throw httpError(404, "Result not found.");
    const marks = await db.all(
        `SELECT s.subject_name, r.marks FROM results r INNER JOIN subjects s ON s.id = r.subject_id WHERE r.student_id = ?`,
        [studentId]
    );

    await db.query(`DELETE FROM students WHERE id = ?`, [studentId]); // results follow (ON DELETE CASCADE)

    await audit.log(req, "result_deleted", "student", studentId,
        `Deleted result of ${snapshot.name} (roll ${snapshot.roll}) - Class ${snapshot.class_name}, ${snapshot.exam_name} ${snapshot.exam_year}`,
        { student: snapshot, marks });

    res.json({ success: true, message: "Result deleted successfully." });
});

router.put("/results/:id/publish", requireAdminRole, async (req, res) => {
    const studentId = idParam(req);

    const student = await db.one(`SELECT id, name, roll, class_name, status FROM students WHERE id = ?`, [studentId]);
    if (!student) throw httpError(404, "Result not found.");

    const classSubjects = await db.all(`SELECT * FROM subjects WHERE class_name = ?`, [student.class_name]);
    const entered = await db.all(`SELECT subject_id FROM results WHERE student_id = ?`, [studentId]);
    const enteredIds = new Set(entered.map((r) => Number(r.subject_id)));
    const missing = classSubjects.filter((s) => isMain(s) && !enteredIds.has(Number(s.id)));
    if (missing.length > 0) {
        throw httpError(400, `Cannot publish: marks are missing for ${missing.map((s) => s.subject_name).join(", ")}.`);
    }

    await db.query(`UPDATE students SET status = 'published', updated_at = now() WHERE id = ?`, [studentId]);
    await audit.log(req, "result_published", "student", studentId, `Published result of ${student.name} (roll ${student.roll})`);
    res.json({ success: true, message: "Result published successfully." });
});

router.put("/results/:id/unpublish", requireAdminRole, async (req, res) => {
    const studentId = idParam(req);

    const student = await db.one(`SELECT id, name, roll FROM students WHERE id = ?`, [studentId]);
    if (!student) throw httpError(404, "Result not found.");

    await db.query(`UPDATE students SET status = 'draft', updated_at = now() WHERE id = ?`, [studentId]);
    await audit.log(req, "result_unpublished", "student", studentId, `Unpublished result of ${student.name} (roll ${student.roll})`);
    res.json({ success: true, message: "Result moved to draft." });
});

// ---------------------------------------------------------------------------
// DASHBOARD NUMBERS
// ---------------------------------------------------------------------------

router.get("/dashboard-stats", async (req, res) => {
    const row = await db.one(
        `SELECT
            (SELECT COUNT(*) FROM students) AS "totalStudents",
            (SELECT COUNT(DISTINCT student_id) FROM results) AS "totalResults",
            (SELECT COUNT(*) FROM students WHERE status = 'published') AS "publishedResults",
            (SELECT COUNT(*) FROM students WHERE status = 'draft') AS "draftResults"`
    );
    res.json({
        success: true,
        totalStudents: Number(row.totalStudents),
        totalResults: Number(row.totalResults),
        publishedResults: Number(row.publishedResults),
        draftResults: Number(row.draftResults)
    });
});

module.exports = router;
