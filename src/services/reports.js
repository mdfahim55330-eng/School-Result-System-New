"use strict";

const db = require("../db");
const config = require("../config");
const { compareRoll, normalizeClassName } = require("../utils");
const { calculateFinalGPA } = require("./grading");

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

function usesFourthSubjectRule(className) {
    return config.classesWithFourthSubjectRule.includes(normalizeClassName(className));
}

/**
 * Give every student a position.
 *  mode "gpa"   : students who PASSED are ordered by GPA, then total marks.
 *  mode "marks" : PASSED students are ordered by total marks.
 * Students with the same total marks always share the same position, even if GPA differs.
 * Positions use dense ranking: 1, 1, 2, 3, 3, 4 ...
 * Each student needs: final_gpa, result_status, merit_marks.
 */
function assignPositions(students, mode = config.meritMode) {
    const ranked = students
        .filter((s) => s.result_status === "Pass")
        .slice()
        .sort((a, b) => {
            // Merit order: GPA first, then total marks.
            if (mode === "gpa") {
                const g = round2(b.final_gpa) - round2(a.final_gpa);
                if (g !== 0) return g;
            }

            const m = round2(b.total_marks) - round2(a.total_marks);
            if (m !== 0) return m;

            return compareRoll(a.roll, b.roll);
        });

    // Position is based ONLY on total marks.
    // Therefore students with equal total marks get the same position,
    // even when their GPA is different.
    const positions = new Map();
    const totalMarkPosition = new Map();
    let nextPosition = 1;

    // Collect unique total marks in descending order.
    const totals = [...new Set(ranked.map((s) => round2(s.total_marks)))]
        .sort((a, b) => b - a);

    totals.forEach((total) => {
        totalMarkPosition.set(total, nextPosition);
        nextPosition += 1;
    });

    ranked.forEach((student) => {
        positions.set(student.id, totalMarkPosition.get(round2(student.total_marks)));
    });

    students.forEach((s) => {
        s.position = positions.has(s.id) ? positions.get(s.id) : null;
    });

    return students;
}

/**
 * Everything about one class + exam + year: subjects, every student's marks, totals, positions.
 * filters: { class_name, exam_name, exam_year, group_name (optional, ranks inside that group only) }
 */
async function getExamReport(filters) {
    const className = String(filters.class_name);
    const examName = String(filters.exam_name);
    const examYear = Number(filters.exam_year);

    const subjects = await db.all(
        `SELECT id, subject_name, subject_code, full_marks, subject_type
         FROM subjects WHERE class_name = ? ORDER BY id ASC`,
        [className]
    );

    const studentRows = await db.all(
        `SELECT id, name, roll, registration, group_name, status, final_gpa, final_grade, result_status
         FROM students
         WHERE class_name = ? AND exam_name = ? AND exam_year = ?`,
        [className, examName, examYear]
    );

    const resultRows = await db.all(
        `SELECT r.student_id, r.subject_id, r.marks, r.grade, r.grade_point, r.is_fourth_subject
         FROM results r
         INNER JOIN students s ON s.id = r.student_id
         WHERE s.class_name = ? AND s.exam_name = ? AND s.exam_year = ?`,
        [className, examName, examYear]
    );

    const fourthRule = usesFourthSubjectRule(className);
    const subjectById = new Map(subjects.map((s) => [Number(s.id), s]));
    const byStudent = new Map();
    for (const r of resultRows) {
        if (!byStudent.has(r.student_id)) byStudent.set(r.student_id, []);
        byStudent.get(r.student_id).push(r);
    }

    let students = studentRows.map((s) => {
        const list = byStudent.get(s.id) || [];
        const marks = {};
        const grades = {};
        let total = 0;
        let totalFull = 0;
        let meritMarks = 0;

        for (const r of list) {
            const m = Number(r.marks || 0);
            const subject = subjectById.get(Number(r.subject_id));
            marks[r.subject_id] = m;
            grades[r.subject_id] = r.grade;
            total += m;
            totalFull += subject ? Number(subject.full_marks || 0) : 0;
            if (fourthRule && Number(r.is_fourth_subject) === 1) {
                meritMarks += m > 40 ? m - 40 : 0;
            } else {
                meritMarks += m;
            }
        }

        // GPA is recalculated from the saved subject marks, so the merit list can never
        // disagree with the marksheet, even if an old stored value was out of date.
        const final = calculateFinalGPA(list);

        return {
            id: s.id,
            name: s.name,
            roll: s.roll,
            registration: s.registration || "",
            group_name: s.group_name || "",
            status: s.status || "draft",
            final_gpa: round2(final.gpa),
            final_grade: final.grade,
            result_status: final.status,
            marks,
            grades,
            subjects_entered: list.length,
            total_marks: round2(total),
            total_full_marks: totalFull,
            merit_marks: round2(meritMarks),
            position: null
        };
    });

    if (filters.group_name !== undefined && filters.group_name !== null && filters.group_name !== "") {
        const wanted = filters.group_name === "__none__" ? "" : String(filters.group_name);
        students = students.filter((s) => s.group_name === wanted);
    }

    assignPositions(students);

    // Order: ranked students first (by position), then everybody else by roll.
    students.sort((a, b) => {
        const pa = a.position === null ? Infinity : a.position;
        const pb = b.position === null ? Infinity : b.position;
        if (pa !== pb) return pa - pb;
        return compareRoll(a.roll, b.roll);
    });

    return {
        meta: {
            class_name: className,
            exam_name: examName,
            exam_year: examYear,
            group_name: filters.group_name || "",
            merit_mode: config.meritMode,
            total_students: students.length
        },
        subjects,
        students
    };
}

