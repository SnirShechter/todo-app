import { Hono } from "hono";
import { cors } from "hono/cors";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { serve } from "@hono/node-server";
import * as jose from "jose";
import pg from "pg";

const { Pool } = pg;

// ── Config ──────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const OIDC_ISSUER = process.env.OIDC_ISSUER || "https://auth.snir.sh/application/o/todo-app/";
const CLIENT_ID = process.env.OIDC_CLIENT_ID || "";
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.OIDC_REDIRECT_URI || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-in-production";
const APP_URL = process.env.APP_URL || "https://todo.snir.sh";

const sessionKey = new TextEncoder().encode(SESSION_SECRET);

// ── OIDC Discovery (cached) ────────────────────────────────
let oidcConfig: any = null;
let jwks: jose.JSONWebKeySet | null = null;

async function getOIDCConfig() {
  if (!oidcConfig) {
    const res = await fetch(`${OIDC_ISSUER}.well-known/openid-configuration`);
    oidcConfig = await res.json();
  }
  return oidcConfig;
}

async function getJWKS() {
  if (!jwks) {
    const config = await getOIDCConfig();
    const res = await fetch(config.jwks_uri);
    jwks = await res.json();
  }
  return jose.createLocalJWKSet(jwks as jose.JSONWebKeySet);
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

app.use("/*", cors());

// ── Auth helpers ────────────────────────────────────────────
async function getSession(c: any) {
  const token = getCookie(c, "session");
  if (!token) return null;
  try {
    const { payload } = await jose.jwtVerify(token, sessionKey);
    return payload as { sub: string; email: string; name: string };
  } catch {
    return null;
  }
}

// Auth middleware — protects routes that need a logged-in user
async function requireAuth(c: any, next: () => Promise<void>) {
  const user = await getSession(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  return next();
}

// ── Auth routes ─────────────────────────────────────────────

// GET /api/auth/me — return current user (or 401)
app.get("/api/auth/me", async (c) => {
  const user = await getSession(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  return c.json({ sub: user.sub, email: user.email, name: user.name });
});

// GET /api/auth/login — redirect to Authentik
app.get("/api/auth/login", async (c) => {
  const config = await getOIDCConfig();
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();

  // Store state + nonce in short-lived cookies
  const cookieOpts = { httpOnly: true, secure: true, sameSite: "Lax" as const, maxAge: 300, path: "/" };
  setCookie(c, "auth_state", state, cookieOpts);
  setCookie(c, "auth_nonce", nonce, cookieOpts);

  const url = new URL(config.authorization_endpoint);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);

  return c.redirect(url.toString());
});

// GET /api/auth/callback — exchange code for tokens, set session
app.get("/api/auth/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  if (error) {
    console.error("OIDC error:", error, c.req.query("error_description"));
    return c.redirect(`${APP_URL}?error=${error}`);
  }

  // Verify state
  const storedState = getCookie(c, "auth_state");
  const storedNonce = getCookie(c, "auth_nonce");
  if (!state || state !== storedState) {
    return c.text("Invalid state parameter", 400);
  }

  // Exchange authorization code for tokens
  const config = await getOIDCConfig();
  const tokenRes = await fetch(config.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error("Token exchange failed:", err);
    return c.text("Token exchange failed", 500);
  }

  const tokens = await tokenRes.json();

  // Verify ID token signature + claims
  const jwks = await getJWKS();
  let idToken: jose.JWTPayload;
  try {
    const result = await jose.jwtVerify(tokens.id_token, jwks, {
      issuer: OIDC_ISSUER,
      audience: CLIENT_ID,
    });
    idToken = result.payload;
  } catch (e) {
    console.error("ID token verification failed:", e);
    return c.text("ID token verification failed", 400);
  }

  // Verify nonce
  if (storedNonce && idToken.nonce !== storedNonce) {
    return c.text("Invalid nonce", 400);
  }

  // Create session JWT (stored in httpOnly cookie)
  const session = await new jose.SignJWT({
    sub: idToken.sub as string,
    email: (idToken as any).email || "",
    name: (idToken as any).name || (idToken as any).preferred_username || "",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(sessionKey);

  setCookie(c, "session", session, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 30 * 24 * 60 * 60,
    path: "/",
  });

  // Clean up OIDC cookies
  deleteCookie(c, "auth_state", { path: "/" });
  deleteCookie(c, "auth_nonce", { path: "/" });

  return c.redirect(APP_URL);
});

// GET /api/auth/logout — clear session, redirect to Authentik logout
app.get("/api/auth/logout", async (c) => {
  const config = await getOIDCConfig();
  deleteCookie(c, "session", { path: "/" });

  const logoutUrl = new URL(config.end_session_endpoint);
  logoutUrl.searchParams.set("post_logout_redirect_uri", APP_URL);
  return c.redirect(logoutUrl.toString());
});

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
  });
});
