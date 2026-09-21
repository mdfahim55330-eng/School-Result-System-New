"use strict";

const bcrypt = require("bcrypt");
const db = require("./db");
const config = require("./config");

const LOCK_KEY = 5533011; // arbitrary number, just so two servers never migrate at once

async function columnExists(table, column) {
    const row = await db.one(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?`,
        [table, column]
    );
    return !!row;
}

// Create a UNIQUE index. If the existing data already has duplicates the index cannot be
// created: we DON'T crash and we DON'T delete anything, we just warn (the application also
// checks for duplicates itself before every insert).
async function tryUniqueIndex(name, sql, hint) {
    try {
        await db.query(sql);
        return true;
    } catch (error) {
        if (error.code === "23505") {
            console.warn(
                `[migrate] WARNING: could not create unique index "${name}" because duplicate rows already exist.\n` +
                `          ${hint}\n` +
                `          Run "npm run find-duplicates" to list them, fix them, then restart the server.`
            );
            return false;
        }
        throw error;
    }
}

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);

        // ------------------------------------------------------------------
        // 1. Base tables (unchanged structure from the original system)
        // ------------------------------------------------------------------
        await client.query(`
            CREATE TABLE IF NOT EXISTS students (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                roll TEXT NOT NULL,
                registration TEXT,
                class_name TEXT NOT NULL,
                group_name TEXT,
                exam_name TEXT NOT NULL,
                exam_year INTEGER NOT NULL,
                institute_name TEXT,
                eiin TEXT,
                status TEXT DEFAULT 'draft',
                final_gpa REAL DEFAULT 0,
                final_grade TEXT DEFAULT 'F',
                result_status TEXT DEFAULT 'Fail',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS subjects (
                id SERIAL PRIMARY KEY,
                subject_name TEXT NOT NULL,
                subject_code TEXT NOT NULL,
                full_marks INTEGER NOT NULL,
                subject_type TEXT DEFAULT 'main',
                class_name TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS exams (
                id SERIAL PRIMARY KEY,
                exam_name TEXT NOT NULL,
                exam_year INTEGER NOT NULL,
                class_name TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS results (
                id SERIAL PRIMARY KEY,
                student_id INTEGER NOT NULL,
                subject_id INTEGER NOT NULL,
                marks REAL DEFAULT 0,
                grade TEXT,
                grade_point REAL DEFAULT 0,
                is_fourth_subject INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
                FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
            )`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS admins (
                id SERIAL PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                password TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);

        // ------------------------------------------------------------------
        // 2. Upgrades for databases created by the old version
        // ------------------------------------------------------------------
        const hadMustChange = await columnExists("admins", "must_change_password");

        await client.query(`ALTER TABLE admins ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin'`);
        await client.query(`ALTER TABLE admins ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`);
        await client.query(`ALTER TABLE admins ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE`);
        await client.query(`ALTER TABLE admins ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ`);

        if (!hadMustChange) {
            // First time this upgrade runs: the old system created a default admin whose
            // password was written in the (public) source code. Force every existing admin
            // to choose a new password at the next login.
            const changed = await client.query(`UPDATE admins SET must_change_password = TRUE`);
            if (changed.rowCount > 0) {
                console.warn(
                    `[migrate] ${changed.rowCount} existing admin account(s) must set a new password at next login.`
                );
            }
        }

        await client.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`);

        // ------------------------------------------------------------------
        // 3. New tables
        // ------------------------------------------------------------------
        await client.query(`
            CREATE TABLE IF NOT EXISTS audit_log (
                id BIGSERIAL PRIMARY KEY,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                admin_id INTEGER,
                username TEXT,
                role TEXT,
                action TEXT NOT NULL,
                entity TEXT,
                entity_id TEXT,
                summary TEXT,
                details JSONB,
                ip TEXT
            )`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS session (
                sid VARCHAR NOT NULL PRIMARY KEY,
                sess JSON NOT NULL,
                expire TIMESTAMP(6) NOT NULL
            )`);

        // ------------------------------------------------------------------
        // 4. Indexes (speed)
        // ------------------------------------------------------------------
        const indexes = [
            `CREATE INDEX IF NOT EXISTS idx_students_lookup ON students (class_name, exam_name, exam_year, roll)`,
            `CREATE INDEX IF NOT EXISTS idx_students_status ON students (status)`,
            `CREATE INDEX IF NOT EXISTS idx_results_student ON results (student_id)`,
            `CREATE INDEX IF NOT EXISTS idx_results_subject ON results (subject_id)`,
            `CREATE INDEX IF NOT EXISTS idx_subjects_class ON subjects (class_name)`,
            `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC)`,
            `CREATE INDEX IF NOT EXISTS idx_session_expire ON session (expire)`
        ];
        for (const sql of indexes) await client.query(sql);

        // ------------------------------------------------------------------
        // 5. Uniqueness (stops duplicate students / results)
        // ------------------------------------------------------------------
        await tryUniqueIndex(
            "uq_students_roll",
            `CREATE UNIQUE INDEX IF NOT EXISTS uq_students_roll
             ON students (class_name, exam_name, exam_year, roll)`,
            "Some students have the same roll in the same class, exam and year."
        );
        await tryUniqueIndex(
            "uq_results_student_subject",
            `CREATE UNIQUE INDEX IF NOT EXISTS uq_results_student_subject ON results (student_id, subject_id)`,
            "Some students have the same subject saved twice."
        );
        await tryUniqueIndex(
            "uq_exams",
            `CREATE UNIQUE INDEX IF NOT EXISTS uq_exams ON exams (exam_name, exam_year, class_name)`,
            "The same exam was added more than once."
        );
        await tryUniqueIndex(
            "uq_subjects_class_code",
            `CREATE UNIQUE INDEX IF NOT EXISTS uq_subjects_class_code ON subjects (class_name, subject_code)`,
            "The same subject code was added twice for one class."
        );
    } finally {
        try {
            await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
        } catch (e) { /* ignore */ }
        client.release();
    }

    await bootstrapAdmin();
}

// Creates the first admin ONLY when there is no admin at all, and only from environment
// variables. No password is ever written in the source code.
async function bootstrapAdmin() {
    const count = Number((await db.one(`SELECT COUNT(*) AS n FROM admins`)).n);
    if (count > 0) return;

    const { username, password } = config.bootstrapAdmin;
    if (!username || !password) {
        console.warn(
            "\n[setup] There is no admin account yet.\n" +
            "        Create one with:  npm run set-admin\n" +
            "        (or set ADMIN_USERNAME and ADMIN_PASSWORD once, then restart)\n"
        );
        return;
    }
    if (password.length < 8) {
        console.error("[setup] ADMIN_PASSWORD must be at least 8 characters. Admin not created.");
        return;
    }

    const hash = await bcrypt.hash(password, 12);
    await db.query(
        `INSERT INTO admins (username, password, role, must_change_password)
         VALUES (?, ?, 'admin', FALSE) ON CONFLICT (username) DO NOTHING`,
        [username.trim(), hash]
    );
    console.log(`[setup] Admin account "${username.trim()}" created. You can now remove ADMIN_PASSWORD from the environment.`);
}

module.exports = { migrate };
