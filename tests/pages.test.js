"use strict";

// Opens every page in a simulated browser (jsdom), runs its JavaScript against the real server
// and checks that nothing throws and the important parts appear on screen.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM, VirtualConsole } = require("jsdom");
const { startServer, client } = require("./helpers");

let srv, admin, teacher, anon;
const ids = {};

async function waitFor(fn, ms = 6000) {
    const start = Date.now();
    for (;;) {
        let v;
        try { v = fn(); } catch (e) { v = false; }
        if (v) return v;
        if (Date.now() - start > ms) throw new Error("timed out waiting for: " + fn.toString().slice(0, 140));
        await new Promise((r) => setTimeout(r, 25));
    }
}

async function open(who, path) {
    const errors = [];
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => errors.push(e.message));
    vc.on("error", (e) => errors.push(String(e)));
    const res = await who.request("GET", path, { raw: true });
    assert.equal(res.status, 200, `${path} -> ${res.status}`);
    const html = await res.text();
    const dom = new JSDOM(html, {
        url: srv.base + path,
        runScripts: "dangerously",
        resources: "usable",
        pretendToBeVisual: true,
        virtualConsole: vc,
        beforeParse(window) {
            window.fetch = (url, init = {}) => {
                const headers = { ...(init.headers || {}) };
                const c = who.cookie();
                if (c) headers.cookie = c;
                return fetch(new URL(url, srv.base), { ...init, headers, redirect: "manual" });
            };
            window.scrollTo = () => {};
            window.Element.prototype.scrollIntoView = () => {};
            window.print = () => {};
            window.FormData = FormData; window.Blob = Blob;
        }
    });
    return { dom, doc: dom.window.document, win: dom.window, errors };
}

const T = (doc, sel) => (doc.querySelector(sel) ? doc.querySelector(sel).textContent : "");

before(async () => {
    srv = await startServer();
    admin = client(srv.base); teacher = client(srv.base); anon = client(srv.base);
    await admin.post("/api/admin/login", { username: "admin", password: "Admin@12345" });
    await admin.post("/api/admin/users", { username: "teach", password: "Temp@12345", role: "teacher" });
    await teacher.post("/api/admin/login", { username: "teach", password: "Temp@12345" });
    await teacher.post("/api/admin/change-password", { current_password: "Temp@12345", new_password: "Teach@98765" });

    for (const [n, c, f, t] of [["Bangla", "101", 100, "main"], ["English", "107", 100, "main"], ["Agriculture", "134", 100, "fourth"]]) {
        await admin.post("/api/admin/subjects", { class_name: "Ten", subject_name: n, subject_code: c, full_marks: f, subject_type: t });
    }
    const subs = (await admin.get("/api/admin/subjects")).data.subjects;
    ids.sub = Object.fromEntries(subs.map((s) => [s.subject_code, s.id]));
    ids.exam = (await admin.post("/api/admin/exams", { exam_name: "Annual", exam_year: 2026, class_name: "Ten" })).data.id;
    for (const [name, roll, b, e] of [["Rahim <b>Uddin</b>", "1", 90, 85], ["Karim", "2", 60, 70], ["Failer", "3", 20, 70]]) {
        const r = await admin.post("/api/admin/results/individual", {
            exam_id: ids.exam, student: { name, roll, group_name: "Science" },
            results: [{ subject_id: ids.sub["101"], marks: b }, { subject_id: ids.sub["107"], marks: e }]
        });
        ids["s" + roll] = r.data.student_id;
    }
    await admin.post("/api/admin/results/publish-bulk", { class_name: "Ten", exam_name: "Annual", exam_year: 2026, action: "publish" });
});
after(async () => { await srv.stop(); });

const SCOPE = "?class_name=Ten&exam_name=Annual&exam_year=2026";

