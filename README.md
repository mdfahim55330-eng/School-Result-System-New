# School Result System v2

Shaheed Nur Hossain Memorial School - result publication system (Node.js + Express + PostgreSQL + Tailwind CSS).

## Deploy (Render) - step by step

1. Copy **all files of this zip** into your project folder (keep your own `.git` folder), then run `npm install`.
2. In Render > your service > **Environment**, add:
   - `SESSION_SECRET` = a long random text (**required**, the server will not start without it). Create one with  
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `PUBLIC_BASE_URL` = your site address, e.g. `https://your-school.onrender.com`
   - `DATABASE_URL` stays as it is now.
3. `git add . && git commit -m "v2" && git push`.
4. Open the site and log in with your **old admin account**. You will be asked to choose a **new password** first
   (the old password was written in public source code, so it must be replaced).
5. Optional: run `npm run find-duplicates` once. If it prints duplicates (same roll twice in one class/exam), fix them
   in the admin panel and restart; then the database duplicate protection switches on by itself.

No database change is needed by hand: the server upgrades the old tables on start and keeps all data.

## What is new
- Roles: **Admin** and **Teacher** (Users & Activity page). Teachers can add/edit draft results, import Excel (as draft) and see reports. Only admins publish, delete, manage subjects/exams/users, export and back up.
- Publish / unpublish a single result or a whole class + exam at once (results with missing main-subject marks are never published).
- Merit list, tabulation sheet (landscape print), statistics (pass rate, grades, subject-wise).
- Bangla PDF marksheet (single student, or a whole class in one PDF) with a QR code. The QR opens a page that proves the result is genuine.
- Excel import: template download, file check before import, clear list of rows that were not imported, duplicate handling, Bangla digits accepted.
- Activity log (who changed which marks), Excel/CSV export, backup download and restore.
- Security: no password in code, sessions saved in the database, login limit, protection against cross-site requests, safe display of names (no HTML injection), strict content security policy.
- Faster: database indexes, connection pool of 10 (was 1), short cache for public result pages, compression.

## Rules worth knowing
- Roll must be unique inside one class + exam + year.
- Every **main** subject needs marks. A **4th** subject can be empty (student did not take it).
- Merit position: passed students by GPA, then total marks (4th subject counts only marks above 40 in class Nine/Ten). Failed students have no position. Set `MERIT_MODE=marks` for the old marks-only rule.
- Excel files must be `.xlsx` (save old `.xls` files as `.xlsx`).
- Never change `SESSION_SECRET` after printing marksheets, or their QR codes stop verifying.

## Commands
| Command | What it does |
|---|---|
| `npm start` | start the server |
| `npm run dev` | start with auto-restart while coding |
| `npm run set-admin -- name` | create an admin or reset an admin password |
| `npm run find-duplicates` | list duplicate rows in old data |
| `npm run restore -- file.json` | restore a backup into an EMPTY database |
| `npm run build:css` | rebuild `public/css/app.css` (only after changing Tailwind classes in HTML/JS) |
| `TEST_DATABASE_URL=postgres://... npm test` | run all tests (**erases** that database, use an empty test database) |
