"use strict";

const { z } = require("zod");
const { httpError } = require("./utils");

/** Parse `data` with a zod schema; on failure throw a 400 with a readable message. */
function parse(schema, data) {
    const result = schema.safeParse(data);
    if (!result.success) {
        const issue = result.error.issues[0];
        const field = issue.path.length ? issue.path.join(".") + ": " : "";
        throw httpError(400, field + issue.message);
    }
    return result.data;
}

const text = (max, label = "Value") =>
    z.string({ required_error: `${label} is required.`, invalid_type_error: `${label} must be text.` })
        .trim()
        .min(1, `${label} is required.`)
        .max(max, `${label} is too long.`);

// numbers may arrive as "2025" strings from HTML forms
const int = (label = "Value") =>
    z.coerce.number({ invalid_type_error: `${label} must be a number.` }).int(`${label} must be a whole number.`);

const password = z.string({ required_error: "Password is required." })
    .min(8, "Password must be at least 8 characters.")
    .max(100, "Password is too long.");

module.exports = { z, parse, text, int, password };
