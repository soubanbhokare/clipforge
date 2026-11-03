// Typed client for the Phase 2 auth API (server: /api/auth).
//
// - Every request sends credentials so the HttpOnly session cookie
//   rides along. No tokens or passwords are ever stored in web
//   storage by this client (or anywhere in the frontend).
// - Mutations use the CSRF double-submit pattern: the token is fetched
//   from GET /auth/csrf, kept in memory only, and echoed back in the
//   X-CSRF-Token header.
// - Failures are classified so the UI can be honest: "credentials"
//   (401 from login), "network" (server unreachable), "server"
//   (unexpected status), or a field-level "validation" message from
//   the server.

import { API_BASE_URL } from "./api";

export interface AuthUser {
  id: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  /** Phase 12: mirrors the server profile (never used as an
   *  authorization decision — the API enforces everything). */
  isAdmin: boolean;
  status: string;
  hasAvatar: boolean;
  createdAt: string;
}

/** Phase 12: login either completes or stops at an MFA challenge. */
export type LoginResult =
  | { kind: "user"; user: AuthUser }
  | { kind: "mfa"; challengeToken: string; expiresInSec: number };

export interface AuthConfig {
  emailConfigured: boolean;
  googleConfigured: boolean;
  requireEmailVerification: boolean;
}

export type AuthErrorKind = "credentials" | "network" | "server" | "validation";

export class AuthApiError extends Error {
  kind: AuthErrorKind;
  status: number;
  code?: string;

  constructor(kind: AuthErrorKind, status: number, message: string, code?: string) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

let csrfToken: string | null = null;

async function ensureCsrf(force = false): Promise<string> {
  if (csrfToken && !force) return csrfToken;
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/auth/csrf`, { credentials: "include" });
  } catch {
    throw new AuthApiError("network", 0, "Cannot reach the server. Check that the CLIPFORGE server is running, then try again.");
  }
  if (!res.ok) {
    throw new AuthApiError("server", res.status, "The server returned an unexpected response.");
  }
  const data = (await res.json()) as { csrfToken: string };
  csrfToken = data.csrfToken;
  return csrfToken;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  /** Endpoint where a 401 means "bad credentials" rather than "session gone". */
  credentialsEndpoint?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers["X-CSRF-Token"] = await ensureCsrf();

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      credentials: "include",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new AuthApiError("network", 0, "Cannot reach the server. Check that the CLIPFORGE server is running, then try again.");
  }

  // CSRF token rotated/expired — refresh once and retry.
  if (res.status === 403 && method !== "GET") {
    headers["X-CSRF-Token"] = await ensureCsrf(true);
    try {
      res = await fetch(`${API_BASE_URL}${path}`, {
        method,
        credentials: "include",
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch {
      throw new AuthApiError("network", 0, "Cannot reach the server. Check that the CLIPFORGE server is running, then try again.");
    }
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (res.status === 401) {
    // The session is gone (or the credentials were rejected); the
    // cached CSRF token belonged to that session state, so drop it
    // and let the next mutation fetch a fresh one. Navigation is
    // left to AuthContext — a 401 here is information, not a route.
    csrfToken = null;
  }

  if (!res.ok) {
    // Two server error shapes exist: the original { error: "…" }
    // string form and the Phase 7/8 { error: { code, message } }
    // object form. Understand both so honest server detail (e.g. a
    // CONFIGURATION_ERROR explanation) reaches the UI verbatim.
    const errObj = data.error as { code?: unknown; message?: unknown } | string | undefined;
    const message =
      typeof errObj === "string"
        ? errObj
        : errObj && typeof errObj === "object" && typeof errObj.message === "string"
          ? errObj.message
          : "Something went wrong.";
    const code =
      typeof data.code === "string"
        ? data.code
        : errObj && typeof errObj === "object" && typeof errObj.code === "string"
          ? errObj.code
          : undefined;
    if (res.status === 401 && options.credentialsEndpoint) {
      throw new AuthApiError("credentials", res.status, message, code);
    }
    if (res.status === 400 || res.status === 409 || res.status === 403 || res.status === 429) {
      throw new AuthApiError("validation", res.status, message, code);
    }
    if (res.status === 401) {
      throw new AuthApiError("credentials", res.status, message, code);
    }
    throw new AuthApiError("server", res.status, message, code);
  }
  return data as T;
}

export const authApi = {
  getConfig(): Promise<AuthConfig> {
    return request<AuthConfig>("/auth/config");
  },

  async getMe(): Promise<AuthUser | null> {
    try {
      const data = await request<{ user: AuthUser }>("/auth/me");
      return data.user;
    } catch (err) {
      if (err instanceof AuthApiError && err.status === 401) return null;
      throw err;
    }
  },

  async login(email: string, password: string, rememberMe: boolean): Promise<LoginResult> {
    const data = await request<{
      user?: AuthUser;
      mfaRequired?: boolean;
      challengeToken?: string;
      expiresInSec?: number;
    }>("/auth/login", {
      method: "POST",
      body: { email, password, rememberMe },
      credentialsEndpoint: true,
    });
    if (data.mfaRequired && data.challengeToken) {
      return { kind: "mfa", challengeToken: data.challengeToken, expiresInSec: data.expiresInSec ?? 300 };
    }
    if (!data.user) {
      throw new AuthApiError("server", 200, "The server returned an unexpected login response.");
    }
    return { kind: "user", user: data.user };
  },

  /** Second step of an MFA login: a TOTP code or a recovery code. */
  async loginMfa(challengeToken: string, code: string): Promise<AuthUser> {
    const data = await request<{ user: AuthUser }>("/auth/login/mfa", {
      method: "POST",
      body: { challengeToken, code },
      credentialsEndpoint: true,
    });
    return data.user;
  },

  async register(input: {
    displayName: string;
    email: string;
    password: string;
    confirmPassword: string;
    termsAccepted: boolean;
  }): Promise<{ user: AuthUser; emailVerificationRequired: boolean; emailConfigured: boolean }> {
    return request("/auth/register", { method: "POST", body: input });
  },

  async logout(): Promise<void> {
    try {
      await request("/auth/logout", { method: "POST", body: {} });
    } finally {
      // The CSRF token was issued for the session that just ended.
      clearCsrfCache();
    }
  },

  async verifyEmail(token: string): Promise<void> {
    await request("/auth/verify-email", { method: "POST", body: { token } });
  },

  async resendVerification(): Promise<{ emailConfigured: boolean }> {
    return request("/auth/resend-verification", { method: "POST", body: {} });
  },

  async forgotPassword(email: string): Promise<{ message: string; emailConfigured: boolean }> {
    return request("/auth/forgot-password", { method: "POST", body: { email } });
  },

  async resetPassword(token: string, newPassword: string, confirmPassword: string): Promise<void> {
    await request("/auth/reset-password", {
      method: "POST",
      body: { token, newPassword, confirmPassword },
    });
  },
};

/** Test hook / logout hygiene: drop the in-memory CSRF token. */
export function clearCsrfCache(): void {
  csrfToken = null;
}

// ---- Shared API plumbing for other services (Phase 3) -------------------
// services/projects.ts builds on the exact same session + CSRF
// behaviour as auth, so there is one security-critical code path.

/** Generic typed request against the API (JSON bodies). */
export function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>(path, options);
}

/** The current CSRF token (for XMLHttpRequest uploads, which cannot
 *  use the fetch helper above). Kept in memory only. */
export function fetchCsrfToken(force = false): Promise<string> {
  return ensureCsrf(force);
}
