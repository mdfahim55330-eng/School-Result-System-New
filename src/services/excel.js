"use strict";

const ExcelJS = require("exceljs");
const { httpError } = require("../utils");
const { gradeSubjects } = require("./grading");

const BN_DIGITS = { "০": "0", "১": "1", "২": "2", "৩": "3", "৪": "4", "৫": "5", "৬": "6", "৭": "7", "৮": "8", "৯": "9" };

function bnToAsciiDigits(text) {
    return String(text).replace(/[০-৯]/g, (d) => BN_DIGITS[d]);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function cellToValue(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "number") return value;
    if (typeof value === "string") return value.trim();
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === "object") {
        if (value.richText) return value.richText.map((p) => p.text).join("").trim();
        if (Object.prototype.hasOwnProperty.call(value, "result")) return cellToValue(value.result);
        if (value.text !== undefined) return cellToValue(value.text);
        if (value.error) return "";
    }
    return String(value).trim();
}

function normalizeKey(value) {
    return String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/_/g, "")
        .replace(/-/g, "");
}

/**
 * Reads the first worksheet of an .xlsx file.
 * Returns { columns: [header text...], rows: [{ __row: <excel row number>, <header>: value, ... }] }
 */
async function readSheet(buffer, { maxRows = 3000 } = {}) {
    if (!buffer || buffer.length < 4) throw httpError(400, "The uploaded file is empty.");

    const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
    const isOldXls = buffer[0] === 0xd0 && buffer[1] === 0xcf;
    if (isOldXls) {
        throw httpError(400, "This is an old .xls file. Please open it in Excel and use Save As > Excel Workbook (.xlsx).");
    }
    if (!isZip) {
        throw httpError(400, "Please upload an Excel (.xlsx) file.");
    }

    const workbook = new ExcelJS.Workbook();
    try {
        await workbook.xlsx.load(buffer);
    } catch (error) {
        throw httpError(400, "Could not read this Excel file. Is it a valid .xlsx file?");
    }

    const sheet = workbook.worksheets.find((ws) => ws.rowCount > 0) || workbook.worksheets[0];
    if (!sheet) throw httpError(400, "No worksheet found in the Excel file.");

    // header row = first row that has any content (look at the first 20 rows)
    let headerRowNumber = 0;
    for (let r = 1; r <= Math.min(sheet.rowCount, 20); r++) {
        const values = sheet.getRow(r).values;
        if (Array.isArray(values) && values.some((v) => cellToValue(v) !== "")) {
            headerRowNumber = r;
            break;
        }
    }
    if (!headerRowNumber) throw httpError(400, "Excel file is empty.");

    const headerRow = sheet.getRow(headerRowNumber);
    const headers = []; // { col, text }
    const seen = new Set();
    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const text = String(cellToValue(cell.value)).trim();
        if (!text) return;
        const key = normalizeKey(text);
        if (seen.has(key)) return; // first column with a given name wins
        seen.add(key);
        headers.push({ col: colNumber, text });
    });
    if (headers.length === 0) throw httpError(400, "Excel file has no column headings in the first row.");

    const rows = [];
    for (let r = headerRowNumber + 1; r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r);
        const item = { __row: r };
        let hasData = false;
        for (const h of headers) {
            const value = cellToValue(row.getCell(h.col).value);
            item[h.text] = value;
            if (value !== "") hasData = true;
        }
        if (!hasData) continue;
        rows.push(item);
        if (rows.length > maxRows) {
            throw httpError(400, `The file has more than ${maxRows} rows. Please split it into smaller files.`);
        }
    }
    if (rows.length === 0) throw httpError(400, "Excel file is empty.");

    return { columns: headers.map((h) => h.text), rows };
}

// ---------------------------------------------------------------------------
// Analysing rows for import (used by BOTH preview and import, so they always agree)
// ---------------------------------------------------------------------------

const NAME_KEYS = ["Name", "Student Name", "StudentName", "নাম"];
const ROLL_KEYS = ["Roll", "Roll No", "Roll Number", "রোল"];
const REG_KEYS = ["Registration", "Reg", "Registration No", "Registration Number", "রেজিস্ট্রেশন"];
const GROUP_KEYS = ["Group", "Group Name", "গ্রুপ"];

function findColumn(columns, wantedKeys) {
    const wanted = wantedKeys.map(normalizeKey);
    return columns.find((c) => wanted.includes(normalizeKey(c)));
}

function subjectColumn(columns, subject) {
    const name = String(subject.subject_name || "").trim();
    const code = String(subject.subject_code || "").trim();
    return findColumn(columns, [name, code, `${name} (${code})`, `${code} (${name})`]);
}

function text(value) {
    return String(value ?? "").trim();
}

/**
 * subjects: subject rows of the exam's class
 * existing: Map<roll, { id, status }> of students already saved for this exam
 * duplicateMode: "skip" | "update"
 * lockPublished: true for teachers (they may not overwrite a published result)
 */