test("public pages: home, search flow, marksheet", async () => {
    let p = await open(anon, "/");
    assert.match(p.doc.body.textContent, /Check Result/);
    assert.deepEqual(p.errors, []);

    p = await open(anon, "/pages/result-search.html");
    await waitFor(() => p.doc.querySelectorAll("#className option").length > 1);
    const set = (id, v) => { const el = p.doc.getElementById(id); el.value = v; el.dispatchEvent(new p.win.Event("change")); };
    set("className", "Ten");
    await waitFor(() => p.doc.querySelectorAll("#examName option").length > 1);
    assert.equal(p.doc.getElementById("examName").value, "Annual");        // single exam is pre-selected
    assert.equal(p.doc.getElementById("examYear").value, "2026");
    p.doc.getElementById("roll").value = "1";
    p.doc.getElementById("search-form").dispatchEvent(new p.win.Event("submit", { cancelable: true }));
    await waitFor(() => !p.doc.getElementById("result").classList.contains("hidden"));
    // the name contains html: it must appear as TEXT, never as a real <b> tag
    assert.equal(T(p.doc, "#student-name"), "Rahim <b>Uddin</b>");
    assert.equal(p.doc.querySelector("#student-name b"), null);
    assert.match(p.doc.getElementById("pdf-btn").href, /marksheet\.pdf\?roll=1/);
    assert.equal(p.doc.querySelectorAll("#subjects tr").length, 2);
    assert.deepEqual(p.errors, []);

    // not found message
    p.doc.getElementById("roll").value = "999";
    p.doc.getElementById("search-form").dispatchEvent(new p.win.Event("submit", { cancelable: true }));
    await waitFor(() => /not found/i.test(T(p.doc, "#message")));

    p = await open(anon, "/marksheet.html?roll=1&class_name=Ten&exam_name=Annual&exam_year=2026");
    await waitFor(() => !p.doc.getElementById("sheet").classList.contains("hidden"));
    assert.equal(p.doc.querySelector("#info").textContent.includes("<b>Uddin</b>"), true);
    assert.equal(p.doc.querySelector("#info b"), null);
    assert.ok(p.doc.getElementById("qr").src.startsWith("data:image/png"));
    assert.equal(p.doc.querySelectorAll("#rows tr").length, 2);
    assert.deepEqual(p.errors, []);

    p = await open(anon, "/marksheet.html?roll=999&class_name=Ten&exam_name=Annual&exam_year=2026");
    await waitFor(() => !p.doc.getElementById("error").classList.contains("hidden"));
});

test("staff pages: dashboard, lists, subjects, exams", async () => {
    let p = await open(admin, "/pages/admin.html");
    await waitFor(() => p.doc.getElementById("slot"));
    await waitFor(() => T(p.doc, "#stats").includes("3"));
    assert.match(T(p.doc, "#exams"), /Annual/);
    assert.match(T(p.doc, "#sidebar"), /Users & Activity/);
    assert.deepEqual(p.errors, []);

    p = await open(teacher, "/pages/admin.html");
    await waitFor(() => p.doc.getElementById("slot"));
    assert.ok(!/Users & Activity/.test(T(p.doc, "#sidebar")), "teacher must not see the Users link");

    p = await open(admin, "/pages/subjects.html");
    await waitFor(() => p.doc.querySelectorAll("#rows tr").length === 3);
    assert.ok(!p.doc.getElementById("add-card").classList.contains("hidden"));
    assert.deepEqual(p.errors, []);
    p = await open(teacher, "/pages/subjects.html");
    await waitFor(() => p.doc.querySelectorAll("#rows tr").length === 3);
    assert.ok(p.doc.getElementById("add-card").classList.contains("hidden"));
    assert.equal(p.doc.querySelectorAll("[data-del]").length, 0);

    p = await open(admin, "/pages/exams.html");
    await waitFor(() => /Annual/.test(T(p.doc, "#rows")));
    assert.deepEqual(p.errors, []);

    p = await open(admin, "/pages/result-list.html" + SCOPE);
    await waitFor(() => p.doc.querySelectorAll("#rows tr").length === 3);
    assert.ok(!p.doc.getElementById("bulk").classList.contains("hidden"));
    assert.equal(p.doc.querySelector("#rows b"), null);                      // name shown as text
    assert.match(p.doc.getElementById("l-pdf").href, /marksheets\.pdf\?class_name=Ten/);
    assert.ok(p.doc.getElementById("pub-all"));
    assert.deepEqual(p.errors, []);
    p = await open(teacher, "/pages/result-list.html" + SCOPE);
    await waitFor(() => p.doc.querySelectorAll("#rows tr").length === 3);
    assert.equal(p.doc.getElementById("pub-all"), null);                     // admin-only buttons removed
    assert.equal(p.doc.querySelectorAll('[data-act="delete"]').length, 0);
});

