import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      completed BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log("Database initialized");
}

const app = new Hono();

app.use("/*", cors());

app.get("/api/todos", async (c) => {
  const { rows } = await pool.query("SELECT * FROM todos ORDER BY created_at DESC");
  return c.json(rows);
});

app.post("/api/todos", async (c) => {
  const { text } = await c.req.json();
  if (!text?.trim()) return c.json({ error: "text is required" }, 400);
  const { rows } = await pool.query(
    "INSERT INTO todos (text) VALUES ($1) RETURNING *",
    [text.trim()]
  );
  return c.json(rows[0], 201);
});

app.patch("/api/todos/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (body.text !== undefined) { sets.push(`text = $${i++}`); vals.push(body.text); }
  if (body.completed !== undefined) { sets.push(`completed = $${i++}`); vals.push(body.completed); }
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE todos SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );
  if (!rows.length) return c.json({ error: "not found" }, 404);
  return c.json(rows[0]);
});

app.delete("/api/todos/:id", async (c) => {
  const id = c.req.param("id");
  const { rowCount } = await pool.query("DELETE FROM todos WHERE id = $1", [id]);
  if (!rowCount) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

const port = parseInt(process.env.PORT || "3001");

initDb().then(() => {
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Backend running on port ${port}`);
  });
});
