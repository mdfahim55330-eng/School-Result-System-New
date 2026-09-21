require("dotenv").config();

const express = require("express");
const cors = require("cors");
const session = require("express-session");
const path = require("path");
const XLSX = require("xlsx");
const multer = require("multer");
const bcrypt = require("bcrypt");

const upload = multer({
    storage: multer.memoryStorage()
});

const db = require("./db");

const app = express();

const PORT = process.env.PORT || 3000;


// =====================================================
// MIDDLEWARE
// =====================================================

app.use(cors());

app.use(express.json());

app.use(
    express.urlencoded({
        extended: true
    })
);

app.set("trust proxy", 1);

app.use(
    session({
        secret: process.env.SESSION_SECRET || "school-result-secret-key",
        resave: false,
        saveUninitialized: false,

        cookie: {
            secure: process.env.NODE_ENV === "production",
            httpOnly: true,
            sameSite: "lax",
            maxAge: 1000 * 60 * 60 * 8
        }
    })
);


// =====================================================
// STATIC FILES
// =====================================================

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);


// =====================================================
// HOME
// =====================================================

app.get("/", (req, res) => {

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>School Result System</title>
        </head>

        <body>

            <h1>School Result Management System</h1>

            <p>Server is working successfully.</p>

        </body>
        </html>
    `);

});


// =====================================================
// TEST API
// =====================================================

app.get("/api/test", (req, res) => {

    res.json({
        success: true,
        message: "API is working successfully."
    });

});


// =====================================================
// CREATE DEFAULT ADMIN
// =====================================================

async function createDefaultAdmin() {

    const username = "Fahim";
    const password = "Fahim@55330";

    db.get(
        "SELECT id FROM admins WHERE username = ?",
        [username],

        async (err, row) => {

            if (err) {

                console.error(
                    "Admin check error:",
                    err.message
                );

                return;
            }

            if (row) {
                return;
            }

            try {

                const hashedPassword =
                    await bcrypt.hash(password, 10);

                db.run(
                    `
                    INSERT INTO admins
                    (username, password)
                    VALUES (?, ?)
                    `,
                    [
                        username,
                        hashedPassword
                    ],

                    (err) => {

                        if (err) {

                            console.error(
                                "Admin creation error:",
                                err.message
                            );

                        } else {

                            console.log(
                                "Default admin created."
                            );

                        }

                    }
                );

            } catch (error) {

                console.error(
                    "Password hash error:",
                    error.message
                );

            }

        }
    );

}

createDefaultAdmin();


// =====================================================
// ADMIN LOGIN
// =====================================================

app.post(
    "/api/admin/login",
    async (req, res) => {

        try {

            const {
                username,
                password
            } = req.body;

            if (!username || !password) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Username and password are required."
                });

            }

            db.get(
                `
                SELECT *
                FROM admins
                WHERE username = ?
                `,
                [username],

                async (err, admin) => {

                    if (err) {

                        console.error(
                            "Login database error:",
                            err.message
                        );

                        return res.status(500).json({
                            success: false,
                            message:
                                "Database error."
                        });

                    }

                    if (!admin) {

                        return res.status(401).json({
                            success: false,
                            message:
                                "Invalid username or password."
                        });

                    }

                    const passwordMatch =
                        await bcrypt.compare(
                            password,
                            admin.password
                        );

                    if (!passwordMatch) {

                        return res.status(401).json({
                            success: false,
                            message:
                                "Invalid username or password."
                        });

                    }

                    req.session.adminId =
                        admin.id;

                    req.session.adminUsername =
                        admin.username;

                    res.json({
                        success: true,
                        message:
                            "Login successful.",
                        username:
                            admin.username
                    });

                }
            );

        } catch (error) {

            console.error(error);

            res.status(500).json({
                success: false,
                message:
                    "Server error."
            });

        }

    }
);


// =====================================================
// CHECK LOGIN
// =====================================================

app.get(
    "/api/admin/me",
    (req, res) => {

        if (!req.session.adminId) {

            return res.json({
                loggedIn: false
            });

        }

        res.json({
            loggedIn: true,
            username:
                req.session.adminUsername
        });

    }
);


// =====================================================
// LOGOUT
// =====================================================

app.post(
    "/api/admin/logout",
    (req, res) => {

        req.session.destroy(
            (err) => {

                if (err) {

                    return res.status(500).json({
                        success: false,
                        message:
                            "Logout failed."
                    });

                }

                res.json({
                    success: true,
                    message:
                        "Logout successful."
                });

            }
        );

    }
);


// =====================================================
// ADMIN AUTH MIDDLEWARE
// =====================================================

function requireAdmin(
    req,
    res,
    next
) {

    if (!req.session.adminId) {

        return res.status(401).json({
            success: false,
            message:
                "Admin login required."
        });

    }

    next();

}


// =====================================================
// SUBJECT APIs
// =====================================================

// GET ALL SUBJECTS

app.get(
    "/api/admin/subjects",
    requireAdmin,
    (req, res) => {

        db.all(
            `
            SELECT *
            FROM subjects
            ORDER BY
                class_name ASC,
                subject_code ASC
            `,
            [],

            (err, rows) => {

                if (err) {

                    return res.status(500).json({
                        success: false,
                        message:
                            err.message
                    });

                }

                res.json({
                    success: true,
                    subjects: rows
                });

            }
        );

    }
);


// ADD SUBJECT

app.post(
    "/api/admin/subjects",
    requireAdmin,
    (req, res) => {

        const {
            class_name,
            subject_name,
            subject_code,
            full_marks,
            subject_type
        } = req.body;


        if (
            !class_name ||
            !subject_name ||
            !subject_code ||
            !full_marks
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Class, subject name, subject code and full marks are required."
            });

        }


        db.get(
            `
            SELECT id
            FROM subjects
            WHERE class_name = ?
            AND subject_code = ?
            `,
            [
                class_name,
                subject_code
            ],

            (err, existing) => {

                if (err) {

                    return res.status(500).json({
                        success: false,
                        message:
                            err.message
                    });

                }


                if (existing) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "This subject already exists for this class."
                    });

                }


                db.run(
                    `
                    INSERT INTO subjects
                    (
                        class_name,
                        subject_name,
                        subject_code,
                        full_marks,
                        subject_type
                    )
                    VALUES (?, ?, ?, ?, ?)
                    `,
                    [
                        class_name,
                        subject_name,
                        subject_code,
                        Number(full_marks),
                        subject_type || "main"
                    ],

                    function(err) {

                        if (err) {

                            return res.status(500).json({
                                success: false,
                                message:
                                    err.message
                            });

                        }

                        res.json({
                            success: true,
                            message:
                                "Subject added successfully.",
                            id:
                                this.lastID
                        });

                    }
                );

            }
        );

    }
);


// DELETE SUBJECT

app.delete(
    "/api/admin/subjects/:id",
    requireAdmin,
    (req, res) => {

        const id =
            req.params.id;

        db.run(
            `
            DELETE FROM subjects
            WHERE id = ?
            `,
            [id],

            function(err) {

                if (err) {

                    return res.status(500).json({
                        success: false,
                        message:
                            err.message
                    });

                }


                if (this.changes === 0) {

                    return res.status(404).json({
                        success: false,
                        message:
                            "Subject not found."
                    });

                }


                res.json({
                    success: true,
                    message:
                        "Subject deleted successfully."
                });

            }
        );

    }
);


// =====================================================
// EXAM APIs
// =====================================================

// ========================================
// GET ALL EXAMS
// ========================================

app.get(
    "/api/admin/exams",
    requireAdmin,
    (req, res) => {

        db.all(
            `
            SELECT
                MIN(id) AS id,
                exam_name,
                exam_year,
                class_name
            FROM exams
            WHERE
                exam_name IS NOT NULL
                AND TRIM(exam_name) <> ''
            GROUP BY
                exam_name,
                exam_year,
                class_name
            ORDER BY
                exam_year DESC,
                class_name ASC,
                exam_name ASC
            `,
            [],
            (err, rows) => {

                if (err) {

                    console.error(
                        "Load exams error:",
                        err.message
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Exam list could not be loaded."
                    });

                }

                res.json({
                    success: true,
                    exams: rows || []
                });

            }
        );

    }
);




// ADD EXAM

app.post(
    "/api/admin/exams",
    requireAdmin,
    (req, res) => {

        const {
            exam_name,
            exam_year,
            class_name
        } = req.body;


        if (
            !exam_name ||
            !exam_year ||
            !class_name
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "All fields are required."
            });

        }


        db.run(
            `
            INSERT INTO exams
            (
                exam_name,
                exam_year,
                class_name
            )
            VALUES (?, ?, ?)
            `,
            [
                exam_name,
                Number(exam_year),
                class_name
            ],

            function(err) {

                if (err) {

                    return res.status(500).json({
                        success: false,
                        message:
                            err.message
                    });

                }

                res.json({
                    success: true,
                    message:
                        "Exam added successfully.",
                    id:
                        this.lastID
                });

            }
        );

    }
);


// DELETE EXAM

app.delete(
    "/api/admin/exams/:id",
    requireAdmin,
    (req, res) => {

        const id =
            req.params.id;

        db.run(
            `
            DELETE FROM exams
            WHERE id = ?
            `,
            [id],

            function(err) {

                if (err) {

                    return res.status(500).json({
                        success: false,
                        message:
                            err.message
                    });

                }

                res.json({
                    success: true,
                    message:
                        "Exam deleted successfully."
                });

            }
        );

    }
);


// =====================================================
// GRADING SYSTEM
// =====================================================

function getGrade(
    marks,
    fullMarks
) {

    const percentage =
        (
            Number(marks) /
            Number(fullMarks)
        ) * 100;


    if (percentage >= 80) {

        return {
            grade: "A+",
            point: 5.00
        };

    }


    if (percentage >= 70) {

        return {
            grade: "A",
            point: 4.00
        };

    }


    if (percentage >= 60) {

        return {
            grade: "A-",
            point: 3.50
        };

    }


    if (percentage >= 50) {

        return {
            grade: "B",
            point: 3.00
        };

    }


    if (percentage >= 40) {

        return {
            grade: "C",
            point: 2.00
        };

    }


    if (percentage >= 33) {

        return {
            grade: "D",
            point: 1.00
        };

    }


    return {
        grade: "F",
        point: 0.00
    };

}


// =====================================================
// FINAL GPA CALCULATION
// =====================================================
// Supports:
// 1. 50 Marks Subject
// 2. 100 Marks Subject
// 3. 4th Subject Bonus
// 4. Fail Detection
// 5. Maximum GPA = 5.00
// =====================================================

function calculateFinalGPA(results) {

    // ---------------------------------------------
    // Basic validation
    // ---------------------------------------------

    if (!Array.isArray(results) || results.length === 0) {

        return {
            gpa: 0.00,
            grade: "F",
            status: "Fail"
        };

    }


    // ---------------------------------------------
    // Separate Main + 4th Subject
    // ---------------------------------------------

    const mainSubjects = results.filter(result => {

        return Number(result.is_fourth_subject || 0) !== 1;

    });


    const fourthSubjects = results.filter(result => {

        return Number(result.is_fourth_subject || 0) === 1;

    });


    // ---------------------------------------------
    // No Main Subject
    // ---------------------------------------------

    if (mainSubjects.length === 0) {

        return {
            gpa: 0.00,
            grade: "F",
            status: "Fail"
        };

    }


    // ---------------------------------------------
    // Check Fail
    // ---------------------------------------------

    let hasFail = false;


    for (const result of mainSubjects) {

        const point = Number(
            result.grade_point ?? 0
        );

        const grade = String(
            result.grade || ""
        ).trim().toUpperCase();


        // F grade = Fail

        if (
            grade === "F" ||
            point <= 0
        ) {

            hasFail = true;

            break;

        }

    }


    // ---------------------------------------------
    // If Main Subject has F
    // ---------------------------------------------

    if (hasFail) {

        return {
            gpa: 0.00,
            grade: "F",
            status: "Fail"
        };

    }


    // ---------------------------------------------
    // Calculate Main Subject Points
    // ---------------------------------------------

    let totalPoint = 0;


    for (const result of mainSubjects) {

        const point = Number(
            result.grade_point ?? 0
        );


        totalPoint += point;

    }


    // ---------------------------------------------
    // Calculate 4th Subject Bonus
    // ---------------------------------------------

    let fourthBonus = 0;


    for (const result of fourthSubjects) {

        const point = Number(
            result.grade_point ?? 0
        );


        // Only points above 2 count as bonus

        if (point > 2) {

            fourthBonus += (
                point - 2
            );

        }

    }


    // ---------------------------------------------
    // Add 4th Subject Bonus
    // ---------------------------------------------

    totalPoint += fourthBonus;


    // ---------------------------------------------
    // Calculate GPA
    // ---------------------------------------------

    let gpa =
        totalPoint /
        mainSubjects.length;


    // ---------------------------------------------
    // Maximum GPA = 5.00
    // ---------------------------------------------

    if (gpa > 5) {

        gpa = 5;

    }


    if (gpa < 0 || !isFinite(gpa)) {

        gpa = 0;

    }


    // ---------------------------------------------
    // Round to 2 Decimal
    // ---------------------------------------------

    gpa = Number(
        gpa.toFixed(2)
    );


    // ---------------------------------------------
    // Final Grade
    // ---------------------------------------------

    let grade;


    if (gpa >= 5.00) {

        grade = "A+";

    }

    else if (gpa >= 4.00) {

        grade = "A";

    }

    else if (gpa >= 3.50) {

        grade = "A-";

    }

    else if (gpa >= 3.00) {

        grade = "B";

    }

    else if (gpa >= 2.00) {

        grade = "C";

    }

    else if (gpa >= 1.00) {

        grade = "D";

    }

    else {

        grade = "F";

    }


    // ---------------------------------------------
    // Final Result
    // ---------------------------------------------

    return {

        gpa: gpa,

        grade: grade,

        status: "Pass"

    };

}



// =====================================================
// SAVE INDIVIDUAL RESULT
// PostgreSQL Safe Transaction Version
// =====================================================

app.post(
    "/api/admin/results/individual",
    requireAdmin,
    async (req, res) => {

        let client = null;

        try {

            const {
                exam_id,
                student,
                results
            } = req.body;

            // =====================================================
            // BASIC VALIDATION
            // =====================================================

            if (
                !exam_id ||
                !student ||
                !student.name ||
                !student.roll ||
                !Array.isArray(results) ||
                results.length === 0
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Exam, student information and subject results are required."
                });
            }

            // =====================================================
            // FIND EXAM
            // =====================================================

            const examResult =
                await db.pool.query(
                    `
                    SELECT *
                    FROM exams
                    WHERE id = $1
                    `,
                    [Number(exam_id)]
                );

            const exam =
                examResult.rows[0];

            if (!exam) {
                return res.status(404).json({
                    success: false,
                    message: "Exam not found."
                });
            }

            // =====================================================
            // LOAD CLASS-WISE SUBJECTS
            // =====================================================

            const subjectResult =
                await db.pool.query(
                    `
                    SELECT *
                    FROM subjects
                    WHERE class_name = $1
                    ORDER BY subject_code ASC, id ASC
                    `,
                    [exam.class_name]
                );

            const classSubjects =
                subjectResult.rows;

            if (
                !classSubjects ||
                classSubjects.length === 0
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        `No subjects found for Class ${exam.class_name}.`
                });
            }

            // =====================================================
            // VALID SUBJECT IDs
            // =====================================================

            const validSubjectIds =
                new Set(
                    classSubjects.map(
                        subject => Number(subject.id)
                    )
                );

            // =====================================================
            // VALIDATE ALL SUBJECTS
            // =====================================================

            for (const result of results) {

                const subjectId =
                    Number(result.subject_id);

                if (
                    !validSubjectIds.has(
                        subjectId
                    )
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            `Invalid subject for Class ${exam.class_name}.`
                    });
                }
            }

            // =====================================================
            // PROCESS RESULTS + CALCULATE GPA
            // =====================================================

            const processedResults = [];

            for (const result of results) {

                const subject =
                    classSubjects.find(
                        item =>
                            Number(item.id) ===
                            Number(result.subject_id)
                    );

                if (!subject) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Invalid subject found."
                    });
                }

                const marks =
                    Number(result.marks);

                const fullMarks =
                    Number(subject.full_marks);

                // -------------------------------------------------
                // MARKS VALIDATION
                // -------------------------------------------------

                if (
                    !Number.isFinite(marks) ||
                    marks < 0 ||
                    marks > fullMarks
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            `Invalid marks for ${subject.subject_name}.`
                    });
                }

                const gradeInfo =
                    getGrade(
                        marks,
                        fullMarks
                    );

                processedResults.push({
                    subject_id:
                        Number(subject.id),

                    marks:
                        marks,

                    grade:
                        gradeInfo.grade,

                    grade_point:
                        gradeInfo.point,

                    is_fourth_subject:
                        String(
                            subject.subject_type || ""
                        ).toLowerCase() === "fourth"
                            ? 1
                            : 0
                });
            }

            // =====================================================
            // FINAL GPA
            // =====================================================

            const finalResult =
                calculateFinalGPA(
                    processedResults
                );

            console.log(
                "Individual Final Result:",
                finalResult
            );

            // =====================================================
            // POSTGRESQL REAL TRANSACTION
            // =====================================================

            client =
                await db.pool.connect();

            await client.query(
                "BEGIN"
            );

            // =====================================================
            // SAVE STUDENT
            // =====================================================

            const studentInsert =
                await client.query(
                    `
                    INSERT INTO students
                    (
                        name,
                        roll,
                        registration,
                        class_name,
                        group_name,
                        exam_name,
                        exam_year,
                        final_gpa,
                        final_grade,
                        result_status,
                        status
                    )
                    VALUES
                    (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6,
                        $7,
                        $8,
                        $9,
                        $10,
                        $11
                    )
                    RETURNING id
                    `,
                    [
                        student.name,
                        student.roll,
                        student.registration || "",
                        exam.class_name,
                        student.group_name || "",
                        exam.exam_name,
                        exam.exam_year,
                        finalResult.gpa,
                        finalResult.grade,
                        finalResult.status,
                        "draft"
                    ]
                );

            const studentId =
                studentInsert.rows[0].id;

            // =====================================================
            // SAVE SUBJECT RESULTS
            // =====================================================

            for (
                const processed
                of processedResults
            ) {

                await client.query(
                    `
                    INSERT INTO results
                    (
                        student_id,
                        subject_id,
                        marks,
                        grade,
                        grade_point,
                        is_fourth_subject
                    )
                    VALUES
                    (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6
                    )
                    `,
                    [
                        studentId,
                        processed.subject_id,
                        processed.marks,
                        processed.grade,
                        processed.grade_point,
                        processed.is_fourth_subject
                    ]
                );
            }

            // =====================================================
            // COMMIT
            // =====================================================

            await client.query(
                "COMMIT"
            );

            console.log(
                "Individual result saved successfully."
            );

            client.release();
            client = null;

            // =====================================================
            // SUCCESS RESPONSE
            // =====================================================

            return res.json({
                success: true,

                message:
                    "Result saved successfully.",

                student_id:
                    studentId,

                gpa:
                    finalResult.gpa,

                grade:
                    finalResult.grade,

                result:
                    finalResult.status
            });

        } catch (error) {

            console.error(
                "Individual result save error:",
                error
            );

            // =====================================================
            // ROLLBACK
            // =====================================================

            if (client) {

                try {

                    await client.query(
                        "ROLLBACK"
                    );

                } catch (rollbackError) {

                    console.error(
                        "Rollback error:",
                        rollbackError.message
                    );
                }
            }

            // =====================================================
            // RELEASE CONNECTION
            // =====================================================

            if (client) {
                client.release();
                client = null;
            }

            return res.status(500).json({
                success: false,
                message:
                    error.message ||
                    "Failed to save result."
            });
        }
    }
);




// =====================================================
// GET ALL RESULTS WITH SEARCH + FILTER
// =====================================================

app.get(
    "/api/admin/results",
    requireAdmin,
    (req, res) => {

        const search =
            (req.query.search || "").trim();

        const status =
            (req.query.status || "").trim();

        const className =
            (req.query.class_name || "").trim();

        const examName =
            (req.query.exam_name || "").trim();

        const examYear =
            (req.query.exam_year || "").trim();


        let sql = `
            SELECT
                id,
                name,
                roll,
                registration,
                class_name,
                group_name,
                exam_name,
                exam_year,
                final_gpa,
                final_grade,
                result_status,
                status,
                created_at
            FROM students
        `;


        const conditions = [];
        const params = [];


        // -----------------------------------------
        // Search: Name / Roll / Registration
        // -----------------------------------------

        if (search) {

            conditions.push(`
                (
                    name LIKE ?
                    OR roll LIKE ?
                    OR registration LIKE ?
                )
            `);

            const keyword =
                `%${search}%`;

            params.push(
                keyword,
                keyword,
                keyword
            );
        }


        // -----------------------------------------
        // Class Filter
        // -----------------------------------------

        if (className) {

            conditions.push(
                "class_name = ?"
            );

            params.push(className);
        }


        // -----------------------------------------
        // Exam Name Filter
        // -----------------------------------------

        if (examName) {

            conditions.push(
                "exam_name = ?"
            );

            params.push(examName);
        }


        // -----------------------------------------
        // Exam Year Filter
        // -----------------------------------------

        if (examYear) {

            conditions.push(
                "exam_year = ?"
            );

            params.push(Number(examYear));
        }


        // -----------------------------------------
        // Status Filter
        // -----------------------------------------

        if (status) {

            conditions.push(
                "status = ?"
            );

            params.push(status);
        }


        // -----------------------------------------
        // WHERE
        // -----------------------------------------

        if (conditions.length > 0) {

            sql +=
                " WHERE " +
                conditions.join(" AND ");
        }


        sql += `
            ORDER BY id DESC
        `;


        // -----------------------------------------
        // Execute Query
        // -----------------------------------------

        db.all(
            sql,
            params,
            (error, rows) => {

                if (error) {

                    console.error(
                        "Load results error:",
                        error.message
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Could not load results."
                    });
                }


                res.json({
                    success: true,
                    results: rows
                });

            }
        );

    }
);


// =====================================================
// DELETE ALL RESULTS BY CLASS + EXAM + YEAR
// PostgreSQL Version
// IMPORTANT:
// This route must come BEFORE /api/admin/results/:id
// =====================================================

app.delete(
    "/api/admin/results/bulk",
    requireAdmin,

    async (req, res) => {

        let client = null;

        try {

            // =================================================
            // GET DATA FROM REQUEST
            // =================================================

            const {
                class_name,
                exam_name,
                exam_year
            } = req.body;


            // =================================================
            // VALIDATION
            // =================================================

            if (
                !class_name ||
                !exam_name ||
                !exam_year
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Class, Exam Name and Exam Year are required."

                });

            }


            const year =
                Number(exam_year);


            if (
                !Number.isInteger(year)
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid exam year."

                });

            }


            // =================================================
            // GET POSTGRESQL CONNECTION
            // =================================================

            client =
                await db.pool.connect();


            console.log(
                "Bulk delete started..."
            );

            console.log(
                "Class:",
                class_name
            );

            console.log(
                "Exam:",
                exam_name
            );

            console.log(
                "Year:",
                year
            );


            // =================================================
            // FIND STUDENTS
            // =================================================

            const studentResult =
                await client.query(
                    `
                    SELECT id
                    FROM students
                    WHERE
                        class_name = $1
                        AND exam_name = $2
                        AND exam_year = $3
                    `,
                    [
                        class_name,
                        exam_name,
                        year
                    ]
                );


            const students =
                studentResult.rows;


            // =================================================
            // NO RESULTS FOUND
            // =================================================

            if (
                students.length === 0
            ) {

                client.release();

                client = null;


                return res.status(404).json({

                    success: false,

                    message:
                        "No results found for the selected Class, Exam and Year."

                });

            }


            // =================================================
            // START REAL POSTGRESQL TRANSACTION
            // =================================================

            await client.query(
                "BEGIN"
            );


            // =================================================
            // DELETE SUBJECT RESULTS
            // =================================================

            const resultDelete =
                await client.query(
                    `
                    DELETE FROM results
                    WHERE student_id IN (
                        SELECT id
                        FROM students
                        WHERE
                            class_name = $1
                            AND exam_name = $2
                            AND exam_year = $3
                    )
                    `,
                    [
                        class_name,
                        exam_name,
                        year
                    ]
                );


            console.log(
                "Subject results deleted:",
                resultDelete.rowCount
            );


            // =================================================
            // DELETE STUDENTS
            // =================================================

            const studentDelete =
                await client.query(
                    `
                    DELETE FROM students
                    WHERE
                        class_name = $1
                        AND exam_name = $2
                        AND exam_year = $3
                    `,
                    [
                        class_name,
                        exam_name,
                        year
                    ]
                );


            const deletedCount =
                studentDelete.rowCount;


            console.log(
                "Students deleted:",
                deletedCount
            );


            // =================================================
            // COMMIT
            // =================================================

            await client.query(
                "COMMIT"
            );


            console.log(
                "Bulk delete completed successfully."
            );


            // =================================================
            // RELEASE CONNECTION
            // =================================================

            client.release();

            client = null;


            // =================================================
            // SUCCESS RESPONSE
            // =================================================

            return res.json({

                success: true,

                message:
                    "All selected results deleted successfully.",

                deleted_count:
                    deletedCount

            });


        } catch (error) {

            console.error(
                "Bulk delete error:",
                error
            );


            // =================================================
            // ROLLBACK
            // =================================================

            if (client) {

                try {

                    await client.query(
                        "ROLLBACK"
                    );

                } catch (rollbackError) {

                    console.error(
                        "Rollback error:",
                        rollbackError.message
                    );

                }

            }


            // =================================================
            // RELEASE CONNECTION
            // =================================================

            if (client) {

                client.release();

                client = null;

            }


            // =================================================
            // ERROR RESPONSE
            // =================================================

            return res.status(500).json({

                success: false,

                message:
                    error.message ||
                    "Could not complete bulk delete."

            });

        }

    }
);


// =====================================================
// DELETE SINGLE RESULT
// =====================================================

app.delete(
    "/api/admin/results/:id",
    requireAdmin,
    (req, res) => {

        const studentId =
            Number(req.params.id);

        if (!studentId) {

            return res.status(400).json({
                success: false,
                message:
                    "Invalid result ID."
            });
        }

        db.run(
            `
            DELETE FROM results
            WHERE student_id = ?
            `,
            [studentId],
            resultError => {

                if (resultError) {

                    return res.status(500).json({
                        success: false,
                        message:
                            "Could not delete subject results."
                    });
                }

                db.run(
                    `
                    DELETE FROM students
                    WHERE id = ?
                    `,
                    [studentId],
                    function(studentError) {

                        if (studentError) {

                            return res.status(500).json({
                                success: false,
                                message:
                                    "Could not delete result."
                            });
                        }

                        if (this.changes === 0) {

                            return res.status(404).json({
                                success: false,
                                message:
                                    "Result not found."
                            });
                        }

                        return res.json({
                            success: true,
                            message:
                                "Result deleted successfully."
                        });
                    }
                );
            }
        );
    }
);


// =====================================================
// GET SINGLE RESULT FOR EDIT
// =====================================================

app.get(
    "/api/admin/results/:id",
    requireAdmin,
    (req, res) => {

        const studentId =
            Number(req.params.id);


        if (!studentId) {

            return res.status(400).json({
                success: false,
                message:
                    "Invalid result ID."
            });

        }


        db.get(
            `
            SELECT
                id,
                name,
                roll,
                registration,
                class_name,
                group_name,
                exam_name,
                exam_year,
                institute_name,
                eiin,
                status,
                final_gpa,
                final_grade,
                result_status
            FROM students
            WHERE id = ?
            `,
            [studentId],

            (studentError, student) => {

                if (studentError) {

                    console.error(
                        "Get student error:",
                        studentError.message
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Could not load student."
                    });

                }


                if (!student) {

                    return res.status(404).json({
                        success: false,
                        message:
                            "Result not found."
                    });

                }


                db.all(
                    `
                    SELECT
                        results.id,
                        results.subject_id,
                        results.marks,
                        results.grade,
                        results.grade_point,
                        results.is_fourth_subject,

                        subjects.subject_name,
                        subjects.subject_code,
                        subjects.full_marks,
                        subjects.subject_type

                    FROM results

                    INNER JOIN subjects
                        ON subjects.id =
                           results.subject_id

                    WHERE results.student_id = ?

                    ORDER BY subjects.id
                    `,
                    [studentId],

                    (resultError, results) => {

                        if (resultError) {

                            return res.status(500).json({
                                success: false,
                                message:
                                    "Could not load subject results."
                            });

                        }


                        res.json({
                            success: true,
                            student: student,
                            results: results
                        });

                    }
                );

            }
        );

    }
);


// =====================================================
// UPDATE INDIVIDUAL RESULT
// PostgreSQL Safe Transaction Version
// =====================================================

app.put(
    "/api/admin/results/:id",
    requireAdmin,
    async (req, res) => {

        let client = null;

        try {

            const studentId =
                Number(req.params.id);

            const {
                student,
                results
            } = req.body;

            // -----------------------------------------
            // BASIC VALIDATION
            // -----------------------------------------

            if (
                !studentId ||
                !student ||
                !student.name ||
                !student.roll ||
                !Array.isArray(results) ||
                results.length === 0
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Complete student and result data are required."
                });
            }


            // -----------------------------------------
            // CHECK STUDENT
            // -----------------------------------------

            const studentCheck =
                await db.pool.query(
                    `
                    SELECT *
                    FROM students
                    WHERE id = $1
                    `,
                    [studentId]
                );

            if (
                studentCheck.rows.length === 0
            ) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Student result not found."
                });
            }


            // -----------------------------------------
            // GET SUBJECT INFORMATION
            // -----------------------------------------

            const subjectResult =
                await db.pool.query(
                    `
                    SELECT *
                    FROM subjects
                    `,
                    []
                );

            const subjects =
                subjectResult.rows;


            if (
                !subjects ||
                subjects.length === 0
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "No subjects found."
                });
            }


            // -----------------------------------------
            // PROCESS RESULTS
            // -----------------------------------------

            const processedResults = [];

            for (
                const result
                of results
            ) {

                const subject =
                    subjects.find(
                        item =>
                            Number(item.id) ===
                            Number(result.subject_id)
                    );


                if (!subject) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Invalid subject found."
                    });
                }


                const fullMarks =
                    Number(subject.full_marks);

                const marks =
                    Number(result.marks);


                // -----------------------------------------
                // VALIDATE MARKS
                // -----------------------------------------

                if (
                    !Number.isFinite(marks) ||
                    marks < 0 ||
                    marks > fullMarks
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            `Invalid marks for ${subject.subject_name}.`
                    });
                }


                // -----------------------------------------
                // CALCULATE GRADE
                // -----------------------------------------

                const gradeInfo =
                    getGrade(
                        marks,
                        fullMarks
                    );


                processedResults.push({

                    subject_id:
                        Number(subject.id),

                    marks:
                        marks,

                    full_marks:
                        fullMarks,

                    grade:
                        gradeInfo.grade,

                    grade_point:
                        gradeInfo.point,

                    is_fourth_subject:
                        String(
                            subject.subject_type || ""
                        ).toLowerCase() === "fourth"
                            ? 1
                            : 0
                });
            }


            // -----------------------------------------
            // CALCULATE FINAL GPA
            // -----------------------------------------

            const finalResult =
                calculateFinalGPA(
                    processedResults
                );


            console.log(
                "Updated Final Result:",
                finalResult
            );


            // -----------------------------------------
            // START POSTGRESQL TRANSACTION
            // -----------------------------------------

            client =
                await db.pool.connect();

            await client.query(
                "BEGIN"
            );


            // -----------------------------------------
            // UPDATE STUDENT INFORMATION
            // -----------------------------------------

            await client.query(
                `
                UPDATE students

                SET
                    name = $1,
                    roll = $2,
                    registration = $3,
                    class_name = $4,
                    group_name = $5,
                    exam_name = $6,
                    exam_year = $7,
                    final_gpa = $8,
                    final_grade = $9,
                    result_status = $10

                WHERE id = $11
                `,
                [

                    student.name,

                    student.roll,

                    student.registration || "",

                    student.class_name || "",

                    student.group_name || "",

                    student.exam_name || "",

                    Number(student.exam_year),

                    finalResult.gpa,

                    finalResult.grade,

                    finalResult.status,

                    studentId

                ]
            );


            // -----------------------------------------
            // DELETE OLD SUBJECT RESULTS
            // -----------------------------------------

            await client.query(
                `
                DELETE FROM results
                WHERE student_id = $1
                `,
                [studentId]
            );


            // -----------------------------------------
            // INSERT UPDATED SUBJECT RESULTS
            // -----------------------------------------

            for (
                const result
                of processedResults
            ) {

                await client.query(
                    `
                    INSERT INTO results
                    (
                        student_id,
                        subject_id,
                        marks,
                        grade,
                        grade_point,
                        is_fourth_subject
                    )

                    VALUES
                    (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6
                    )
                    `,
                    [

                        studentId,

                        result.subject_id,

                        result.marks,

                        result.grade,

                        result.grade_point,

                        result.is_fourth_subject

                    ]
                );
            }


            // -----------------------------------------
            // COMMIT
            // -----------------------------------------

            await client.query(
                "COMMIT"
            );


            console.log(
                "Individual result updated successfully."
            );


            client.release();
            client = null;


            // -----------------------------------------
            // SUCCESS RESPONSE
            // -----------------------------------------

            return res.json({

                success: true,

                message:
                    "Result updated successfully.",

                final_gpa:
                    finalResult.gpa,

                final_grade:
                    finalResult.grade,

                result_status:
                    finalResult.status

            });


        } catch (error) {

            console.error(
                "Individual result update error:",
                error
            );


            // -----------------------------------------
            // ROLLBACK
            // -----------------------------------------

            if (client) {

                try {

                    await client.query(
                        "ROLLBACK"
                    );

                } catch (rollbackError) {

                    console.error(
                        "Rollback error:",
                        rollbackError.message
                    );
                }
            }


            if (client) {

                client.release();

                client = null;
            }


            return res.status(500).json({

                success: false,

                message:
                    error.message ||
                    "Failed to update result."

            });
        }
    }
);


// =====================================================
// UNPUBLISH RESULT
// =====================================================

app.put(
    "/api/admin/results/:id/unpublish",
    requireAdmin,
    (req, res) => {

        const studentId =
            Number(req.params.id);


        if (!studentId) {

            return res.status(400).json({
                success: false,
                message:
                    "Invalid result ID."
            });

        }


        db.run(
            `
            UPDATE students
            SET status = 'draft'
            WHERE id = ?
            `,
            [studentId],

            function(error) {

                if (error) {

                    return res.status(500).json({
                        success: false,
                        message:
                            "Could not unpublish result."
                    });

                }


                if (
                    this.changes === 0
                ) {

                    return res.status(404).json({
                        success: false,
                        message:
                            "Result not found."
                    });

                }


                res.json({
                    success: true,
                    message:
                        "Result moved to draft."
                });

            }
        );

    }
);


// =====================================================
// EXCEL BULK PREVIEW
// =====================================================

app.post(
    "/api/admin/bulk-preview",
    requireAdmin,
    upload.single("excelFile"),

    async (req, res) => {

        try {

            if (!req.file) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please select an Excel file."
                });

            }

            


            // IMPORTANT:
            // Workbook must be created BEFORE using it.

            const workbook =
                XLSX.read(
                    req.file.buffer,
                    {
                        type: "buffer"
                    }
                );


            const sheetName =
                workbook.SheetNames[0];


            if (!sheetName) {

                return res.status(400).json({
                    success: false,
                    message:
                        "No worksheet found in Excel file."
                });

            }


            const worksheet =
                workbook.Sheets[
                    sheetName
                ];


            const rows =
                XLSX.utils.sheet_to_json(
                    worksheet,
                    {
                        defval: ""
                    }
                );


            if (
                !rows ||
                rows.length === 0
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Excel file is empty."
                });

            }


            console.log(
                "Excel Columns:",
                Object.keys(rows[0])
            );


            const columns =
                Object.keys(rows[0]);


            const hasName =
                columns.some(
                    column =>
                        column
                            .toString()
                            .trim()
                            .toLowerCase() ===
                        "name"
                );


            const hasRoll =
                columns.some(
                    column =>
                        column
                            .toString()
                            .trim()
                            .toLowerCase() ===
                        "roll"
                );


            if (
                !hasName ||
                !hasRoll
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Excel must contain Name and Roll columns."
                });

            }


            res.json({
                success: true,

                total_rows:
                    rows.length,

                columns:
                    columns,

                rows:
                    rows

            });

        } catch (error) {

            console.error(
                "Excel preview error:",
                error
            );


            res.status(500).json({
                success: false,
                message:
                    "Could not read Excel file."
            });

        }

    }
);


// =====================================================
// EXCEL BULK IMPORT
// =====================================================

app.post(
    "/api/admin/bulk-import",
    requireAdmin,
    upload.single("excelFile"),

    (req, res) => {

        try {

            console.log(
                "Bulk import started..."
            );


            if (!req.file) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please select an Excel file."
                });

            }


            const examId =
                Number(
                    req.body.exam_id
                );


            if (!examId) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please select an exam."
                });

            }


            console.log(
                "Exam ID:",
                examId
            );


            const workbook =
                XLSX.read(
                    req.file.buffer,
                    {
                        type: "buffer"
                    }
                );


            const sheetName =
                workbook.SheetNames[0];


            if (!sheetName) {

                return res.status(400).json({
                    success: false,
                    message:
                        "No worksheet found."
                });

            }


            const worksheet =
                workbook.Sheets[
                    sheetName
                ];


            const rows =
                XLSX.utils.sheet_to_json(
                    worksheet,
                    {
                        defval: ""
                    }
                );


            console.log(
                "Excel rows:",
                rows.length
            );


            if (!rows.length) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Excel file is empty."
                });

            }


            db.get(
                `
                SELECT *
                FROM exams
                WHERE id = ?
                `,
                [examId],

                (examError, exam) => {

                    if (examError) {

                        console.error(
                            examError
                        );

                        return res.status(500).json({
                            success: false,
                            message:
                                "Could not load exam."
                        });

                    }


                    if (!exam) {

                        return res.status(404).json({
                            success: false,
                            message:
                                "Exam not found."
                        });

                    }


                    importBulkRows(
                        rows,
                        exam,
                        res
                    );

                }
            );

        } catch (error) {

            console.error(
                "Bulk import error:",
                error
            );


            res.status(500).json({
                success: false,
                message:
                    error.message ||
                    "Bulk import failed."
            });

        }

    }
);


// ========================================
// BULK IMPORT PROCESS
// ========================================

async function importBulkRows(rows, exam, res) {

    let client = null;
    let transactionStarted = false;

    try {

        // =====================================================
        // LOAD SUBJECTS FOR SELECTED CLASS
        // =====================================================

        const subjects = await new Promise((resolve, reject) => {

            db.all(
                `
                SELECT *
                FROM subjects
                WHERE class_name = ?
                ORDER BY id ASC
                `,
                [exam.class_name],

                (error, result) => {

                    if (error) {
                        reject(error);
                    } else {
                        resolve(result || []);
                    }

                }
            );

        });


        if (!subjects.length) {

            return res.status(400).json({
                success: false,
                message:
                    `No subjects found for class ${exam.class_name}.`
            });

        }


        console.log(
            `Subjects loaded for class ${exam.class_name}:`,
            subjects.length
        );


        // =====================================================
        // NORMALIZE EXCEL COLUMN NAMES
        // =====================================================

        function normalizeKey(value) {

            return String(value || "")
                .trim()
                .toLowerCase()
                .replace(/\s+/g, "")
                .replace(/_/g, "")
                .replace(/-/g, "");

        }


        // =====================================================
        // FIND EXCEL VALUE
        // =====================================================

        function getExcelValue(row, possibleKeys) {

            const rowKeys = Object.keys(row);

            for (const key of possibleKeys) {

                const normalizedWanted =
                    normalizeKey(key);

                const foundKey =
                    rowKeys.find(
                        excelKey =>
                            normalizeKey(excelKey) ===
                            normalizedWanted
                    );

                if (
                    foundKey !== undefined &&
                    row[foundKey] !== undefined &&
                    row[foundKey] !== ""
                ) {

                    return row[foundKey];

                }

            }

            return "";

        }


        // =====================================================
        // REQUIRED COLUMN CHECK
        // =====================================================

        const firstRow = rows[0];

        const nameValue =
            getExcelValue(
                firstRow,
                [
                    "Name",
                    "Student Name",
                    "StudentName",
                    "নাম"
                ]
            );

        const rollValue =
            getExcelValue(
                firstRow,
                [
                    "Roll",
                    "Roll No",
                    "Roll Number",
                    "রোল"
                ]
            );


        if (
            nameValue === "" &&
            rollValue === ""
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Excel file must contain Name and Roll columns."
            });

        }


        // =====================================================
        // GET DATABASE CONNECTION
        // =====================================================

        client = await db.pool.connect();

        await client.query("BEGIN");

        transactionStarted = true;


        console.log(
            "PostgreSQL bulk transaction started."
        );


        // =====================================================
        // COUNTERS
        // =====================================================

        let processed = 0;
        let failed = 0;

        const errors = [];


        // =====================================================
        // PROCESS EACH EXCEL ROW
        // =====================================================

        for (
            let rowIndex = 0;
            rowIndex < rows.length;
            rowIndex++
        ) {

            const row = rows[rowIndex];

            // PostgreSQL SAVEPOINT
            // একটি row error হলে পুরো transaction নষ্ট হবে না

            const savepoint =
                `bulk_row_${rowIndex + 1}`;


            try {

                await client.query(
                    `SAVEPOINT ${savepoint}`
                );


                // =================================================
                // STUDENT INFORMATION
                // =================================================

                const name =
                    String(
                        getExcelValue(
                            row,
                            [
                                "Name",
                                "Student Name",
                                "StudentName",
                                "নাম"
                            ]
                        ) || ""
                    ).trim();


                const roll =
                    String(
                        getExcelValue(
                            row,
                            [
                                "Roll",
                                "Roll No",
                                "Roll Number",
                                "রোল"
                            ]
                        ) || ""
                    ).trim();


                const registration =
                    String(
                        getExcelValue(
                            row,
                            [
                                "Registration",
                                "Reg",
                                "Registration No",
                                "Registration Number",
                                "রেজিস্ট্রেশন"
                            ]
                        ) || ""
                    ).trim();


                const groupName =
                    String(
                        getExcelValue(
                            row,
                            [
                                "Group",
                                "Group Name",
                                "গ্রুপ"
                            ]
                        ) || ""
                    ).trim();


                // =============================================
                // VALIDATE NAME
                // =============================================

                if (!name) {

                    throw new Error(
                        "Student name is missing."
                    );

                }


                // =============================================
                // VALIDATE ROLL
                // =============================================

                if (!roll) {

                    throw new Error(
                        "Roll is missing."
                    );

                }


                // =================================================
                // SUBJECT RESULTS
                // =================================================

                const subjectResults = [];


                for (
                    const subject of subjects
                ) {

                    // ---------------------------------------------
                    // SUBJECT NAME / CODE
                    // ---------------------------------------------

                    const subjectName =
                        String(
                            subject.subject_name || ""
                        ).trim();


                    const subjectCode =
                        String(
                            subject.subject_code || ""
                        ).trim();


                    // ---------------------------------------------
                    // POSSIBLE EXCEL COLUMN NAMES
                    // ---------------------------------------------

                    const possibleSubjectKeys = [

                        subjectName,

                        subjectCode,

                        `${subjectCode}`,

                        `${subjectName} (${subjectCode})`,

                        `${subjectCode} (${subjectName})`

                    ];


                    // ---------------------------------------------
                    // FIND MARKS FROM EXCEL
                    // ---------------------------------------------

                    const rawMarks =
                        getExcelValue(
                            row,
                            possibleSubjectKeys
                        );


                    // ---------------------------------------------
                    // MISSING MARKS
                    // ---------------------------------------------

                    if (
                        rawMarks === "" ||
                        rawMarks === null ||
                        rawMarks === undefined
                    ) {

                        throw new Error(
                            `${subjectName} marks are missing.`
                        );

                    }


                    const marks =
                        Number(rawMarks);


                    // ---------------------------------------------
                    // INVALID MARKS
                    // ---------------------------------------------

                    if (
                        Number.isNaN(marks)
                    ) {

                        throw new Error(
                            `${subjectName} marks are not a valid number.`
                        );

                    }


                    // ---------------------------------------------
                    // FULL MARKS
                    // ---------------------------------------------

                    const fullMarks =
                        Number(
                            subject.full_marks
                        );


                    if (
                        !fullMarks ||
                        fullMarks <= 0
                    ) {

                        throw new Error(
                            `Invalid full marks for ${subjectName}.`
                        );

                    }


                    // ---------------------------------------------
                    // MARKS RANGE
                    // ---------------------------------------------

                    if (
                        marks < 0 ||
                        marks > fullMarks
                    ) {

                        throw new Error(
                            `${subjectName} marks must be between 0 and ${fullMarks}.`
                        );

                    }


                    // ---------------------------------------------
                    // GRADE
                    // ---------------------------------------------

                    const gradeResult =
                        getGrade(
                            marks,
                            fullMarks
                        );


                    // ---------------------------------------------
                    // FOURTH SUBJECT
                    // ---------------------------------------------

                    const isFourthSubject =
                        String(
                            subject.subject_type || ""
                        ).toLowerCase() ===
                        "fourth";


                    // ---------------------------------------------
                    // SAVE SUBJECT RESULT
                    // ---------------------------------------------

                    subjectResults.push({

                        subject_id:
                            subject.id,

                        marks:
                            marks,

                        full_marks:
                            fullMarks,

                        grade:
                            gradeResult.grade,

                        grade_point:
                            gradeResult.point,

                        is_fourth_subject:
                            isFourthSubject ? 1 : 0

                    });

                }


                // =================================================
                // CALCULATE FINAL GPA
                // =================================================

                const finalResult =
                    calculateFinalGPA(
                        subjectResults
                    );


                console.log(
                    `Row ${rowIndex + 2}: ${name} | Roll ${roll} | GPA ${finalResult.gpa}`
                );


                // =================================================
                // INSERT STUDENT
                // =================================================

                const studentInsert =
                    await client.query(
                        `
                        INSERT INTO students
                        (
                            name,
                            roll,
                            registration,
                            class_name,
                            group_name,
                            exam_name,
                            exam_year,
                            final_gpa,
                            final_grade,
                            result_status,
                            status
                        )
                        VALUES
                        (
                            $1,
                            $2,
                            $3,
                            $4,
                            $5,
                            $6,
                            $7,
                            $8,
                            $9,
                            $10,
                            'published'
                        )
                        RETURNING id
                        `,
                        [
                            name,
                            roll,
                            registration,
                            exam.class_name,
                            groupName,
                            exam.exam_name,
                            exam.exam_year,
                            finalResult.gpa,
                            finalResult.grade,
                            finalResult.status
                        ]
                    );


                const studentId =
                    studentInsert.rows[0].id;


                // =================================================
                // INSERT SUBJECT RESULTS
                // =================================================

                for (
                    const result of subjectResults
                ) {

                    await client.query(
                        `
                        INSERT INTO results
                        (
                            student_id,
                            subject_id,
                            marks,
                            grade,
                            grade_point,
                            is_fourth_subject
                        )
                        VALUES
                        (
                            $1,
                            $2,
                            $3,
                            $4,
                            $5,
                            $6
                        )
                        `,
                        [
                            studentId,
                            result.subject_id,
                            result.marks,
                            result.grade,
                            result.grade_point,
                            result.is_fourth_subject
                        ]
                    );

                }


                // =================================================
                // UPDATE FINAL GPA
                // =================================================

                await client.query(
                    `
                    UPDATE students
                    SET
                        final_gpa = $1,
                        final_grade = $2,
                        result_status = $3
                    WHERE id = $4
                    `,
                    [
                        finalResult.gpa,
                        finalResult.grade,
                        finalResult.status,
                        studentId
                    ]
                );


                // =================================================
                // RELEASE SAVEPOINT
                // =================================================

                await client.query(
                    `RELEASE SAVEPOINT ${savepoint}`
                );


                processed++;


            } catch (rowError) {

                console.error(
                    `Bulk row ${rowIndex + 2} error:`,
                    rowError.message
                );


                // =============================================
                // ROLLBACK ONLY THIS ROW
                // =============================================

                try {

                    await client.query(
                        `ROLLBACK TO SAVEPOINT ${savepoint}`
                    );

                    await client.query(
                        `RELEASE SAVEPOINT ${savepoint}`
                    );

                } catch (savepointError) {

                    console.error(
                        "Savepoint rollback error:",
                        savepointError.message
                    );

                }


                failed++;


                errors.push({

                    row:
                        rowIndex + 2,

                    name:
                        String(
                            getExcelValue(
                                row,
                                [
                                    "Name",
                                    "Student Name",
                                    "StudentName",
                                    "নাম"
                                ]
                            ) || ""
                        ),

                    roll:
                        String(
                            getExcelValue(
                                row,
                                [
                                    "Roll",
                                    "Roll No",
                                    "Roll Number",
                                    "রোল"
                                ]
                            ) || ""
                        ),

                    error:
                        rowError.message

                });

            }

        }


        // =====================================================
        // COMMIT
        // =====================================================

        await client.query("COMMIT");

        transactionStarted = false;


        console.log(
            "PostgreSQL bulk transaction committed."
        );


        // =====================================================
        // RELEASE CONNECTION
        // =====================================================

        client.release();

        client = null;


        // =====================================================
        // RESPONSE
        // =====================================================

        return res.json({

            success: true,

            message:
                "Bulk import completed successfully.",

            total:
                rows.length,

            processed:
                processed,

            failed:
                failed,

            errors:
                errors

        });


    } catch (error) {

        console.error(
            "Bulk import PostgreSQL error:",
            error
        );


        // =====================================================
        // ROLLBACK
        // =====================================================

        if (
            client &&
            transactionStarted
        ) {

            try {

                await client.query(
                    "ROLLBACK"
                );

            } catch (rollbackError) {

                console.error(
                    "Rollback error:",
                    rollbackError.message
                );

            }

        }


        // =====================================================
        // RELEASE CONNECTION
        // =====================================================

        if (client) {

            client.release();

            client = null;

        }


        // =====================================================
        // SEND ERROR
        // =====================================================

        return res.status(500).json({

            success: false,

            message:
                error.message ||
                "Bulk import failed."

        });

    }

}

// =====================================================
// DASHBOARD STATISTICS
// =====================================================

app.get(
    "/api/admin/dashboard-stats",
    requireAdmin,
    (req, res) => {

        db.get(
            `
            SELECT COUNT(*) AS "totalStudents"
            FROM students
            `,
            [],

            (err1, studentData) => {

                if (err1) {

                    console.error(
                        "Dashboard Students Error:",
                        err1
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Could not load students."
                    });

                }


                db.get(
                    `
                    SELECT COUNT(DISTINCT student_id)
                    AS "totalResults"
                    FROM results
                    `,
                    [],

                    (err2, resultData) => {

                        if (err2) {

                            console.error(
                                "Dashboard Results Error:",
                                err2
                            );

                            return res.status(500).json({
                                success: false,
                                message:
                                    "Could not load results."
                            });

                        }


                        db.get(
                            `
                            SELECT COUNT(*)
                            AS "publishedResults"
                            FROM students
                            WHERE status = 'published'
                            `,
                            [],

                            (err3, publishedData) => {

                                if (err3) {

                                    console.error(
                                        "Dashboard Published Error:",
                                        err3
                                    );

                                    return res.status(500).json({
                                        success: false,
                                        message:
                                            "Could not load published results."
                                    });

                                }


                                db.get(
                                    `
                                    SELECT COUNT(*)
                                    AS "draftResults"
                                    FROM students
                                    WHERE status = 'draft'
                                    `,
                                    [],

                                    (err4, draftData) => {

                                        if (err4) {

                                            console.error(
                                                "Dashboard Draft Error:",
                                                err4
                                            );

                                            return res.status(500).json({
                                                success: false,
                                                message:
                                                    "Could not load draft results."
                                            });

                                        }


                                        res.json({

                                            success: true,

                                            totalStudents:
                                                Number(
                                                    studentData.totalStudents
                                                ),

                                            totalResults:
                                                Number(
                                                    resultData.totalResults
                                                ),

                                            publishedResults:
                                                Number(
                                                    publishedData.publishedResults
                                                ),

                                            draftResults:
                                                Number(
                                                    draftData.draftResults
                                                )

                                        });

                                    }
                                );

                            }
                        );

                    }
                );

            }
        );

    }
);


// =====================================================
// PUBLIC RESULT OPTIONS
// =====================================================

app.get(
    "/api/result/options",
    (req, res) => {

        db.all(
            `
            SELECT
                class_name,
                exam_name,
                exam_year

            FROM students

            GROUP BY
                class_name,
                exam_name,
                exam_year

            ORDER BY
                class_name ASC,
                exam_year DESC
            `,
            [],

            (err, rows) => {

                if (err) {

                    return res.status(500).json({
                        success: false,
                        message:
                            "Could not load result options."
                    });

                }


                res.json({
                    success: true,
                    options: rows
                });

            }
        );

    }
);


// =====================================================
// CALCULATE POSITION
// =====================================================

function calculatePosition(
    studentId,
    className,
    examName,
    examYear,
    callback
) {

    const query = `
        SELECT
            s.id,
            s.class_name,
            s.exam_name,
            s.exam_year,

            SUM(
                CASE

                    WHEN
                        s.class_name IN ('Nine', 'Ten', '9', '10')
                        AND COALESCE(
                            r.is_fourth_subject,
                            0
                        ) = 1

                    THEN
                        CASE

                            WHEN
                                COALESCE(
                                    r.marks,
                                    0
                                ) > 40

                            THEN
                                COALESCE(
                                    r.marks,
                                    0
                                ) - 40

                            ELSE 0

                        END

                    ELSE
                        COALESCE(
                            r.marks,
                            0
                        )

                END
            ) AS obtained_marks

        FROM students s

        INNER JOIN results r
            ON r.student_id = s.id

        WHERE
            s.class_name = ?
            AND s.exam_name = ?
            AND s.exam_year = ?

        GROUP BY
            s.id

        ORDER BY
            obtained_marks DESC,
            s.id ASC
    `;


    db.all(
        query,
        [
            className,
            examName,
            examYear
        ],

        (err, students) => {

            if (err) {

                console.error(
                    "Position calculation error:",
                    err.message
                );

                return callback(err);

            }


            if (
                !students ||
                students.length === 0
            ) {

                return callback(
                    null,
                    null
                );

            }


            let position = 0;

            let previousMarks = null;


            students.forEach(
                (student, index) => {

                    const marks =
                        Number(
                            student.obtained_marks || 0
                        );


                    if (
                        previousMarks === null
                    ) {
                        position = 1;
                    } else if (
                        marks !== previousMarks
                    ) {
                        position++;
                    }


                    student.position =
                        position;


                    previousMarks =
                        marks;

                }
            );


            const currentStudent =
                students.find(
                    student =>
                        String(student.id) ===
                        String(studentId)
                );


            callback(
                null,
                currentStudent
                    ? currentStudent.position
                    : null
            );

        }
    );

}


// =====================================================
// PUBLIC RESULT SEARCH
// =====================================================

app.get(
    "/api/result/search",
    (req, res) => {

        const roll =
            String(
                req.query.roll || ""
            ).trim();


        const className =
            String(
                req.query.class_name || ""
            ).trim();


        const examName =
            String(
                req.query.exam_name || ""
            ).trim();


        const examYear =
            String(
                req.query.exam_year || ""
            ).trim();


        if (
            !roll ||
            !className ||
            !examName ||
            !examYear
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Roll, Class, Exam Name and Exam Year are required."
            });

        }


        db.get(
            `
            SELECT *
            FROM students

            WHERE
                roll = ?
                AND class_name = ?
                AND exam_name = ?
                AND exam_year = ?

            LIMIT 1
            `,
            [
                roll,
                className,
                examName,
                examYear
            ],

            (studentError, student) => {

                if (studentError) {

                    return res.status(500).json({
                        success: false,
                        message:
                            "Server error."
                    });

                }


                if (!student) {

                    return res.status(404).json({
                        success: false,
                        message:
                            "Result not found or result has not been published."
                    });

                }


                if (
                    student.status &&
                    student.status !== "published"
                ) {

                    return res.status(404).json({
                        success: false,
                        message:
                            "Result not found or result has not been published."
                    });

                }


                db.all(
                    `
                    SELECT

                        results.id,

                        results.marks,

                        results.grade,

                        results.grade_point,

                        results.is_fourth_subject,

                        subjects.subject_name,

                        subjects.subject_code,

                        subjects.full_marks,

                        subjects.subject_type

                    FROM results

                    INNER JOIN subjects
                        ON results.subject_id =
                           subjects.id

                    WHERE
                        results.student_id = ?

                    ORDER BY
                        subjects.id ASC
                    `,
                    [student.id],

                    (resultError, resultRows) => {

                        if (resultError) {

                            return res.status(500).json({
                                success: false,
                                message:
                                    "Could not load subject results."
                            });

                        }


                        let totalMarks = 0;

                        let totalFullMarks = 0;


                        resultRows.forEach(
                            result => {

                                totalMarks +=
                                    Number(
                                        result.marks || 0
                                    );


                                totalFullMarks +=
                                    Number(
                                        result.full_marks || 0
                                    );

                            }
                        );


                        // ==========================================
                        // FINAL GPA
                        // ==========================================

                        const finalResult =
                            calculateFinalGPA(
                                resultRows
                            );


                        calculatePosition(
                            student.id,
                            student.class_name,
                            student.exam_name,
                            student.exam_year,

                            (positionError, position) => {

                                if (positionError) {

                                    return res.status(500).json({
                                        success: false,
                                        message:
                                            "Could not calculate position."
                                    });

                                }


                                res.json({

                                    success: true,

                                    student: {

                                        id:
                                            student.id,

                                        name:
                                            student.name,

                                        roll:
                                            student.roll,

                                        registration:
                                            student.registration,

                                        class_name:
                                            student.class_name,

                                        group_name:
                                            student.group_name,

                                        exam_name:
                                            student.exam_name,

                                        exam_year:
                                            student.exam_year,

                                        institute_name:
                                            student.institute_name,

                                        eiin:
                                            student.eiin

                                    },


                                    subjects:
                                        resultRows,


                                    summary: {

                                        total_marks:
                                            totalMarks,

                                        total_full_marks:
                                            totalFullMarks,

                                        gpa:
                                            finalResult.gpa,

                                        result:
                                            finalResult.status,

                                        position:
                                            position || "-"

                                    }

                                });

                            }
                        );

                    }
                );

            }
        );

    }
);

// =====================================================
// MARKSHEET MANAGEMENT APIs
// =====================================================


// ========================================
// GET ALL CLASSES FOR MARKSHEET MANAGEMENT
// ========================================

app.get(
    "/api/admin/marksheet/classes",
    requireAdmin,
    (req, res) => {

        db.all(
            `
            SELECT DISTINCT class_name
            FROM students
            WHERE class_name IS NOT NULL
            AND TRIM(class_name) <> ''
            ORDER BY class_name ASC
            `,
            [],
            (err, rows) => {

                if (err) {

                    console.error(
                        "Load marksheet classes error:",
                        err.message
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Class list could not be loaded."
                    });

                }


                const classes =
                    rows.map(
                        row => row.class_name
                    );


                res.json({
                    success: true,
                    classes: classes
                });

            }
        );

    }
);



// ========================================
// GET ALL EXAM YEARS
// ========================================

app.get(
    "/api/admin/marksheet/years",
    requireAdmin,
    (req, res) => {

        db.all(
            `
            SELECT DISTINCT exam_year
            FROM students
            WHERE exam_year IS NOT NULL
            ORDER BY exam_year DESC
            `,
            [],
            (err, rows) => {

                if (err) {

                    console.error(
                        "Load marksheet years error:",
                        err.message
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Exam year list could not be loaded."
                    });

                }


                const years =
                    rows.map(
                        row => row.exam_year
                    );


                res.json({
                    success: true,
                    years: years
                });

            }
        );

    }
);



// ========================================
// GET STUDENTS FOR SELECTED MARKSHEET
// ========================================

app.get(
    "/api/admin/marksheets",
    requireAdmin,
    (req, res) => {

        const {
            class_name,
            exam_year,
            exam_name
        } = req.query;


        // ========================================
        // VALIDATION
        // ========================================

        if (
            !class_name ||
            !exam_year ||
            !exam_name
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Class, Exam Year and Exam Name are required."
            });

        }


        // ========================================
        // GET STUDENTS
        // ========================================

        db.all(
            `
            SELECT
                id,
                name,
                roll,
                registration,
                class_name,
                group_name,
                exam_name,
                exam_year,
                institute_name,
                eiin,
                status
            FROM students
            WHERE
                class_name = ?
                AND exam_year = ?
                AND exam_name = ?
            ORDER BY
                CAST(roll AS INTEGER) ASC,
                roll ASC,
                id ASC
            `,
            [
                class_name,
                Number(exam_year),
                exam_name
            ],
            (err, rows) => {

                if (err) {

                    console.error(
                        "Load marksheets error:",
                        err.message
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Marksheets could not be loaded."
                    });

                }


                res.json({

                    success: true,

                    students:
                        rows || []

                });

            }
        );

    }
);


// =====================================================
// START SERVER
// =====================================================

app.listen(
    PORT,
    () => {

        console.log("");

        console.log(
            "================================="
        );

        console.log(
            " School Result Management System "
        );

        console.log(
            "================================="
        );

        console.log(
            `Server running at: http://localhost:${PORT}`
        );

        console.log("");

    }
);