"use strict";

// Restore a backup file made by the admin panel ("Download backup").
//   npm run restore -- path/to/result-backup.json
// Safety: it only works when the students / subjects / exams / results tables are EMPTY.

const fs = require("fs");
require("../src/config");
const db = require("../src/db");
const { migrate } = require("../src/migrate");

const COLUMNS = {
    exams: ["id", "exam_name", "exam_year", "class_name", "created_at"],
    subjects: ["id", "subject_name", "subject_code", "full_marks", "subject_type", "class_name", "created_at"],
    students: ["id", "name", "roll", "registration", "class_name", "group_name", "exam_name", "exam_year",
        "institute_name", "eiin", "status", "final_gpa", "final_grade", "result_status", "created_at"],
    results: ["id", "student_id", "subject_id", "marks", "grade", "grade_point", "is_fourth_subject", "created_at"]
};

(async () => {
    try {
        const file = process.argv[2];
        if (!file || !fs.existsSync(file)) {
            console.error("Usage: npm run restore -- <backup-file.json>");
            process.exit(1);
        }
        const backup = JSON.parse(fs.readFileSync(file, "utf8"));
        if (backup.app !== "school-result-system") throw new Error("This is not a backup file of this system.");

        await migrate();
        for (const table of Object.keys(COLUMNS)) {
            const n = Number((await db.one(`SELECT COUNT(*) AS n FROM ${table}`)).n);
            if (n > 0) throw new Error(`Table "${table}" is not empty. Restore only works on an empty database.`);
        }

        await db.tx(async (client) => {
            for (const table of ["exams", "subjects", "students", "results"]) {
                const cols = COLUMNS[table];
                for (const row of backup[table] || []) {
                    const values = cols.map((c) => (row[c] === undefined ? null : row[c]));
                    await client.query(
                        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(", ")})`,
                        values
                    );
                }
                await client.query(
                    `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), (SELECT COUNT(*) > 0 FROM ${table}))`
                );
                console.log(`${table}: ${(backup[table] || []).length} rows restored`);
            }
        });
        console.log("Restore finished.");
    } catch (error) {
        console.error("Restore failed:", error.message);
        process.exitCode = 1;
    } finally {
        await db.close();
    }
})();
