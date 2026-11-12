import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import PgBoss from "pg-boss";
import * as schema from "@bukuwa/db";
import type { Db } from "@bukuwa/db";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { INBOUND_QUEUE, pgBossQueue } from "./queue.js";

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const db = drizzle(pool, { schema }) as unknown as Db;

const boss = new PgBoss(config.DATABASE_URL);
boss.on("error", (err) => console.error(JSON.stringify({ level: "error", event: "pgboss.error", error: err.message })));
await boss.start();
await boss.createQueue(INBOUND_QUEUE);

const app = createApp({ db, queue: pgBossQueue(boss), config });
serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(JSON.stringify({ level: "info", event: "api.listening", port: info.port }));
});
