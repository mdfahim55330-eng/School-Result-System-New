"use strict";

const config = require("./src/config");
const db = require("./src/db");
const { migrate } = require("./src/migrate");
const { createApp } = require("./src/app");

async function start() {
    if (!config.databaseUrl) {
        console.error("DATABASE_URL is not set. Please add it to your environment (.env file or hosting settings).");
        process.exit(1);
    }

    await migrate();

    const app = createApp();
    const server = app.listen(config.port, () => {
        console.log("=================================");
        console.log(` ${config.school.name}`);
        console.log(" Result Management System");
        console.log("=================================");
        console.log(`Server running on port ${config.port}`);
    });

    const shutdown = (signal) => {
        console.log(`${signal} received, shutting down...`);
        server.close(async () => {
            await db.close().catch(() => {});
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
});

start().catch((error) => {
    console.error("Could not start the server:", error);
    process.exit(1);
});
