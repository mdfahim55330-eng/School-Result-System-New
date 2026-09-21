"use strict";

// Bangladesh GPA-5 scale, exactly as used by the original system.
function getGrade(marks, fullMarks) {
    const percentage = (Number(marks) / Number(fullMarks)) * 100;

    if (percentage >= 80) return { grade: "A+", point: 5.0 };
    if (percentage >= 70) return { grade: "A", point: 4.0 };
    if (percentage >= 60) return { grade: "A-", point: 3.5 };
    if (percentage >= 50) return { grade: "B", point: 3.0 };
    if (percentage >= 40) return { grade: "C", point: 2.0 };
    if (percentage >= 33) return { grade: "D", point: 1.0 };
    return { grade: "F", point: 0.0 };
}

function gradeFromGpa(gpa) {
    if (gpa >= 5.0) return "A+";
    if (gpa >= 4.0) return "A";
    if (gpa >= 3.5) return "A-";
    if (gpa >= 3.0) return "B";
    if (gpa >= 2.0) return "C";
    if (gpa >= 1.0) return "D";
    return "F";
}

/**
 * results: [{ grade, grade_point, is_fourth_subject }]
 *  - fail in any main subject => GPA 0.00, grade F, "Fail"
 *  - 4th subject: only points above 2 are added as bonus
 *  - GPA is capped at 5.00
 */
function calculateFinalGPA(results) {
    if (!Array.isArray(results) || results.length === 0) {
        return { gpa: 0, grade: "F", status: "Fail" };
    }

    const isFourth = (r) => Number(r.is_fourth_subject || 0) === 1;
    const mainSubjects = results.filter((r) => !isFourth(r));
    const fourthSubjects = results.filter(isFourth);

    if (mainSubjects.length === 0) {
        return { gpa: 0, grade: "F", status: "Fail" };
    }

    for (const r of mainSubjects) {
        const point = Number(r.grade_point ?? 0);
        const grade = String(r.grade || "").trim().toUpperCase();
        if (grade === "F" || point <= 0) {
            return { gpa: 0, grade: "F", status: "Fail" };
        }
    }

    let totalPoint = 0;
    for (const r of mainSubjects) totalPoint += Number(r.grade_point ?? 0);

    for (const r of fourthSubjects) {
        const point = Number(r.grade_point ?? 0);
        if (point > 2) totalPoint += point - 2;
    }

    let gpa = totalPoint / mainSubjects.length;
    if (gpa > 5) gpa = 5;
    if (gpa < 0 || !Number.isFinite(gpa)) gpa = 0;
    gpa = Number(gpa.toFixed(2));

    return { gpa, grade: gradeFromGpa(gpa), status: "Pass" };
}

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

/**
 * Turn [{subject_id, marks}] into graded rows + the final result.
 * subjectsById: Map<number, subjectRow>. Throws a 400 error on invalid input.
 */
function gradeSubjects(subjectsById, entries) {
    const processed = [];
    const seen = new Set();

    for (const entry of entries) {
        const subjectId = Number(entry.subject_id);
        const subject = subjectsById.get(subjectId);
        if (!subject) throw httpError(400, "Invalid subject found.");
        if (seen.has(subjectId)) {
            throw httpError(400, `${subject.subject_name} is entered more than once.`);
        }
        seen.add(subjectId);

        const marks = Number(entry.marks);
        const fullMarks = Number(subject.full_marks);
        const blank = entry.marks === "" || entry.marks === null || entry.marks === undefined;

        if (blank || !Number.isFinite(marks) || marks < 0 || marks > fullMarks) {
            throw httpError(400, `Invalid marks for ${subject.subject_name}.`);
        }

        const g = getGrade(marks, fullMarks);
        processed.push({
            subject_id: subjectId,
            marks,
            full_marks: fullMarks,
            grade: g.grade,
            grade_point: g.point,
            is_fourth_subject: String(subject.subject_type || "").toLowerCase() === "fourth" ? 1 : 0
        });
    }

    return { processed, final: calculateFinalGPA(processed) };
}

module.exports = { getGrade, gradeFromGpa, calculateFinalGPA, gradeSubjects, httpError };