function analyzeRows({ columns, rows, subjects, existing, duplicateMode, lockPublished = false }) {
    const nameCol = findColumn(columns, NAME_KEYS);
    const rollCol = findColumn(columns, ROLL_KEYS);
    if (!nameCol || !rollCol) {
        throw httpError(400, "Excel must contain Name and Roll columns.");
    }
    const regCol = findColumn(columns, REG_KEYS);
    const groupCol = findColumn(columns, GROUP_KEYS);

    const subjectCols = subjects.map((subject) => ({ subject, col: subjectColumn(columns, subject) }));
    const isFourth = (subject) => String(subject.subject_type || "").toLowerCase() === "fourth";
    // A missing column is only an error for normal subjects; a 4th subject may be left out completely.
    const missing = subjectCols.filter((s) => !s.col && !isFourth(s.subject)).map((s) => `${s.subject.subject_name} (${s.subject.subject_code})`);
    if (missing.length > 0) {
        throw httpError(400, `These subject columns are missing in the Excel file: ${missing.join(", ")}`);
    }

    const subjectsById = new Map(subjects.map((s) => [Number(s.id), s]));
    const seenInFile = new Map();
    const analyzed = [];

    for (const row of rows) {
        const name = text(row[nameCol]);
        const roll = bnToAsciiDigits(text(row[rollCol]));
        const registration = regCol ? text(row[regCol]) : "";
        const groupName = groupCol ? text(row[groupCol]) : "";

        const item = {
            row: row.__row,
            name,
            roll,
            registration,
            group_name: groupName,
            marks: [],
            errors: [],
            state: "new",
            existing_id: null,
            gpa: null,
            grade: null,
            result: null
        };

        if (!name) item.errors.push("Student name is missing.");
        if (!roll) item.errors.push("Roll is missing.");
        if (name.length > 200) item.errors.push("Student name is too long.");

        // marks
        for (const { subject, col } of subjectCols) {
            const raw = col ? row[col] : "";
            const subjectName = subject.subject_name;
            if (raw === "" || raw === null || raw === undefined) {
                // A 4th (optional) subject is not taken by every student: blank simply means "not taken".
                if (String(subject.subject_type || "").toLowerCase() === "fourth") continue;
                item.errors.push(`${subjectName} marks are missing.`);
                continue;
            }
            const marks = typeof raw === "number" ? raw : Number(bnToAsciiDigits(text(raw)));
            if (!Number.isFinite(marks)) {
                item.errors.push(`${subjectName} marks are not a valid number.`);
                continue;
            }
            const full = Number(subject.full_marks);
            if (marks < 0 || marks > full) {
                item.errors.push(`${subjectName} marks must be between 0 and ${full}.`);
                continue;
            }
            item.marks.push({ subject_id: Number(subject.id), marks });
        }

        // duplicates
        if (roll) {
            const key = roll;
            if (seenInFile.has(key)) {
                item.errors.push(`Duplicate roll in this file (same as row ${seenInFile.get(key)}).`);
            } else {
                seenInFile.set(key, row.__row);
                if (existing.has(key)) {
                    const found = existing.get(key);
                    item.existing_id = found.id;
                    item.existing_status = found.status;
                    if (duplicateMode === "update") {
                        item.state = "update";
                        if (lockPublished && found.status === "published") {
                            item.errors.push("This result is already published. Only an admin can change it.");
                        }
                    } else {
                        item.state = "skip";
                        item.errors.push("This roll already exists for this exam (skipped).");
                    }
                }
            }
        }

        if (item.errors.length === 0) {
            const { final } = gradeSubjects(subjectsById, item.marks);
            item.gpa = final.gpa;
            item.grade = final.grade;
            item.result = final.status;
        }

        item.valid = item.errors.length === 0;
        analyzed.push(item);
    }

    const counts = {
        total: analyzed.length,
        new: analyzed.filter((r) => r.valid && r.state === "new").length,
        update: analyzed.filter((r) => r.valid && r.state === "update").length,
        skipped: analyzed.filter((r) => r.state === "skip").length,
        invalid: analyzed.filter((r) => !r.valid && r.state !== "skip").length
    };
    return { rows: analyzed, counts };
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

async function buildTemplate({ subjects, exam }) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "School Result System";

    const hasSubjects = subjects && subjects.length > 0;
    const subjectHeaders = hasSubjects
        ? subjects.map((s) => `${s.subject_name} (${s.subject_code})`)
        : ["Bangla (101)", "English (107)", "Mathematics (109)"];

    const headers = ["Name", "Roll", "Registration", "Group", ...subjectHeaders];

    const data = workbook.addWorksheet("Data");
    data.addRow(headers);
    data.getRow(1).font = { bold: true };
    data.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDBEAFE" } };
    data.columns = headers.map((h, i) => ({ width: i === 0 ? 28 : Math.max(12, h.length + 2) }));
    data.views = [{ state: "frozen", ySplit: 1 }];

    const example = workbook.addWorksheet("Example");
    example.addRow(headers);
    example.getRow(1).font = { bold: true };
    const sampleMarks = (hasSubjects ? subjects : [{ full_marks: 100 }, { full_marks: 100 }, { full_marks: 100 }])
        .map((s) => Math.max(0, Math.round(Number(s.full_marks) * 0.8)));
    example.addRow(["Sample Student", 1, "REG-0001", "", ...sampleMarks]);
    example.columns = data.columns.map((c) => ({ width: c.width }));

    const help = workbook.addWorksheet("Instructions");
    const lines = [
        "How to fill this file",
        exam ? `Exam: ${exam.exam_name} - Class ${exam.class_name} - ${exam.exam_year}` : "This is a generic demo. Download the template again after choosing an exam to get its real subject columns.",
        "1. Type students in the 'Data' sheet, one student per row, starting from row 2. Do not rename or delete the column headings.",
        "2. Name and Roll are required. Registration and Group are optional.",
        "3. Every subject column needs marks (a number from 0 to the subject's full marks).",
        "4. The 'Example' sheet is only an example. Only the FIRST sheet ('Data') is imported.",
        "5. Save as .xlsx (Excel Workbook)."
    ];
    lines.forEach((l) => help.addRow([l]));
    help.getRow(1).font = { bold: true, size: 14 };
    help.getColumn(1).width = 110;

    return workbook.xlsx.writeBuffer();
}

module.exports = { readSheet, analyzeRows, buildTemplate, normalizeKey, cellToValue, bnToAsciiDigits };
