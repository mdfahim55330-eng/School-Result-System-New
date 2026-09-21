"use strict";

// Create an admin account, or reset the password of an existing one.
//   npm run set-admin -- <username>
// (the password is typed hidden; for automation you may set ADMIN_PASSWORD instead)

const readline = require("readline");
const bcrypt = require("bcrypt");
require("../src/config");
const db = require("../src/db");
const { migrate } = require("../src/migrate");

function askHidden(question) {
    return new Promise((resolve) => {
        if (!process.stdin.isTTY) {
            const rl = readline.createInterface({ input: process.stdin });
            rl.question(question, (a) => { rl.close(); resolve(a); });
            return;
        }
        process.stdout.write(question);
        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding("utf8");
        let value = "";
        const onData = (ch) => {
            if (ch === "\r" || ch === "\n" || ch === "\u0004") {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener("data", onData);
                process.stdout.write("\n");
                resolve(value);
            } else if (ch === "\u0003") {
                process.exit(1);
            } else if (ch === "\u007f" || ch === "\b") {
                value = value.slice(0, -1);
            } else {
                value += ch;
            }
        };
        stdin.on("data", onData);
    });
}

(async () => {
    try {
        const username = (process.argv[2] || process.env.ADMIN_USERNAME || "").trim();
        if (!username) {
            console.error("Usage: npm run set-admin -- <username>");
            process.exit(1);
        }

        let password = process.env.ADMIN_PASSWORD || "";
        if (!password) password = await askHidden(`New password for "${username}" (min 8 characters): `);
        if (password.length < 8) {
            console.error("The password must be at least 8 characters.");
            process.exit(1);
        }

        await migrate();
        const hash = await bcrypt.hash(password, 12);
        const existing = await db.one(`SELECT id FROM admins WHERE username = ?`, [username]);

        if (existing) {
            await db.query(
                `UPDATE admins SET password = ?, role = 'admin', active = TRUE, must_change_password = FALSE WHERE id = ?`,
                [hash, existing.id]
            );
            console.log(`Password updated for admin "${username}".`);
        } else {
            await db.query(
                `INSERT INTO admins (username, password, role, must_change_password) VALUES (?, ?, 'admin', FALSE)`,
                [username, hash]
            );
            console.log(`Admin "${username}" created.`);
        }
    } catch (error) {
        console.error("Failed:", error.message);
        process.exitCode = 1;
    } finally {
        await db.close();
    }
})();