/** Numbers for the statistics page, built from getExamReport() output. */
function buildStatistics(report) {
    const { subjects, students } = report;
    const total = students.length;
    const passed = students.filter((s) => s.result_status === "Pass");
    const failed = total - passed.length;
    const published = students.filter((s) => s.status === "published").length;

    const gradeOrder = ["A+", "A", "A-", "B", "C", "D", "F"];
    const grades = Object.fromEntries(gradeOrder.map((g) => [g, 0]));
    for (const s of students) {
        const g = s.result_status === "Pass" ? s.final_grade : "F";
        if (grades[g] !== undefined) grades[g] += 1;
    }

    const gpas = passed.map((s) => s.final_gpa);
    const avgGpa = gpas.length ? round2(gpas.reduce((a, b) => a + b, 0) / gpas.length) : 0;

    const topPosition = students.find((s) => s.position === 1);
    const toppers = topPosition ? students.filter((s) => s.position === 1) : [];

    const subjectStats = subjects.map((subject) => {
        const entries = students
            .filter((s) => s.marks[subject.id] !== undefined)
            .map((s) => ({ marks: s.marks[subject.id], grade: s.grades[subject.id] }));
        const appeared = entries.length;
        const failedHere = entries.filter((e) => e.grade === "F").length;
        const values = entries.map((e) => e.marks);
        return {
            subject_id: subject.id,
            subject_name: subject.subject_name,
            subject_code: subject.subject_code,
            full_marks: subject.full_marks,
            subject_type: subject.subject_type,
            appeared,
            passed: appeared - failedHere,
            failed: failedHere,
            pass_rate: appeared ? round2(((appeared - failedHere) / appeared) * 100) : 0,
            highest: values.length ? Math.max(...values) : 0,
            lowest: values.length ? Math.min(...values) : 0,
            average: values.length ? round2(values.reduce((a, b) => a + b, 0) / values.length) : 0,
            a_plus: entries.filter((e) => e.grade === "A+").length
        };
    });

    const groupMap = new Map();
    for (const s of students) {
        const key = s.group_name || "";
        if (!groupMap.has(key)) groupMap.set(key, []);
        groupMap.get(key).push(s);
    }
    const groupStats = [...groupMap.entries()].map(([group, list]) => {
        const p = list.filter((s) => s.result_status === "Pass");
        return {
            group_name: group,
            total: list.length,
            passed: p.length,
            failed: list.length - p.length,
            pass_rate: list.length ? round2((p.length / list.length) * 100) : 0,
            average_gpa: p.length ? round2(p.reduce((a, s) => a + s.final_gpa, 0) / p.length) : 0
        };
    });

    return {
        meta: report.meta,
        summary: {
            total_students: total,
            passed: passed.length,
            failed,
            pass_rate: total ? round2((passed.length / total) * 100) : 0,
            published,
            draft: total - published,
            highest_gpa: gpas.length ? Math.max(...gpas) : 0,
            lowest_gpa: gpas.length ? Math.min(...gpas) : 0,
            average_gpa: avgGpa,
            toppers: toppers.map((s) => ({ name: s.name, roll: s.roll, group_name: s.group_name, gpa: s.final_gpa }))
        },
        grades,
        subjects: subjectStats,
        groups: groupStats
    };
}

module.exports = { getExamReport, buildStatistics, assignPositions, usesFourthSubjectRule };
