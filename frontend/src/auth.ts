// ── OIDC + PKCE Auth Module ─────────────────────────────────
// Handles authentication directly with Authentik — no backend involvement.

const OIDC_ISSUER = "https://auth.snir.sh/application/o/todo-app/";
const CLIENT_ID = "5QFMboN9PXKIrx5X4In59wXZlv0DpUAreYes1fql";
const REDIRECT_URI = `${window.location.origin}/callback`;
const SCOPES = "openid email profile";

// ── PKCE helpers ────────────────────────────────────────────
function randomString(length: number): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

async function sha256(plain: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(plain));
}

function base64url(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function createPKCE() {
  const verifier = randomString(64);
  const challenge = base64url(await sha256(verifier));
  return { verifier, challenge };
}

// ── OIDC Discovery (cached) ────────────────────────────────
let _config: any = null;

async function getOIDCConfig() {
  if (!_config) {
    const res = await fetch(
      `${OIDC_ISSUER}.well-known/openid-configuration`
    );
    _config = await res.json();
  }
  return _config;
}

// ── Token storage (memory + sessionStorage for refresh) ─────
let _accessToken: string | null = sessionStorage.getItem("access_token");
let _refreshToken: string | null = sessionStorage.getItem("refresh_token");
let _user: { sub: string; email: string; name: string } | null = null;

function storeTokens(access: string, refresh?: string) {
  _accessToken = access;
  sessionStorage.setItem("access_token", access);
  if (refresh) {
    _refreshToken = refresh;
    sessionStorage.setItem("refresh_token", refresh);
  }
  // Decode user from access token
  try {
    const payload = JSON.parse(atob(access.split(".")[1]));
    _user = {
      sub: payload.sub || "",
      email: payload.email || "",
      name: payload.name || payload.preferred_username || "",
    };
  } catch {
    _user = null;
  }
}

function clearTokens() {
  _accessToken = null;
  _refreshToken = null;
  _user = null;
  sessionStorage.removeItem("access_token");
  sessionStorage.removeItem("refresh_token");
}

// ── Check if token is expired ──────────────────────────────
function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    // 60s buffer before actual expiry
    return payload.exp * 1000 < Date.now() + 60_000;
  } catch {
    return true;
  }
}

// ── Public API ──────────────────────────────────────────────

/** Start the login flow — redirect to Authentik */
export async function login() {
  const config = await getOIDCConfig();
  const { verifier, challenge } = await createPKCE();
  const state = randomString(32);

  // Store PKCE verifier + state for callback
  sessionStorage.setItem("pkce_verifier", verifier);
  sessionStorage.setItem("auth_state", state);

  const url = new URL(config.authorization_endpoint);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  window.location.href = url.toString();
}

/** Handle the /callback — exchange code for tokens */
export async function handleCallback(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");

  if (error) {
    console.error("OIDC error:", error, params.get("error_description"));
    return false;
  }
  if (!code) return false;

  // Verify state
  const storedState = sessionStorage.getItem("auth_state");
  if (state !== storedState) {
    console.error("State mismatch");
    return false;
  }

  const verifier = sessionStorage.getItem("pkce_verifier");
  if (!verifier) {
    console.error("No PKCE verifier found");
    return false;
  }

  // Exchange code for tokens
  const config = await getOIDCConfig();
  const res = await fetch(config.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    console.error("Token exchange failed:", await res.text());
    return false;
  }

  const tokens = await res.json();
  storeTokens(tokens.access_token, tokens.refresh_token);

  // Clean up
  sessionStorage.removeItem("pkce_verifier");
  sessionStorage.removeItem("auth_state");

  // Remove code from URL
  window.history.replaceState({}, "", "/");
  return true;
}

/** Refresh the access token using refresh_token */
async function refreshAccessToken(): Promise<boolean> {
  if (!_refreshToken) return false;

  const config = await getOIDCConfig();
  const res = await fetch(config.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: _refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!res.ok) {
    clearTokens();
    return false;
  }

  const tokens = await res.json();
  storeTokens(tokens.access_token, tokens.refresh_token);
  return true;
}

/** Get a valid access token (refreshes if needed) */
export async function getAccessToken(): Promise<string | null> {
  if (_accessToken && !isTokenExpired(_accessToken)) {
    return _accessToken;
  }

  // Try refresh
  if (_refreshToken) {
    const ok = await refreshAccessToken();
    if (ok) return _accessToken;
  }

  return null;
}

/** Get current user (from token payload) */
export function getUser() {
  if (!_accessToken) return null;
  if (isTokenExpired(_accessToken) && !_refreshToken) return null;
  return _user;
}

/** Check if user is authenticated */
export function isAuthenticated(): boolean {
  return !!_accessToken && (!isTokenExpired(_accessToken) || !!_refreshToken);
}

/** Logout — clear tokens and force re-login.
 *  Redirects to Authentik's authorize endpoint with prompt=login,
 *  which forces the login page. After login → back to todo. */
export async function logout() {
  clearTokens();
  // Redirect to authorize with prompt=login — forces Authentik to show
  // login page even if there's an active session, and redirect_uri
  // ensures the user comes back to todo after authenticating.
  const config = await getOIDCConfig();
  const { verifier, challenge } = await createPKCE();
  const state = randomString(32);

  sessionStorage.setItem("pkce_verifier", verifier);
  sessionStorage.setItem("auth_state", state);

  const url = new URL(config.authorization_endpoint);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "login");
  window.location.href = url.toString();
}

/** Initialize — check for callback or restore session */
export async function initAuth(): Promise<boolean> {
  // Are we on the callback page?
  if (window.location.pathname === "/callback") {
    return handleCallback();
  }

  // Do we have a stored token?
  if (_accessToken) {
    if (!isTokenExpired(_accessToken)) {
      // Decode user from stored token
      storeTokens(_accessToken, _refreshToken || undefined);
      return true;
    }
    // Try refresh
    if (_refreshToken) {
      return refreshAccessToken();
    }
  }

  return false;
}