test("staff pages: add/edit result, import, reports, users", async () => {
    let p = await open(admin, "/pages/individual-result.html");
    await waitFor(() => p.doc.querySelectorAll("#exam option").length > 1);
    p.doc.getElementById("exam").value = String(ids.exam);
    p.doc.getElementById("exam").dispatchEvent(new p.win.Event("change"));
    await waitFor(() => p.doc.querySelectorAll(".marks").length === 3);
    const m = p.doc.querySelectorAll(".marks");
    m[0].value = "90"; m[1].value = "85";
    m[0].dispatchEvent(new p.win.Event("input", { bubbles: true }));
    assert.equal(T(p.doc, "#p-gpa"), "5.00");                               // live preview (4th subject empty is fine)
    m[1].value = "20"; m[1].dispatchEvent(new p.win.Event("input", { bubbles: true }));
    assert.equal(T(p.doc, "#p-result"), "Fail");
    assert.deepEqual(p.errors, []);

    p = await open(admin, `/pages/individual-result.html?edit=${ids.s2}`);
    await waitFor(() => p.doc.querySelectorAll(".marks").length === 3 && p.doc.querySelector(".marks").value === "60");
    assert.equal(p.doc.getElementById("name").value, "Karim");
    assert.equal(T(p.doc, "#save"), "Update result");
    assert.deepEqual(p.errors, []);

    p = await open(admin, "/pages/bulk-result.html");
    await waitFor(() => p.doc.querySelectorAll("#exam option").length > 1);
    assert.equal(p.doc.getElementById("template").disabled, true);
    p.doc.getElementById("exam").value = String(ids.exam);
    p.doc.getElementById("exam").dispatchEvent(new p.win.Event("change"));
    assert.equal(p.doc.getElementById("template").disabled, false);
    p = await open(teacher, "/pages/bulk-result.html");
    await waitFor(() => p.doc.getElementById("publish") && p.doc.getElementById("publish").disabled);

    p = await open(admin, "/pages/merit-list.html" + SCOPE);
    await waitFor(() => p.doc.querySelectorAll("#rows tr").length === 3);
    const rows = [...p.doc.querySelectorAll("#rows tr")].map((r) => r.textContent.replace(/\s+/g, " ").trim());
    assert.match(rows[0], /^11Rahim/);            // position 1, roll 1
    assert.match(rows[2], /Failer/);
    assert.equal(p.doc.querySelector("#rows tr:last-child td").textContent.trim(), "-");   // failed = no position
    assert.deepEqual(p.errors, []);

    p = await open(admin, "/pages/tabulation.html" + SCOPE);
    await waitFor(() => p.doc.querySelectorAll("#tab tbody tr").length === 3);
    assert.equal(p.doc.querySelectorAll("#tab thead th").length, 3 + 3 + 4);   // pos, roll, name + 3 subjects + total,gpa,grade,result
    assert.deepEqual(p.errors, []);

    p = await open(admin, "/pages/statistics.html" + SCOPE);
    await waitFor(() => p.doc.querySelectorAll("#subjects tr").length === 3);
    assert.match(T(p.doc, "#cards"), /Pass rate 66.67%/);
    assert.deepEqual(p.errors, []);

    p = await open(admin, "/pages/users.html");
    await waitFor(() => p.doc.querySelectorAll("#users tr").length === 2);
    p.doc.querySelector('[data-tab="audit"]').click();
    await waitFor(() => p.doc.querySelectorAll("#logs tr").length > 3);
    assert.deepEqual(p.errors, []);

    // teacher is sent away from the users page (server-side)
    const r = await teacher.request("GET", "/pages/users.html", { raw: true });
    assert.equal(r.status, 302);
});

test("login and password pages", async () => {
    const fresh = client(srv.base);
    let p = await open(fresh, "/pages/admin-login.html");
    await waitFor(() => p.doc.getElementById("login-form").onsubmit);      // scripts have finished loading
    p.doc.getElementById("username").value = "admin";
    p.doc.getElementById("password").value = "wrong-password";
    p.doc.getElementById("login-form").dispatchEvent(new p.win.Event("submit", { cancelable: true }));
    await waitFor(() => !p.doc.getElementById("error").classList.contains("hidden")).catch((e) => { throw new Error(e.message + " | page errors: " + p.errors.join("; ")); });
    assert.match(T(p.doc, "#error"), /Invalid username or password/);

    p = await open(admin, "/pages/change-password.html");
    await waitFor(() => p.doc.getElementById("key-icon").innerHTML.includes("svg"));
    assert.deepEqual(p.errors.filter((e) => !/navigation/i.test(e)), []);
});
