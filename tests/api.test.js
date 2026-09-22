"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const { startServer, client } = require("./helpers");
const { assignPositions } = require("../src/services/reports");

let srv, admin, teacher, anon;
const ids = {};

before(async () => {
    srv = await startServer();
    admin = client(srv.base);
    teacher = client(srv.base);
    anon = client(srv.base);
});
after(async () => { await srv.stop(); });

async function xlsxBuffer(rows) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Data");
    rows.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
}
function upload(buffer, fields) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append("excelFile", new Blob([buffer]), "marks.xlsx");
    return form;
}

// ---------------------------------------------------------------------------
test("position ranking uses dense positions for equal total marks", () => {
    const students = [
        { id: 1, result_status: "Pass", merit_marks: 100, final_gpa: 5 },
        { id: 2, result_status: "Pass", merit_marks: 100, final_gpa: 5 },
        { id: 3, result_status: "Pass", merit_marks: 90, final_gpa: 4.8 },
        { id: 4, result_status: "Pass", merit_marks: 80, final_gpa: 4.5 },
        { id: 5, result_status: "Pass", merit_marks: 80, final_gpa: 4.5 },
        { id: 6, result_status: "Pass", merit_marks: 70, final_gpa: 4.0 },
        { id: 7, result_status: "Fail", merit_marks: 110, final_gpa: 0 }
    ];

    assignPositions(students, "marks");

    assert.deepEqual(
        students.filter((s) => s.position !== null).map((s) => s.position),
        [1, 1, 2, 3, 3, 4]
    );
    assert.equal(students[6].position, null);
});

test("login, roles and forced password change", async () => {
    assert.equal((await anon.get("/api/admin/subjects")).status, 401);
    assert.equal((await anon.post("/api/admin/login", { username: "admin", password: "wrong-password" })).status, 401);

    const ok = await admin.post("/api/admin/login", { username: "admin", password: "Admin@12345" });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.role, "admin");
    assert.equal((await admin.get("/api/admin/me")).data.loggedIn, true);

    // create a teacher (must change password at first login)
    const t = await admin.post("/api/admin/users", { username: "teacher1", password: "Temp@12345", role: "teacher" });
    assert.equal(t.status, 200);
    assert.equal((await admin.post("/api/admin/users", { username: "Teacher1", password: "Temp@12345", role: "teacher" })).status, 400);
    assert.equal((await admin.post("/api/admin/users", { username: "x", password: "short", role: "teacher" })).status, 400);

    const login = await teacher.post("/api/admin/login", { username: "teacher1", password: "Temp@12345" });
    assert.equal(login.data.must_change_password, true);
    const blocked = await teacher.get("/api/admin/subjects");
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.code, "PASSWORD_CHANGE_REQUIRED");
    assert.equal((await teacher.post("/api/admin/change-password", { current_password: "Temp@12345", new_password: "Temp@12345" })).status, 400);
    assert.equal((await teacher.post("/api/admin/change-password", { current_password: "Temp@12345", new_password: "Teacher@98765" })).status, 200);
    assert.equal((await teacher.get("/api/admin/subjects")).status, 200);

    // teacher cannot do admin things
    assert.equal((await teacher.post("/api/admin/subjects", { class_name: "Ten", subject_name: "X", subject_code: "1", full_marks: 100 })).status, 403);
    assert.equal((await teacher.get("/api/admin/users")).status, 403);
    assert.equal((await teacher.get("/api/admin/backup")).status, 403);
});

test("subjects and exams", async () => {
    const subs = [
        ["Bangla", "101", 100, "main"], ["English", "107", 100, "main"],
        ["Mathematics", "109", 100, "main"], ["Agriculture", "134", 100, "fourth"]
    ];
    for (const [n, c, f, t] of subs) {
        const r = await admin.post("/api/admin/subjects", { class_name: "Ten", subject_name: n, subject_code: c, full_marks: f, subject_type: t });
        assert.equal(r.status, 200, JSON.stringify(r.data));
    }
    assert.equal((await admin.post("/api/admin/subjects", { class_name: "Ten", subject_name: "Dup", subject_code: "101", full_marks: 100 })).status, 400);
    assert.equal((await admin.post("/api/admin/subjects", { class_name: "Ten", subject_name: "Bad", subject_code: "1", full_marks: 0 })).status, 400);

    const list = (await admin.get("/api/admin/subjects")).data.subjects;
    ids.sub = Object.fromEntries(list.map((s) => [s.subject_code, s.id]));

    const ex = await admin.post("/api/admin/exams", { exam_name: "Annual", exam_year: 2026, class_name: "Ten" });
    assert.equal(ex.status, 200);
    ids.exam = ex.data.id;
    assert.equal((await admin.post("/api/admin/exams", { exam_name: "Annual", exam_year: 2026, class_name: "Ten" })).status, 400);
});

