import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import * as jose from "jose";
import pg from "pg";

const { Pool } = pg;

// ── Config ──────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const OIDC_ISSUER = process.env.OIDC_ISSUER || "https://auth.snir.sh/application/o/todo-app/";
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID || "";

// ── JWKS (cached) ──────────────────────────────────────────
let jwksClient: ReturnType<typeof jose.createRemoteJWKSet> | null = null;

function getJWKS() {
  if (!jwksClient) {
    jwksClient = jose.createRemoteJWKSet(
      new URL(`${OIDC_ISSUER}jwks/`)
    );
  }
  return jwksClient;
}

// ── Database ────────────────────────────────────────────────
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

// ── App ─────────────────────────────────────────────────────
const app = new Hono();

app.use("/*", cors({
  origin: process.env.APP_URL || "https://todo.snir.sh",
  credentials: true,
}));

// ── Auth middleware ──────────────────────────────────────────
// Verifies Bearer token directly against Authentik JWKS
async function requireAuth(c: any, next: () => Promise<void>) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const token = authHeader.slice(7);
  try {
    const { payload } = await jose.jwtVerify(token, getJWKS(), {
      issuer: OIDC_ISSUER,
    });
    c.set("user", {
      sub: payload.sub,
      email: (payload as any).email || "",
      name: (payload as any).name || (payload as any).preferred_username || "",
    });
    return next();
  } catch (e: any) {
    console.error("JWT verification failed:", e.message);
    return c.json({ error: "invalid_token" }, 401);
  }
}

// ── Todo routes (protected) ─────────────────────────────────
app.get("/api/todos", requireAuth, async (c) => {
  const { rows } = await pool.query("SELECT * FROM todos ORDER BY created_at DESC");
  return c.json(rows);
});

app.post("/api/todos", requireAuth, async (c) => {
  const { text } = await c.req.json();
  if (!text?.trim()) return c.json({ error: "text is required" }, 400);
  const { rows } = await pool.query(
    "INSERT INTO todos (text) VALUES ($1) RETURNING *",
    [text.trim()]
  );
  return c.json(rows[0], 201);
});

app.patch("/api/todos/:id", requireAuth, async (c) => {
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

app.delete("/api/todos/:id", requireAuth, async (c) => {
  const id = c.req.param("id");
  const { rowCount } = await pool.query("DELETE FROM todos WHERE id = $1", [id]);
  if (!rowCount) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// ── Start ───────────────────────────────────────────────────
const port = parseInt(process.env.PORT || "3001");

initDb().then(() => {
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Backend running on port ${port}`);
    console.log(`OIDC issuer: ${OIDC_ISSUER}`);
    console.log(`Verifying JWTs against: ${OIDC_ISSUER}jwks/`);
  });
});
