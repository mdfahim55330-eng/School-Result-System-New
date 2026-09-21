"use strict";

const db = require("../db");
const config = require("../config");
const cache = require("../cache");
const { httpError } = require("../utils");
const { calculateFinalGPA } = require("./grading");
const { getExamReport } = require("./reports");

// ---------------------------------------------------------------------------
// Public lookup (roll + class + exam + year [+ group])
// ---------------------------------------------------------------------------

/**
 * Returns:
 *   { kind: "found", student }
 *   { kind: "ambiguous" }   -> the same roll is saved twice (old data)
 *   { kind: "none" }
 * Only PUBLISHED results are ever visible here.
 */
async function lookupPublished({ roll, class_name, exam_name, exam_year }) {
    const rows = await db.all(
        `SELECT id, name, roll, registration, class_name, group_name, exam_name, exam_year,
                institute_name, eiin, status
         FROM students
         WHERE roll = ? AND class_name = ? AND exam_name = ? AND exam_year = ?
           AND status = 'published'
         ORDER BY id ASC`,
        [roll, class_name, exam_name, Number(exam_year)]
    );

    if (rows.length === 0) return { kind: "none" };
    // Old data may (rarely) hold the same roll twice: never guess which student it is.
    if (rows.length > 1) return { kind: "ambiguous" };
    return { kind: "found", student: rows[0] };
}

/** Full marksheet data for one student row (same JSON shape the pages already use). */
async function buildResultData(student) {
    const subjects = await db.all(
        `SELECT results.id, results.marks, results.grade, results.grade_point, results.is_fourth_subject,
                subjects.subject_name, subjects.subject_code, subjects.full_marks, subjects.subject_type
         FROM results
         INNER JOIN subjects ON results.subject_id = subjects.id
         WHERE results.student_id = ?
         ORDER BY subjects.id ASC`,
        [student.id]
    );

    let totalMarks = 0;
    let totalFullMarks = 0;
    subjects.forEach((s) => {
        totalMarks += Number(s.marks || 0);
        totalFullMarks += Number(s.full_marks || 0);
    });

    const final = calculateFinalGPA(subjects);

    // position inside the whole class (cached, so many people can search at once)
    const report = await cache.remember(
        `report:${student.class_name}|${student.exam_name}|${student.exam_year}`,
        () => getExamReport({
            class_name: student.class_name,
            exam_name: student.exam_name,
            exam_year: student.exam_year
        })
    );
    const me = report.students.find((s) => s.id === student.id);
    const position = me && me.position !== null ? me.position : "-";

    return {
        student: {
            id: student.id,
            name: student.name,
            roll: student.roll,
            registration: student.registration,
            class_name: student.class_name,
            group_name: student.group_name,
            exam_name: student.exam_name,
            exam_year: student.exam_year,
            institute_name: student.institute_name || config.school.name,
            eiin: student.eiin || config.school.eiin || null
        },
        school: config.school,
        subjects,
        summary: {
            total_marks: totalMarks,
            total_full_marks: totalFullMarks,
            gpa: final.gpa,
            grade: final.grade,
            result: final.status,
            position
        }
    };
}

// ---------------------------------------------------------------------------
// Writing (always inside a transaction: pass the `client` from db.tx)
// ---------------------------------------------------------------------------

function mapWriteError(error) {
    if (error && error.code === "23505") {
        return httpError(409, "A student with this roll already exists for this class, exam, year and group.");
    }
    return error;
}

async function insertStudentWithResults(client, { exam, student, processed, final, status }) {
    let studentId;
    try {
        const inserted = await client.query(
            `INSERT INTO students
                (name, roll, registration, class_name, group_name, exam_name, exam_year,
                 final_gpa, final_grade, result_status, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id`,
            [
                student.name,
                student.roll,
                student.registration || "",
                exam.class_name,
                student.group_name || "",
                exam.exam_name,
                exam.exam_year,
                final.gpa,
                final.grade,
                final.status,
                status
            ]
        );
        studentId = inserted.rows[0].id;
    } catch (error) {
        throw mapWriteError(error);
    }
    await insertResultRows(client, studentId, processed);
    return studentId;
}

async function insertResultRows(client, studentId, processed) {
    for (const p of processed) {
        await client.query(
            `INSERT INTO results (student_id, subject_id, marks, grade, grade_point, is_fourth_subject)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [studentId, p.subject_id, p.marks, p.grade, p.grade_point, p.is_fourth_subject]
        );
    }
}

async function replaceResults(client, studentId, processed) {
    await client.query(`DELETE FROM results WHERE student_id = $1`, [studentId]);
    await insertResultRows(client, studentId, processed);
}

module.exports = {
    lookupPublished,
    buildResultData,
    insertStudentWithResults,
    insertResultRows,
    replaceResults,
    mapWriteError
};