const marks = (b, e, m, f) => {
    const r = [
        { subject_id: ids.sub["101"], marks: b }, { subject_id: ids.sub["107"], marks: e }, { subject_id: ids.sub["109"], marks: m }
    ];
    if (f !== undefined) r.push({ subject_id: ids.sub["134"], marks: f });
    return r;
};

test("individual result: validation, duplicates, publish, search, verify, pdf", async () => {
    const student = { name: "Rahim Uddin", roll: "1", registration: "R-1", group_name: "Science" };

    // marks missing for a main subject
    let r = await admin.post("/api/admin/results/individual", { exam_id: ids.exam, student, results: marks(90, 90, "").slice(0, 2) });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /Mathematics/);
    // marks above full marks
    r = await admin.post("/api/admin/results/individual", { exam_id: ids.exam, student, results: marks(101, 90, 90) });
    assert.equal(r.status, 400);

    r = await admin.post("/api/admin/results/individual", { exam_id: ids.exam, student, results: marks(90, 85, 80, 70) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ids.rahim = r.data.student_id;
    // A+ A+ A+ =15/3=5 ; 4th subject A (4.0): bonus 2 -> (15+2)/3 = 5.67 capped 5
    assert.equal(r.data.gpa, 5);
    assert.equal(r.data.result, "Pass");

    // same roll again -> 409
    r = await admin.post("/api/admin/results/individual", { exam_id: ids.exam, student: { ...student, name: "Other" }, results: marks(50, 50, 50) });
    assert.equal(r.status, 409);

    // draft is invisible to the public
    const q = `roll=1&class_name=Ten&exam_name=Annual&exam_year=2026`;
    assert.equal((await anon.get(`/api/result/search?${q}`)).status, 404);
    assert.equal((await anon.get(`/api/result/options`)).data.options.length, 0);

    // teacher cannot publish, admin can
    assert.equal((await teacher.put(`/api/admin/results/${ids.rahim}/publish`)).status, 403);
    assert.equal((await admin.put(`/api/admin/results/${ids.rahim}/publish`)).status, 200);

    r = await anon.get(`/api/result/search?${q}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.student.name, "Rahim Uddin");
    assert.equal(r.data.summary.gpa, 5);
    assert.equal(r.data.summary.position, 1);
    assert.ok(r.data.qr.startsWith("data:image/png;base64,"));
    assert.match(r.data.verify_url, /\/verify\/\d+\/[A-Za-z0-9_-]+$/);
    assert.equal((await anon.get(`/api/result/options`)).data.options.length, 1);

    // verify page: real link works, tampered link does not, names are escaped
    const path = new URL(r.data.verify_url).pathname;
    const v = await anon.get(path);
    assert.equal(v.status, 200);
    assert.match(v.data, /Result Verified/);
    assert.match(v.data, /Rahim Uddin/);
    assert.equal((await anon.get(path.slice(0, -2) + "xx")).status, 404);
    assert.equal((await anon.get(`/verify/999999/abc`)).status, 404);

    // pdf
    const pdf = await anon.request("GET", `/api/result/marksheet.pdf?${q}`, { raw: true });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    const buf = Buffer.from(await pdf.arrayBuffer());
    assert.equal(buf.slice(0, 5).toString(), "%PDF-");
    assert.ok(buf.length > 20000);

    // missing / bad parameters
    assert.equal((await anon.get(`/api/result/search?roll=1`)).status, 400);
    assert.equal((await anon.get(`/api/result/search?roll=99&class_name=Ten&exam_name=Annual&exam_year=2026`)).status, 404);
});

test("edit result, audit trail and teacher restriction", async () => {
    const student = { name: "Rahim Uddin", roll: "1", registration: "R-1", group_name: "Science" };
    // teacher cannot edit a published result
    let r = await teacher.put(`/api/admin/results/${ids.rahim}`, { student, results: marks(90, 85, 80, 70) });
    assert.equal(r.status, 403);

    r = await admin.put(`/api/admin/results/${ids.rahim}`, { student, results: marks(90, 85, 45, 70) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    // 5 + 5 + C(2) = 12 /3 = 4 ; fourth bonus 2 -> 14/3 = 4.67
    assert.equal(r.data.final_gpa, 4.67);

    const audit = (await admin.get("/api/admin/audit?action=result_updated")).data;
    assert.equal(audit.total, 1);
    assert.match(audit.logs[0].summary, /Mathematics 80 -> 45/);
    assert.equal(audit.logs[0].username, "admin");

    // roll clash on edit
    const b = await admin.post("/api/admin/results/individual", { exam_id: ids.exam, student: { name: "Karim", roll: "2", group_name: "Science" }, results: marks(60, 60, 60) });
    assert.equal(b.status, 200);
    ids.karim = b.data.student_id;
    r = await admin.put(`/api/admin/results/${ids.karim}`, { student: { name: "Karim", roll: "1" }, results: marks(60, 60, 60) });
    assert.equal(r.status, 409);

    // teacher CAN edit a draft
    r = await teacher.put(`/api/admin/results/${ids.karim}`, { student: { name: "Karim Hossain", roll: "2", group_name: "Science" }, results: marks(60, 60, 60) });
    assert.equal(r.status, 200);
});

test("bulk import: preview, errors, duplicates, Bengali, optional 4th subject", async () => {
    const header = ["Name", "Roll", "Registration", "Group", "Bangla (101)", "English (107)", "Mathematics (109)", "Agriculture (134)"];
    const rows = [
        header,
        ["রহিম আহমেদ", "১০", "REG10", "Science", "৮০", "75", 90, ""],        // Bengali digits, no 4th subject
        ["Sumi Akter", 11, "REG11", "Science", 70, 60, 50, 65],
        ["Bad Marks", 12, "", "Science", 101, 60, 50, ""],                // out of range
        ["Missing", 13, "", "Science", 70, "", 50, ""],                    // blank main subject
        ["Twin", 11, "", "Science", 70, 60, 50, ""],                       // duplicate roll in file
        ["Rahim Uddin", 1, "R-1", "Science", 90, 85, 45, 70],              // roll 1 already in DB (same data)
        ["Failer", 14, "", "Science", 20, 60, 50, ""]                      // fails Bangla
    ];
    const buffer = await xlsxBuffer(rows);

    let r = await admin.post("/api/admin/bulk-preview", undefined, { form: upload(buffer, { exam_id: ids.exam }) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.counts.total, 7);
    assert.equal(r.data.counts.new, 3);      // 10, 11, 14
    assert.equal(r.data.counts.skipped, 1);  // roll 1
    assert.equal(r.data.counts.invalid, 3);
    assert.equal(r.data.rows.length, 7);
    assert.ok(!("__row" in r.data.rows[0]));

    // wrong file type / old xls signature
    r = await admin.post("/api/admin/bulk-preview", undefined, { form: (() => { const f = new FormData(); f.append("excelFile", new Blob(["hello"]), "x.txt"); return f; })() });
    assert.equal(r.status, 400);
    r = await admin.post("/api/admin/bulk-preview", undefined, { form: (() => { const f = new FormData(); f.append("excelFile", new Blob([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2])]), "x.xlsx"); return f; })() });
    assert.equal(r.status, 400);
    assert.match(r.data.message, /xlsx/);

    // teacher imports as DRAFT even if publish=true
    r = await teacher.post("/api/admin/bulk-import", undefined, { form: upload(buffer, { exam_id: ids.exam, publish: "true" }) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.processed, 3);
    assert.equal(r.data.failed, 4);
    assert.equal(r.data.published, false);
    assert.equal(r.data.errors.length, 4);
    const all = (await admin.get("/api/admin/results?search=Sumi")).data.results;
    assert.equal(all.length, 1);
    assert.equal(all[0].status, "draft");
    const bn = (await admin.get("/api/admin/results?search=" + encodeURIComponent("রহিম"))).data.results[0];
    assert.equal(bn.roll, "10");
    const detail = (await admin.get(`/api/admin/results/${bn.id}`)).data;
    assert.equal(detail.results.length, 3);           // 4th subject skipped
    assert.equal(detail.student.final_gpa, 4.67);     // A+, A, A+ = 14 / 3

    // importing the same file again skips everything valid
    r = await admin.post("/api/admin/bulk-import", undefined, { form: upload(buffer, { exam_id: ids.exam }) });
    assert.equal(r.data.processed, 0);
    // update mode: overwrites and publishes (admin)
    r = await admin.post("/api/admin/bulk-import", undefined, { form: upload(buffer, { exam_id: ids.exam, duplicate_mode: "update", publish: "true" }) });
    assert.equal(r.data.updated, 4);                  // 10, 11, 14 and the existing roll 1
    assert.equal(r.data.created, 0);
    assert.equal((await admin.get("/api/admin/results?search=Sumi")).data.results[0].status, "published");

    // Excel template
    const t = await admin.request("GET", `/api/admin/download-excel-demo?exam_id=${ids.exam}`, { raw: true });
    assert.equal(t.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await t.arrayBuffer()));
    assert.deepEqual(wb.worksheets[0].getRow(1).values.slice(1), header);
    assert.equal((await admin.request("GET", `/api/admin/download-excel-demo`, { raw: true })).status, 200);
});

test("merit positions, statistics, tabulation, exports, backup", async () => {
    // Students now: rahim(4.67) sumi(?) rahim-bn(5) karim(?) failer(fail)
    const merit = (await admin.get("/api/admin/reports/merit?class_name=Ten&exam_name=Annual&exam_year=2026")).data;
    const byName = Object.fromEntries(merit.students.map((s) => [s.name, s]));
    // both have GPA 4.67; Rahim Uddin has more merit marks (4th subject counts above 40) so he is first
    assert.equal(byName["Rahim Uddin"].final_gpa, 4.67);
    assert.equal(byName["রহিম আহমেদ"].final_gpa, 4.67);
    assert.equal(byName["Rahim Uddin"].position, 1);
    assert.equal(byName["রহিম আহমেদ"].position, 2);
    assert.equal(byName["Failer"].position, null);            // failed students are not ranked
    assert.equal(byName["Failer"].result_status, "Fail");
    // positions are consecutive competition ranks
    const ranked = merit.students.filter((s) => s.position !== null).map((s) => s.position);
    assert.deepEqual(ranked, [...ranked].sort((a, b) => a - b));

    const stats = (await admin.get("/api/admin/reports/statistics?class_name=Ten&exam_name=Annual&exam_year=2026")).data;
    assert.equal(stats.summary.total_students, merit.students.length);
    assert.equal(stats.summary.failed, 1);
    assert.equal(stats.subjects.length, 4);
    const bangla = stats.subjects.find((s) => s.subject_code === "101");
    assert.equal(bangla.failed, 1);

    const tab = (await admin.get("/api/admin/reports/tabulation?class_name=Ten&exam_name=Annual&exam_year=2026")).data;
    assert.equal(tab.subjects.length, 4);
    assert.ok(tab.students[0].marks[ids.sub["101"]] !== undefined);

    // exports (admin only)
    const q = "class_name=Ten&exam_name=Annual&exam_year=2026";
    assert.equal((await teacher.get(`/api/admin/export/results.csv?${q}`)).status, 403);
    const csvRes = await admin.request("GET", `/api/admin/export/results.csv?${q}`, { raw: true });
    assert.equal(csvRes.status, 200);
    const csvBytes = Buffer.from(await csvRes.arrayBuffer());
    assert.deepEqual([...csvBytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);     // UTF-8 BOM so Excel shows Bangla correctly
    const csvText = csvBytes.toString("utf8");
    assert.ok(csvText.includes("Position,Roll,Name"));
    assert.match(csvText, /রহিম আহমেদ/);
    const xl = await admin.request("GET", `/api/admin/export/results.xlsx?${q}`, { raw: true });
    assert.equal(xl.status, 200);

    // class pdf: only published unless status=all
    const pdf = await teacher.request("GET", `/api/admin/reports/marksheets.pdf?${q}`, { raw: true });
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).slice(0, 5).toString(), "%PDF-");

    // backup has no passwords
    const backup = await admin.get("/api/admin/backup");
    assert.equal(backup.status, 200);
    assert.ok(!JSON.stringify(backup.data).includes("$2b$"));
    assert.equal(backup.data.counts.students, merit.students.length);
});

test("bulk publish / unpublish and completeness", async () => {
    const scope = { class_name: "Ten", exam_name: "Annual", exam_year: 2026 };
    let r = await admin.post("/api/admin/results/publish-bulk", { ...scope, action: "unpublish" });
    assert.equal(r.status, 200);
    assert.equal((await anon.get(`/api/result/search?roll=1&class_name=Ten&exam_name=Annual&exam_year=2026`)).status, 404);

    // a student with a missing main subject can never be published
    await require("./helpers").db.query(`DELETE FROM results WHERE student_id = ? AND subject_id = ?`, [ids.karim, ids.sub["109"]]);
    r = await admin.post("/api/admin/results/publish-bulk", { ...scope, action: "publish" });
    assert.equal(r.status, 200);
    assert.equal(r.data.skipped_incomplete, 1);
    assert.match(r.data.message, /NOT published/);
    assert.equal((await admin.put(`/api/admin/results/${ids.karim}/publish`)).status, 400);
    assert.equal((await teacher.post("/api/admin/results/publish-bulk", { ...scope, action: "publish" })).status, 403);
    assert.equal((await admin.post("/api/admin/results/publish-bulk", { ...scope, action: "nope" })).status, 400);
    assert.equal((await admin.post("/api/admin/results/publish-bulk", { ...scope, exam_year: 1999, action: "publish" })).status, 404);
});

test("subject deletion protects marks and recalculates GPA", async () => {
    let r = await admin.del(`/api/admin/subjects/${ids.sub["134"]}`);
    assert.equal(r.status, 409);
    assert.equal(r.data.needs_force, true);
    r = await admin.del(`/api/admin/subjects/${ids.sub["134"]}?force=true`);
    assert.equal(r.status, 200);
    const sumi = (await admin.get("/api/admin/results?search=Sumi")).data.results[0];
    // Sumi: 70 A, 60 A-, 50 B = 4+3.5+3 = 10.5/3 = 3.5 (4th subject gone)
    assert.equal(sumi.final_gpa, 3.5);
});

test("users: safety rules", async () => {
    const me = (await admin.get("/api/admin/users")).data.users.find((u) => u.username === "admin");
    assert.equal((await admin.put(`/api/admin/users/${me.id}`, { active: false })).status, 400);
    assert.equal((await admin.put(`/api/admin/users/${me.id}`, { role: "teacher" })).status, 400);

    const t = (await admin.get("/api/admin/users")).data.users.find((u) => u.username === "teacher1");
    assert.equal((await admin.put(`/api/admin/users/${t.id}`, { active: false })).status, 200);
    assert.equal((await teacher.get("/api/admin/subjects")).status, 401);   // cut off immediately
    assert.equal((await client(srv.base).post("/api/admin/login", { username: "teacher1", password: "Teacher@98765" })).status, 401);
    assert.equal((await admin.put(`/api/admin/users/${t.id}`, { active: true })).status, 200);
    assert.equal((await admin.post(`/api/admin/users/${t.id}/reset-password`, { new_password: "Reset@123456" })).status, 200);
});

test("security: headers, cross-site, staff pages, unknown routes", async () => {
    const home = await anon.request("GET", "/", { raw: true });
    assert.equal(home.status, 200);
    const csp = home.headers.get("content-security-policy");
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(home.headers.get("x-powered-by"), null);

    // cross-site POST is refused
    const evil = await anon.post("/api/admin/login", { username: "admin", password: "Admin@12345" }, { headers: { origin: "https://evil.example" } });
    assert.equal(evil.status, 403);

    // staff pages redirect when logged out (and are served when logged in)
    const p = await anon.request("GET", "/pages/admin.html", { raw: true });
    assert.equal(p.status, 302);
    assert.match(p.headers.get("location"), /admin-login/);
    assert.equal((await admin.request("GET", "/pages/admin.html", { raw: true })).status, 200);
    assert.equal((await anon.request("GET", "/pages/result-search.html", { raw: true })).status, 200);

    assert.equal((await anon.get("/api/nothing")).status, 404);
    assert.equal((await admin.post("/api/admin/subjects", undefined, { headers: { "content-type": "application/json" } })).status, 400);
    assert.equal((await anon.get("/healthz")).data.ok, true);

    // rows the old code wrote must not be able to inject html into the verify page
    const evilName = `<img src=x onerror=alert(1)>`;
    const c = await admin.post("/api/admin/results/individual", {
        exam_id: ids.exam, student: { name: evilName, roll: "77" },
        results: [{ subject_id: ids.sub["101"], marks: 90 }, { subject_id: ids.sub["107"], marks: 90 }, { subject_id: ids.sub["109"], marks: 90 }]
    });
    assert.equal(c.status, 200);
    await admin.put(`/api/admin/results/${c.data.student_id}/publish`);
    const s = await anon.get(`/api/result/search?roll=77&class_name=Ten&exam_name=Annual&exam_year=2026`);
    const html = (await anon.get(new URL(s.data.verify_url).pathname)).data;
    assert.ok(!html.includes(evilName));
    assert.match(html, /&lt;img src=x/);
});
