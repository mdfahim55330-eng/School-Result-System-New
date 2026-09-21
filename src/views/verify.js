"use strict";

const { escapeHtml: h } = require("../utils");

function page(title, body) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${h(title)}</title>
<link rel="stylesheet" href="/css/app.css">
</head>
<body class="min-h-screen bg-slate-100 font-sans text-slate-800 antialiased">
<main class="mx-auto flex min-h-screen max-w-lg items-center px-4 py-10">
${body}
</main>
</body>
</html>`;
}

function row(label, value) {
    return `<div class="flex justify-between gap-4 border-b border-slate-100 py-2.5 text-sm">
<dt class="text-slate-500">${h(label)}</dt><dd class="text-right font-semibold text-slate-900">${h(value)}</dd></div>`;
}

function valid(school, data) {
    const s = data.student;
    const m = data.summary;
    const failed = String(m.result).toLowerCase() === "fail";
    return page("Result verified", `
<div class="w-full overflow-hidden rounded-2xl bg-white shadow-xl ring-1 ring-slate-200">
  <div class="bg-emerald-600 px-6 py-5 text-center text-white">
    <div class="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-white/20 text-2xl font-bold">&#10003;</div>
    <h1 class="text-xl font-bold">Result Verified</h1>
    <p class="mt-1 text-sm text-emerald-50">This result matches the official school records.</p>
  </div>
  <div class="px-6 py-5">
    <p class="mb-3 text-center text-sm font-semibold text-slate-600">${h(school.name)}</p>
    <dl>
      ${row("Student", s.name)}
      ${row("Roll", s.roll)}
      ${row("Class", s.class_name)}
      ${row("Examination", `${s.exam_name} ${s.exam_year}`)}
      ${row("GPA", Number(m.gpa).toFixed(2))}
      ${row("Result", m.result)}
      ${row("Position", m.position)}
    </dl>
    <p class="mt-4 rounded-lg ${failed ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"} px-3 py-2 text-center text-sm font-semibold">
      ${failed ? "Not Passed" : "Passed"} &middot; Grade ${h(m.grade)}
    </p>
  </div>
</div>`);
}

function invalid(message) {
    return page("Result not verified", `
<div class="w-full overflow-hidden rounded-2xl bg-white shadow-xl ring-1 ring-slate-200">
  <div class="bg-red-600 px-6 py-5 text-center text-white">
    <div class="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-white/20 text-2xl font-bold">&#33;</div>
    <h1 class="text-xl font-bold">Could not verify</h1>
  </div>
  <p class="px-6 py-6 text-center text-sm text-slate-600">${h(message)}</p>
</div>`);
}

module.exports = { valid, invalid };
