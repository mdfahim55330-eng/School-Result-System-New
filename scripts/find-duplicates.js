"use strict";

// Lists duplicate data that stops the "no duplicates" rules from being switched on.
//   npm run find-duplicates

require("../src/config");
const db = require("../src/db");

(async () => {
    try {
        const students = await db.all(
            `SELECT class_name, exam_name, exam_year, roll, COUNT(*)::int AS times,
                    STRING_AGG(id::text || ':' || name, ' | ' ORDER BY id) AS students
             FROM students GROUP BY class_name, exam_name, exam_year, roll HAVING COUNT(*) > 1
             ORDER BY exam_year DESC, class_name, roll`
        );
        const results = await db.all(
            `SELECT student_id, subject_id, COUNT(*)::int AS times FROM results
             GROUP BY student_id, subject_id HAVING COUNT(*) > 1`
        );
        const exams = await db.all(
            `SELECT exam_name, exam_year, class_name, COUNT(*)::int AS times FROM exams
             GROUP BY exam_name, exam_year, class_name HAVING COUNT(*) > 1`
        );
        const subjects = await db.all(
            `SELECT class_name, subject_code, COUNT(*)::int AS times FROM subjects
             GROUP BY class_name, subject_code HAVING COUNT(*) > 1`
        );

        console.log(`\nStudents with the same roll (same class, exam, year): ${students.length}`);
        students.forEach((s) => console.log(`  Class ${s.class_name} | ${s.exam_name} ${s.exam_year} | roll ${s.roll} -> ${s.students}`));
        console.log(`Students with the same subject saved twice: ${results.length}`);
        results.forEach((r) => console.log(`  student id ${r.student_id}, subject id ${r.subject_id} (${r.times}x)`));
        console.log(`Exams added twice: ${exams.length}`);
        exams.forEach((e) => console.log(`  ${e.exam_name} ${e.exam_year} Class ${e.class_name} (${e.times}x)`));
        console.log(`Subject codes used twice in a class: ${subjects.length}`);
        subjects.forEach((s) => console.log(`  Class ${s.class_name} code ${s.subject_code} (${s.times}x)`));

        if (!students.length && !results.length && !exams.length && !subjects.length) {
            console.log("\nNo duplicates found. Restart the server to switch the duplicate protection on.");
        } else {
            console.log("\nFix these (delete or edit the extra rows from the admin panel), then restart the server.");
        }
    } catch (error) {
        console.error("Failed:", error.message);
        process.exitCode = 1;
    } finally {
        await db.close();
    }
})();
