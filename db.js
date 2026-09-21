const { Pool } = require("pg");

// =====================================================
// PostgreSQL Connection
// =====================================================

if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,

    // Render PostgreSQL সাধারণত SSL ব্যবহার করে
    ssl: process.env.DATABASE_URL
        ? { rejectUnauthorized: false }
        : false,

    // আপাতত 1 connection রাখছি যাতে পুরোনো
    // SQLite transaction structure নিরাপদে কাজ করে
    max: 1
});

pool.on("error", (err) => {
    console.error("PostgreSQL pool error:", err.message);
});


// =====================================================
// Convert SQLite ? placeholders to PostgreSQL $1, $2...
// =====================================================

function convertPlaceholders(sql) {

    let index = 0;

    return sql.replace(/\?/g, () => {
        index++;
        return `$${index}`;
    });
}


// =====================================================
// Compatibility DB Object
// =====================================================

const db = {

    // -------------------------------------------------
    // db.get()
    // -------------------------------------------------

    get(sql, params = [], callback) {

        const pgSql = convertPlaceholders(sql);

        pool.query(pgSql, params)
            .then((result) => {

                const row = result.rows[0] || undefined;

                if (callback) {
                    callback(null, row);
                }

            })
            .catch((err) => {

                console.error("Database GET error:", err.message);

                if (callback) {
                    callback(err);
                }

            });
    },


    // -------------------------------------------------
    // db.all()
    // -------------------------------------------------

    all(sql, params = [], callback) {

        const pgSql = convertPlaceholders(sql);

        pool.query(pgSql, params)
            .then((result) => {

                if (callback) {
                    callback(null, result.rows);
                }

            })
            .catch((err) => {

                console.error("Database ALL error:", err.message);

                if (callback) {
                    callback(err);
                }

            });
    },


    // -------------------------------------------------
    // db.run()
    // -------------------------------------------------

    run(sql, params = [], callback) {

        let pgSql = convertPlaceholders(sql);

        const originalSql = pgSql.trim().toUpperCase();

        // INSERT-এর পরে SQLite-এর this.lastID-এর
        // equivalent পাওয়ার জন্য RETURNING id ব্যবহার করছি
        if (
            originalSql.startsWith("INSERT INTO") &&
            !originalSql.includes("RETURNING")
        ) {
            pgSql += " RETURNING id";
        }

        pool.query(pgSql, params)
            .then((result) => {

                const context = {
                    lastID:
                        result.rows &&
                        result.rows[0] &&
                        result.rows[0].id
                            ? result.rows[0].id
                            : undefined,

                    changes: result.rowCount || 0
                };

                if (callback) {
                    callback.call(context, null);
                }

            })
            .catch((err) => {

                console.error("Database RUN error:", err.message);

                if (callback) {
                    callback.call(
                        {
                            lastID: undefined,
                            changes: 0
                        },
                        err
                    );
                }

            });
    },


    // -------------------------------------------------
    // db.serialize()
    // -------------------------------------------------

    serialize(callback) {

        // PostgreSQL pool max=1 রাখা হয়েছে,
        // তাই query execution order বজায় থাকবে।

        if (typeof callback === "function") {
            callback();
        }
    },


    // -------------------------------------------------
    // Direct PostgreSQL pool access
    // ভবিষ্যতে দরকার হলে ব্যবহার করতে পারব
    // -------------------------------------------------

    pool: pool
};


// =====================================================
// Create Database Tables
// =====================================================

async function initializeDatabase() {

    try {

        console.log("Connecting to PostgreSQL...");

        await pool.query(`
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
            )
        `);


        // =================================================
        // Subjects Table
        // =================================================

        await pool.query(`
            CREATE TABLE IF NOT EXISTS subjects (
                id SERIAL PRIMARY KEY,

                subject_name TEXT NOT NULL,
                subject_code TEXT NOT NULL,

                full_marks INTEGER NOT NULL,

                subject_type TEXT DEFAULT 'main',

                class_name TEXT,

                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);


        // =================================================
        // Results Table
        // =================================================

        await pool.query(`
            CREATE TABLE IF NOT EXISTS results (
                id SERIAL PRIMARY KEY,

                student_id INTEGER NOT NULL,
                subject_id INTEGER NOT NULL,

                marks REAL DEFAULT 0,
                grade TEXT,
                grade_point REAL DEFAULT 0,

                is_fourth_subject INTEGER DEFAULT 0,

                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                FOREIGN KEY (student_id)
                    REFERENCES students(id)
                    ON DELETE CASCADE,

                FOREIGN KEY (subject_id)
                    REFERENCES subjects(id)
                    ON DELETE CASCADE
            )
        `);


        // =================================================
        // Admin Users Table
        // =================================================

        await pool.query(`
            CREATE TABLE IF NOT EXISTS admins (
                id SERIAL PRIMARY KEY,

                username TEXT NOT NULL UNIQUE,
                password TEXT NOT NULL,

                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);


        // =================================================
        // Classes Table
        // =================================================

        await pool.query(`
            CREATE TABLE IF NOT EXISTS classes (
                id SERIAL PRIMARY KEY,
                class_name TEXT NOT NULL UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Existing data থেকে class নামগুলো classes table-এ নিয়ে আসি
        await pool.query(`
            INSERT INTO classes (class_name)
            SELECT DISTINCT TRIM(class_name)
            FROM (
                SELECT class_name FROM students
                UNION
                SELECT class_name FROM exams
                UNION
                SELECT class_name FROM subjects
            ) AS existing_classes
            WHERE class_name IS NOT NULL
              AND TRIM(class_name) <> ''
            ON CONFLICT (class_name) DO NOTHING
        `);


        // =================================================
        // Exams Table
        // =================================================

        await pool.query(`
            CREATE TABLE IF NOT EXISTS exams (
                id SERIAL PRIMARY KEY,

                exam_name TEXT NOT NULL,
                exam_year INTEGER NOT NULL,
                class_name TEXT NOT NULL,

                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);


        console.log("=================================");
        console.log("PostgreSQL database connected.");
        console.log("Database tables are ready.");
        console.log("=================================");

    } catch (err) {

        console.error(
            "PostgreSQL database initialization failed:",
            err.message
        );

    }
}


// Start database initialization
initializeDatabase();


// Export database compatibility object
module.exports = db;