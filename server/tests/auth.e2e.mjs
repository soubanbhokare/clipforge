// CLIPFORGE Phase 2 — auth end-to-end tests.
//
// Starts the real server (tsx src/index.ts) on PORT=3101 with a temp
// SQLite database and NODE_ENV=test, then exercises the HTTP API with
// a manual cookie jar. No real credentials are used — all accounts are
// throwaway test accounts in the temp database.
//
// Run: npm run test:e2e   (from the server/ directory)

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3101;
const BASE = `http://localhost:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-e2e-"));
const dbFile = path.join(tmpDir, "test.db");
const outboxDir = path.join(serverDir, "data", "outbox");

const EMAIL = "e2e-user@example.com";
const EMAIL2 = "e2e-second@example.com";
const PASSWORD = "Str0ngPassw0rd";
const NEW_PASSWORD = "An0therStrong1";

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- tiny cookie jar ---------------------------------------------------
class Jar {
  constructor() {
    this.cookies = new Map();
  }
  absorb(res) {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of set) {
      const [pair] = line.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  set(name, value) {
    this.cookies.set(name, value);
  }
  get(name) {
    return this.cookies.get(name);
  }
}

async function call(jar, method, urlPath, { body, csrf } = {}) {
  const headers = {};
  if (jar && jar.header()) headers.Cookie = jar.header();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (csrf) headers["X-CSRF-Token"] = csrf;
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (jar) jar.absorb(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, json };
}

async function getCsrf(jar) {
  const { json } = await call(jar, "GET", "/api/auth/csrf");
  return json.csrfToken;
}

function newestOutboxToken(email, subjectFragment) {
  if (!fs.existsSync(outboxDir)) return null;
  const files = fs
    .readdirSync(outboxDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(outboxDir, file), "utf8"));
      if (data.to === email && data.subject.includes(subjectFragment)) {
        const match = String(data.text).match(/token=([A-Za-z0-9\-._~]+)/);
        if (match) return decodeURIComponent(match[1]);
      }
    } catch {
      /* skip malformed */
    }
  }
  return null;
}

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(proc) {
  for (let i = 0; i < 60; i += 1) {
    if (proc.exitCode !== null) throw new Error(`server exited early with ${proc.exitCode}`);
    try {
      const res = await fetch(`${BASE}/api/auth/config`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("server did not start in time");
}

async function main() {
  const proc = spawn(path.join(serverDir, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "test",
      DATABASE_FILE: dbFile,
      LOGIN_RATE_MAX: "5",
      APP_BASE_URL: "http://localhost:5173",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForServer(proc);

    const configRes = await call(null, "GET", "/api/auth/config");
    check(
      "config: honest status (email/google not configured)",
      configRes.status === 200 &&
        configRes.json.emailConfigured === false &&
        configRes.json.googleConfigured === false,
      JSON.stringify(configRes.json),
    );

    const jar = new Jar();
    const csrf = await getCsrf(jar);

    // CSRF: mutation without the header must be rejected.
    const noCsrf = await call(jar, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: PASSWORD },
    });
    check("CSRF: mutation without X-CSRF-Token -> 403", noCsrf.status === 403, `got ${noCsrf.status}`);

    const registerBody = {
      displayName: "E2E User",
      email: EMAIL,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      termsAccepted: true,
    };

    // (1) Registration succeeds; account starts unverified; session opens.
    const reg = await call(jar, "POST", "/api/auth/register", { body: registerBody, csrf });
    check(
      "1. register ok (201, unverified user, session cookie)",
      reg.status === 201 &&
        reg.json.user?.email === EMAIL &&
        reg.json.user?.emailVerified === false &&
        Boolean(jar.get("cf_session")),
      `status=${reg.status} body=${JSON.stringify(reg.json)}`,
    );

    const mePre = await call(jar, "GET", "/api/auth/me");
    check(
      "1b. /me after register: 200, emailVerified=false",
      mePre.status === 200 && mePre.json.user?.emailVerified === false,
      `status=${mePre.status}`,
    );

    // (2) Duplicate email -> 409.
    const jarDup = new Jar();
    const csrfDup = await getCsrf(jarDup);
    const dup = await call(jarDup, "POST", "/api/auth/register", { body: registerBody, csrf: csrfDup });
    check("2. duplicate email -> 409", dup.status === 409, `got ${dup.status}`);

    // (3) Invalid email -> 400.
    const badEmail = await call(jarDup, "POST", "/api/auth/register", {
      body: { ...registerBody, email: "not-an-email" },
      csrf: csrfDup,
    });
    check("3. invalid email -> 400", badEmail.status === 400, `got ${badEmail.status}`);

    // (4) Weak password -> 400.
    const weak = await call(jarDup, "POST", "/api/auth/register", {
      body: { ...registerBody, email: "weak@example.com", password: "weak", confirmPassword: "weak" },
      csrf: csrfDup,
    });
    check("4. weak password -> 400", weak.status === 400, `got ${weak.status}`);

    // (5) Password mismatch -> 400.
    const mismatch = await call(jarDup, "POST", "/api/auth/register", {
      body: { ...registerBody, email: "mismatch@example.com", confirmPassword: `${PASSWORD}x` },
      csrf: csrfDup,
    });
    check("5. password mismatch -> 400", mismatch.status === 400, `got ${mismatch.status}`);

    // (5b) Terms not accepted -> 400.
    const noTerms = await call(jarDup, "POST", "/api/auth/register", {
      body: { ...registerBody, email: "terms@example.com", termsAccepted: false },
      csrf: csrfDup,
    });
    check("5b. terms not accepted -> 400", noTerms.status === 400, `got ${noTerms.status}`);

    // Resend verification (authenticated, real endpoint).
    const resend = await call(jar, "POST", "/api/auth/resend-verification", { body: {}, csrf });
    check("resend-verification (auth) -> 200", resend.status === 200, `got ${resend.status}`);
    const resendAnon = await call(jarDup, "POST", "/api/auth/resend-verification", {
      body: {},
      csrf: csrfDup,
    });
    check("resend-verification (anonymous) -> 401", resendAnon.status === 401, `got ${resendAnon.status}`);

    // (13) Email verification via the outbox token.
    const verifyToken = newestOutboxToken(EMAIL, "Verify your CLIPFORGE email");
    check("13a. verification token delivered to outbox", Boolean(verifyToken));
    const verify = await call(jar, "POST", "/api/auth/verify-email", {
      body: { token: verifyToken },
      csrf,
    });
    check("13b. verify-email -> 200", verify.status === 200, `got ${verify.status}`);
    const meVerified = await call(jar, "GET", "/api/auth/me");
    check(
      "13c. /me after verify: emailVerified=true",
      meVerified.status === 200 && meVerified.json.user?.emailVerified === true,
      `status=${meVerified.status}`,
    );
    const verifyReuse = await call(jar, "POST", "/api/auth/verify-email", {
      body: { token: verifyToken },
      csrf,
    });
    check("13d. verification token reuse -> 400", verifyReuse.status === 400, `got ${verifyReuse.status}`);

    // (8) Logout revokes the session.
    const logout = await call(jar, "POST", "/api/auth/logout", { body: {}, csrf });
    const meAfterLogout = await call(jar, "GET", "/api/auth/me");
    check(
      "8. logout -> 200 and /me afterwards -> 401",
      logout.status === 200 && meAfterLogout.status === 401,
      `logout=${logout.status} me=${meAfterLogout.status}`,
    );

    // (7) Wrong password -> generic 401.
    const wrong = await call(jar, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: "Wr0ngPassword1" },
      csrf,
    });
    check(
      "7. wrong password -> 401 generic message",
      wrong.status === 401 && wrong.json?.error === "Invalid email or password.",
      `status=${wrong.status} body=${JSON.stringify(wrong.json)}`,
    );

    // (6) Correct login.
    const login = await call(jar, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: PASSWORD, rememberMe: false },
      csrf,
    });
    const meLogin = await call(jar, "GET", "/api/auth/me");
    check(
      "6. correct login -> 200 and /me -> 200",
      login.status === 200 && meLogin.status === 200 && meLogin.json.user?.email === EMAIL,
      `login=${login.status} me=${meLogin.status}`,
    );

    // (9) Session restoration: a brand-new request with only the
    // cookie (what a browser refresh does) still authenticates.
    const jarRefresh = new Jar();
    jarRefresh.set("cf_session", jar.get("cf_session"));
    const meRefresh = await call(jarRefresh, "GET", "/api/auth/me");
    check(
      "9. session restoration after refresh -> /me 200",
      meRefresh.status === 200 && meRefresh.json.user?.email === EMAIL,
      `got ${meRefresh.status}`,
    );

    // (10) Protected endpoint without a session.
    const meAnon = await call(null, "GET", "/api/auth/me");
    check("10. /me without cookie -> 401", meAnon.status === 401, `got ${meAnon.status}`);

    // (17) Garbage session cookie.
    const jarGarbage = new Jar();
    jarGarbage.set("cf_session", "garbage-token-that-does-not-exist");
    const meGarbage = await call(jarGarbage, "GET", "/api/auth/me");
    check("17. invalid session cookie -> 401", meGarbage.status === 401, `got ${meGarbage.status}`);

    // (14) Password reset flow.
    const forgot = await call(jar, "POST", "/api/auth/forgot-password", {
      body: { email: EMAIL },
      csrf,
    });
    const forgotGhost = await call(jar, "POST", "/api/auth/forgot-password", {
      body: { email: "ghost@example.com" },
      csrf,
    });
    check(
      "14a. forgot-password generic 200 for existing AND unknown email",
      forgot.status === 200 &&
        forgotGhost.status === 200 &&
        forgot.json?.message === forgotGhost.json?.message,
      `existing=${forgot.status} ghost=${forgotGhost.status}`,
    );
    const resetToken = newestOutboxToken(EMAIL, "Reset your CLIPFORGE password");
    check("14b. reset token delivered to outbox", Boolean(resetToken));
    const reset = await call(jar, "POST", "/api/auth/reset-password", {
      body: { token: resetToken, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
      csrf,
    });
    check("14c. reset-password -> 200", reset.status === 200, `got ${reset.status}`);
    const meAfterReset = await call(jar, "GET", "/api/auth/me");
    check(
      "14d. reset revokes existing sessions -> /me 401",
      meAfterReset.status === 401,
      `got ${meAfterReset.status}`,
    );
    const loginOld = await call(jar, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: PASSWORD },
      csrf,
    });
    const loginNew = await call(jar, "POST", "/api/auth/login", {
      body: { email: EMAIL, password: NEW_PASSWORD },
      csrf,
    });
    check(
      "14e. old password -> 401, new password -> 200",
      loginOld.status === 401 && loginNew.status === 200,
      `old=${loginOld.status} new=${loginNew.status}`,
    );

    // (15) Expired reset token: request a new one, then force its
    // expiry into the past directly in the temp database.
    await call(jar, "POST", "/api/auth/forgot-password", { body: { email: EMAIL }, csrf });
    const expiringToken = newestOutboxToken(EMAIL, "Reset your CLIPFORGE password");
    const db = new DatabaseSync(dbFile);
    db.prepare("UPDATE password_reset_tokens SET expires_at = ? WHERE hashed_token = ?").run(
      new Date(Date.now() - 60_000).toISOString(),
      sha256(expiringToken),
    );
    db.close();
    const resetExpired = await call(jar, "POST", "/api/auth/reset-password", {
      body: { token: expiringToken, newPassword: "YetAn0therPass1", confirmPassword: "YetAn0therPass1" },
      csrf,
    });
    check("15. expired reset token -> 400", resetExpired.status === 400, `got ${resetExpired.status}`);

    // (16) Login rate limiting (LOGIN_RATE_MAX=5 in this test env):
    // attempts 1-5 are 401s, the 6th must be 429.
    const jar2 = new Jar();
    const csrf2 = await getCsrf(jar2);
    await call(jar2, "POST", "/api/auth/register", {
      body: {
        displayName: "Second User",
        email: EMAIL2,
        password: PASSWORD,
        confirmPassword: PASSWORD,
        termsAccepted: true,
      },
      csrf: csrf2,
    });
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const attempt = await call(jar2, "POST", "/api/auth/login", {
        body: { email: EMAIL2, password: "Wr0ngPassword9" },
        csrf: csrf2,
      });
      statuses.push(attempt.status);
    }
    check(
      "16. login rate limit: 5x401 then 429",
      statuses.slice(0, 5).every((s) => s === 401) && statuses[5] === 429,
      `statuses=${statuses.join(",")}`,
    );

    // (11) Guest mode is a frontend-only flag (sessionStorage
    // cf_guest): by itself it creates NO server session. A request
    // carrying only a guest marker is still anonymous to the API.
    const jarGuest = new Jar();
    jarGuest.set("cf_guest", "1");
    const meGuest = await call(jarGuest, "GET", "/api/auth/me");
    check(
      "11. guest flag alone grants no server session -> /me 401",
      meGuest.status === 401,
      `got ${meGuest.status}`,
    );

    // (12) Guests cannot create projects: a valid CSRF pair but no
    // session cookie must still be rejected by requireAuth.
    const guestCsrf = await getCsrf(jarGuest);
    const guestProject = await call(jarGuest, "POST", "/api/projects", {
      body: { name: "Guest project" },
      csrf: guestCsrf,
    });
    check(
      "12. guest cannot create projects -> POST /api/projects 401",
      guestProject.status === 401,
      `got ${guestProject.status}`,
    );

    // (18–20) Preservation checks: the landing page, the asset map,
    // the approved logo and the auth honesty copy are guarded here so
    // a future change cannot silently break the standing rules. These
    // read the real frontend files from disk — no server involved.
    const rootDir = path.resolve(serverDir, "..");
    const readSrc = (rel) => fs.readFileSync(path.join(rootDir, rel), "utf8");

    // (18) Landing: zero <img>/<video> in HomePage + landing components.
    const landingFiles = [
      "src/pages/HomePage.tsx",
      ...fs
        .readdirSync(path.join(rootDir, "src/components/landing"))
        .filter((f) => f.endsWith(".tsx"))
        .map((f) => `src/components/landing/${f}`),
    ];
    const mediaOffenders = landingFiles.filter((rel) => /<img[\s>]|<video[\s>]/.test(readSrc(rel)));
    check(
      "18. preservation: landing has zero <img>/<video> (HomePage + landing components)",
      mediaOffenders.length === 0,
      mediaOffenders.join(", "),
    );

    // (19a) landingAssets.ts still defines exactly 40 slots.
    const assetsText = readSrc("src/config/landingAssets.ts");
    const slotCount = (assetsText.match(/^ {2}"[a-z0-9-]+": \{/gm) ?? []).length;
    check(
      "19a. preservation: landingAssets.ts still defines 40 slots",
      slotCount === 40,
      `counted ${slotCount}`,
    );

    // (19b) The approved logo file still carries the owner's gradient.
    const logoSvg = readSrc("public/assets/clipforge-logo.svg");
    check(
      "19b. preservation: approved logo keeps owner gradient #0860E9",
      logoSvg.includes("#0860E9"),
    );

    // (20) Auth pages still carry the Google not-configured honesty label.
    const loginText = readSrc("src/pages/auth/LoginPage.tsx");
    const signupText = readSrc("src/pages/auth/SignupPage.tsx");
    check(
      "20. preservation: auth pages keep the Google not-configured label",
      loginText.includes("Google sign-in is not configured") &&
        signupText.includes("Google sign-in is not configured"),
    );
  } finally {
    proc.kill("SIGTERM");
    await sleep(300);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("E2E suite crashed:", err);
  process.exit(1);
});
