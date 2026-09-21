"use strict";

// Simulates upgrading a database created by the OLD version of the system.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcrypt");
const { startServer, client, db, resetDatabase } = require("./helpers");
const { migrate } = require("../src/migrate");

let srv;
const warnings = [];

before(async () => {
    await resetDatabase();
    // ---- the old schema, exactly as the old db.js created it ----
    await db.query(`CREATE TABLE students (id SERIAL PRIMARY KEY, name TEXT NOT NULL, roll TEXT NOT NULL, registration TEXT,
        class_name TEXT NOT NULL, group_name TEXT, exam_name TEXT NOT NULL, exam_year INTEGER NOT NULL, institute_name TEXT, eiin TEXT,
        status TEXT DEFAULT 'draft', final_gpa REAL DEFAULT 0, final_grade TEXT DEFAULT 'F', result_status TEXT DEFAULT 'Fail',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await db.query(`CREATE TABLE subjects (id SERIAL PRIMARY KEY, subject_name TEXT NOT NULL, subject_code TEXT NOT NULL,
        full_marks INTEGER NOT NULL, subject_type TEXT DEFAULT 'main', class_name TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await db.query(`CREATE TABLE exams (id SERIAL PRIMARY KEY, exam_name TEXT NOT NULL, exam_year INTEGER NOT NULL, class_name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await db.query(`CREATE TABLE results (id SERIAL PRIMARY KEY, student_id INTEGER NOT NULL, subject_id INTEGER NOT NULL, marks REAL DEFAULT 0,
        grade TEXT, grade_point REAL DEFAULT 0, is_fourth_subject INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE, FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE)`);
    await db.query(`CREATE TABLE admins (id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);

    const hash = await bcrypt.hash("OldPassword1", 10);
    await db.query(`INSERT INTO admins (username, password) VALUES ('Fahim', $1)`, [hash]);
    await db.query(`INSERT INTO subjects (subject_name, subject_code, full_marks, subject_type, class_name) VALUES ('Bangla','101',100,'main','Nine')`);
    await db.query(`INSERT INTO exams (exam_name, exam_year, class_name) VALUES ('Half Yearly',2025,'Nine')`);
    // two students with the SAME roll (this is what the old system allowed) + one normal
    for (const [name, roll] of [["Old A", "5"], ["Old B", "5"], ["Old C", "6"]]) {
        const s = await db.query(`INSERT INTO students (name, roll, class_name, group_name, exam_name, exam_year, status, final_gpa, final_grade, result_status)
            VALUES ($1,$2,'Nine','Science','Half Yearly',2025,'published',5,'A+','Pass') RETURNING id`, [name, roll]);
        await db.query(`INSERT INTO results (student_id, subject_id, marks, grade, grade_point) VALUES ($1,1,90,'A+',5)`, [s.rows[0].id]);
    }

    const originalWarn = console.warn;
    console.warn = (...a) => { warnings.push(a.join(" ")); };
    srv = await startServer({ reset: false });
    console.warn = originalWarn;
});
after(async () => { await srv.stop(); });

test("upgrade keeps all data, does not crash on old duplicates, and warns", async () => {
    assert.equal(Number((await db.one(`SELECT COUNT(*) AS n FROM students`)).n), 3);
    assert.ok(warnings.some((w) => /uq_students_roll/.test(w)), "expected a duplicate warning: " + warnings.join("\n"));
    assert.ok(warnings.some((w) => /must set a new password/.test(w)));
    const idx = await db.one(`SELECT 1 AS x FROM pg_indexes WHERE indexname = 'uq_students_roll'`);
    assert.equal(idx, null);                         // not created while duplicates exist
    assert.ok(await db.one(`SELECT 1 AS x FROM pg_indexes WHERE indexname = 'uq_results_student_subject'`));
});

test("old admin becomes an admin who must change the password", async () => {
    const c = client(srv.base);
    const r = await c.post("/api/admin/login", { username: "Fahim", password: "OldPassword1" });
    assert.equal(r.status, 200);
    assert.equal(r.data.role, "admin");
    assert.equal(r.data.must_change_password, true);
    assert.equal((await c.get("/api/admin/results")).data.code, "PASSWORD_CHANGE_REQUIRED");
    // staff pages send the user to the change-password page
    const page = await c.request("GET", "/pages/admin.html", { raw: true });
    assert.equal(page.status, 302);
    assert.match(page.headers.get("location"), /change-password/);
    assert.equal((await c.post("/api/admin/change-password", { current_password: "OldPassword1", new_password: "BrandNew@2026" })).status, 200);
    assert.equal((await c.get("/api/admin/results")).data.results.length, 3);
});

test("app still blocks NEW duplicates even without the database index, and old results still work", async () => {
    const c = client(srv.base);
    await c.post("/api/admin/login", { username: "Fahim", password: "BrandNew@2026" });
    const r = await c.post("/api/admin/results/individual", {
        exam_id: 1, student: { name: "New D", roll: "6" }, results: [{ subject_id: 1, marks: 88 }]
    });
    assert.equal(r.status, 409);
    // public search: roll 6 is unique -> found; roll 5 exists twice -> never guess
    const anon = client(srv.base);
    const q = (roll) => `/api/result/search?roll=${roll}&class_name=Nine&exam_name=${encodeURIComponent("Half Yearly")}&exam_year=2025`;
    assert.equal((await anon.get(q(6))).status, 200);
    assert.equal((await anon.get(q(5))).status, 409);
});

test("after the duplicates are fixed, the next start switches the protection on", async () => {
    await db.query(`DELETE FROM students WHERE name = 'Old B'`);
    await migrate();
    assert.ok(await db.one(`SELECT 1 AS x FROM pg_indexes WHERE indexname = 'uq_students_roll'`));
    await migrate();   // running twice is harmless
});
