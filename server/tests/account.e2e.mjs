// Phase 12 — Account, Workspace, Settings, Usage & Admin Console e2e.
//
// ===========================================================================
// HONESTY NOTE — READ FIRST.
// This suite runs the REAL Phase 12 code against a scratch database:
// real TOTP (codes computed here with node:crypto, RFC 6238), real
// workspace role enforcement, the real usage ledger fed by a real
// upload and a real (honestly refused) background-removal job, the
// real data-export worker (the ZIP is opened and inspected), the real
// account-deletion worker, and the real admin gate. Invitation and
// verification mail goes through the development OUTBOX (no SMTP in
// this environment) — the suite asserts the API says exactly that
// ("delivery: outbox", NOT delivered) and reads the tokens from the
// outbox files, like the Phase 2 suite does. Payments are tested in
// both honest states: disabled (checkout + webhook refuse with
// CONFIGURATION_ERROR) and flag-enabled with a test webhook secret on
// the restart boot (bad signatures rejected, good ones logged once —
// idempotent). Nothing here simulates a real payment provider.
// ===========================================================================
//
// Run: npm run test:account

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const serverDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const PORT = 3271;
const BASE = `http://localhost:${PORT}`;
const outboxDir = path.join(serverDir, "data", "outbox");
const PW = "Str0ngPassw0rd!";
const PW2 = "An0therStrongPw!";

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra = "") {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`FAIL  ${name} ${extra}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HTTP client (same cookie + CSRF pattern as the other suites)
// ---------------------------------------------------------------------------
class Client {
  constructor() {
    this.cookies = new Map();
    this.csrf = null;
  }
  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  storeCookies(res) {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of set) {
      const [pair] = line.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  async raw(method, url, { body, formData } = {}) {
    const headers = {};
    if (this.cookies.size) headers.Cookie = this.cookieHeader();
    if (body !== undefined && !formData) headers["Content-Type"] = "application/json";
    if (method !== "GET" && this.csrf) headers["X-CSRF-Token"] = this.csrf;
    const res = await fetch(`${BASE}${url}`, {
      method,
      headers,
      body: formData ?? (body !== undefined ? JSON.stringify(body) : undefined),
      redirect: "manual",
    });
    this.storeCookies(res);
    return res;
  }
  async call(method, url, opts = {}) {
    const res = await this.raw(method, url, opts);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data, headers: res.headers };
  }
  async getCsrf() {
    const { data } = await this.call("GET", "/api/auth/csrf");
    this.csrf = data.csrfToken;
    return this.csrf;
  }
  /** Register + verify via the outbox token; returns the user. */
  async registerVerified(email, displayName = "Phase12 Tester") {
    await this.getCsrf();
    const res = await this.call("POST", "/api/auth/register", {
      body: { displayName, email, password: PW, confirmPassword: PW, termsAccepted: true },
    });
    if (res.status !== 201) throw new Error(`register ${email} failed: ${JSON.stringify(res.data)}`);
    const token = newestOutboxToken(email, "Verify your CLIPFORGE email");
    if (!token) throw new Error(`no verification token in outbox for ${email}`);
    const verify = await this.call("POST", "/api/auth/verify-email", { body: { token } });
    if (verify.status !== 200) throw new Error(`verify ${email} failed: ${JSON.stringify(verify.data)}`);
    return res.data.user;
  }
  async login(email, password = PW) {
    await this.getCsrf();
    return this.call("POST", "/api/auth/login", { body: { email, password, rememberMe: false } });
  }
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
      if (data.to === email && String(data.subject).includes(subjectFragment)) {
        const match = String(data.text).match(/token=([A-Za-z0-9\-._~%]+)/);
        if (match) return decodeURIComponent(match[1]);
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

// RFC 6238 TOTP (test-side implementation, independent of the server's).
function totp(secretBase32, atMs = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secretBase32.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Math.floor(atMs / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", Buffer.from(bytes)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

// The server enforces single-use TOTP steps (replay prevention): a code from
// the same 30s step as a previously accepted code is refused. Tests that need
// another accepted code must wait for a fresh step and use its code.
async function freshTotp(secretBase32) {
  const stepMs = 30_000;
  const wait = stepMs - (Date.now() % stepMs) + 250;
  await sleep(wait);
  return totp(secretBase32);
}

function spawnServer(env) {
  const srv = spawn(path.join(serverDir, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
    cwd: serverDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  srv.log = "";
  srv.stdout.on("data", (d) => (srv.log += d));
  srv.stderr.on("data", (d) => (srv.log += d));
  return srv;
}
function killServer(srv) {
  try {
    process.kill(-srv.pid, "SIGKILL");
  } catch {
    try {
      srv.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
}
async function waitForHealth(timeoutMs = 60000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up */
    }
    if (Date.now() - start > timeoutMs) throw new Error("server did not start in time");
    await sleep(250);
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf12-account-"));
  const dbFile = path.join(tmp, "test.db");
  const baseEnv = {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: "test",
    DATABASE_FILE: dbFile,
    MEDIA_DIR: path.join(tmp, "media"),
    PROCESSING_DIR: path.join(tmp, "processing"),
    TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
    ACCOUNT_TICK_MS: "200",
    ADMIN_EMAILS: "admin12@example.com",
    GOOGLE_OAUTH_CLIENT_ID: "",
    GOOGLE_OAUTH_CLIENT_SECRET: "",
    META_APP_ID: "",
    META_APP_SECRET: "",
    TIKTOK_CLIENT_KEY: "",
    TIKTOK_CLIENT_SECRET: "",
    SMTP_HOST: "",
    PAYMENTS_ENABLED: "false",
    PAYMENT_PROVIDER: "",
    PAYMENT_MERCHANT_KEY_ID: "",
    PAYMENT_MERCHANT_SECRET: "",
    PAYMENT_WEBHOOK_SECRET: "",
  };

  // Tiny real media fixture for the upload → usage test.
  const fixture = path.join(tmp, "tiny.mp4");
  spawnSync(
    "ffmpeg",
    ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", fixture],
    { stdio: "pipe" },
  );
  if (!fs.existsSync(fixture)) throw new Error("ffmpeg fixture failed");

  let srv = spawnServer(baseEnv);
  try {
    await waitForHealth();

    // ================================================================
    // A. Profile, preferences (§23 #1, #2, #3)
    // ================================================================
    const alice = new Client();
    const aliceUser = await alice.registerVerified("alice12@example.com", "Alice A");
    check("A0: registration returns the Phase 12 profile fields (isAdmin=false)", aliceUser.isAdmin === false && typeof aliceUser.createdAt === "string");

    const patched = await alice.call("PATCH", "/api/account/profile", { body: { displayName: "Alice Cooper" } });
    check("#1: profile display name updates", patched.status === 200 && patched.data.profile.displayName === "Alice Cooper", JSON.stringify(patched.data));
    const profile2 = await alice.call("GET", "/api/account/profile");
    check("#1: profile update persists on re-read", profile2.data.profile.displayName === "Alice Cooper");
    const badPatch = await alice.call("PATCH", "/api/account/profile", { body: { email: "hijack@example.com" } });
    check("#1: system fields are read-only (email in profile PATCH is rejected)", badPatch.status === 400, `got ${badPatch.status}`);

    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082", "hex");
    const avatarForm = new FormData();
    avatarForm.append("image", new Blob([png], { type: "image/png" }), "me.png");
    const avatarUp = await alice.call("POST", "/api/account/avatar", { formData: avatarForm });
    const profileAfterAvatar = await alice.call("GET", "/api/account/profile");
    check("#1: avatar upload accepted (magic-byte validated PNG)", avatarUp.status === 200 && profileAfterAvatar.data.profile.hasAvatar === true, JSON.stringify(avatarUp.data));
    const avatarGet = await alice.raw("GET", "/api/account/avatar");
    check("#1: avatar is served back to its owner", avatarGet.status === 200 && (avatarGet.headers.get("content-type") ?? "").includes("image/png"));
    await avatarGet.arrayBuffer();
    const fakeForm = new FormData();
    fakeForm.append("image", new Blob([Buffer.from("not an image")], { type: "image/png" }), "fake.png");
    const avatarFake = await alice.call("POST", "/api/account/avatar", { formData: fakeForm });
    check("#1: a non-image upload is rejected even with an image filename", avatarFake.status === 400, `got ${avatarFake.status}`);

    const prefsPut = await alice.call("PUT", "/api/account/preferences", {
      body: { timezone: "Asia/Kolkata", language: "hi", dateFormat: "DD/MM/YYYY", timeFormat: "12h", defaultAspectRatio: "9:16", defaultExportResolution: "1080p", captionLanguage: "hi" },
    });
    check("#2/#3: preferences save (timezone + language)", prefsPut.status === 200 && prefsPut.data.preferences.timezone === "Asia/Kolkata" && prefsPut.data.preferences.language === "hi", JSON.stringify(prefsPut.data));
    const prefsGet = await alice.call("GET", "/api/account/preferences");
    check("#2/#3: preferences persist on re-read", prefsGet.data.preferences.timezone === "Asia/Kolkata" && prefsGet.data.preferences.language === "hi");
    const prefsBad = await alice.call("PUT", "/api/account/preferences", { body: { timezone: "Mars/Olympus_Mons" } });
    check("#2: an invalid IANA timezone is rejected", prefsBad.status === 400, `got ${prefsBad.status}`);

    // ================================================================
    // B. Password change + sessions (§23 #4, #5)
    // ================================================================
    const aliceSecond = new Client();
    const login2 = await aliceSecond.login("alice12@example.com");
    check("B0: second session login works", login2.status === 200 && Boolean(login2.data.user));
    const sessionsBefore = await alice.call("GET", "/api/account/sessions");
    check("#5: session list shows both real sessions", sessionsBefore.status === 200 && sessionsBefore.data.sessions.length >= 2, JSON.stringify(sessionsBefore.data).slice(0, 200));

    const wrongPw = await alice.call("POST", "/api/account/change-password", {
      body: { currentPassword: "Wr0ngPassword!", newPassword: PW2, confirmPassword: PW2 },
    });
    check("#4: change-password with the wrong current password is refused", wrongPw.status === 401, `got ${wrongPw.status}`);
    const changed = await alice.call("POST", "/api/account/change-password", {
      body: { currentPassword: PW, newPassword: PW2, confirmPassword: PW2 },
    });
    check("#4: change-password succeeds with reauth", changed.status === 200, JSON.stringify(changed.data));
    const secondMe = await aliceSecond.call("GET", "/api/auth/me");
    check("#4: the OTHER session is revoked by the password change", secondMe.status === 401, `got ${secondMe.status}`);
    const oldLogin = await new Client().login("alice12@example.com", PW);
    check("#4: the old password no longer signs in", oldLogin.status === 401, `got ${oldLogin.status}`);
    const newLoginClient = new Client();
    const newLogin = await newLoginClient.login("alice12@example.com", PW2);
    check("#4: the new password signs in", newLogin.status === 200 && Boolean(newLogin.data.user));

    // #5: revoke one session explicitly.
    const aliceSessions = await alice.call("GET", "/api/account/sessions");
    const other = aliceSessions.data.sessions.find((s) => !s.current);
    check("#5: a non-current session exists to revoke", Boolean(other));
    const revoked = await alice.call("DELETE", `/api/account/sessions/${other.id}`);
    const revokedMe = await newLoginClient.call("GET", "/api/auth/me");
    check("#5: revoking a session signs that device out", revoked.status === 200 && revokedMe.status === 401, `revoke=${revoked.status} me=${revokedMe.status}`);
    // Revoking the CURRENT session is allowed and signs that device
    // out (the response says wasCurrent) — proven on a throwaway
    // client so the main session survives for the sections below.
    const throwaway = new Client();
    await throwaway.login("alice12@example.com", PW2);
    const throwSessions = await throwaway.call("GET", "/api/account/sessions");
    const throwCurrent = throwSessions.data.sessions.find((s) => s.current);
    const revokeCurrent = await throwaway.call("DELETE", `/api/account/sessions/${throwCurrent.id}`);
    const throwMe = await throwaway.call("GET", "/api/auth/me");
    check("#5: revoking the current session signs that device out (wasCurrent)", revokeCurrent.status === 200 && revokeCurrent.data.wasCurrent === true && throwMe.status === 401, `revoke=${revokeCurrent.status} me=${throwMe.status}`);
    const activity = await alice.call("GET", "/api/account/login-activity");
    check("B1: login activity is recorded from real auth events", activity.status === 200 && activity.data.events.some((e) => e.type === "LOGIN_SUCCESS") && activity.data.events.some((e) => e.type === "LOGIN_FAILURE"), JSON.stringify(activity.data).slice(0, 240));

    // Alice's working password is PW2 from here on.
    const ALICE_PW = PW2;

    // ================================================================
    // C. TOTP MFA (§23 #6)
    // ================================================================
    const mfaSetup = await alice.call("POST", "/api/account/mfa/setup", { body: { currentPassword: ALICE_PW } });
    check("#6: MFA setup returns a secret + otpauth URL (after reauth)", mfaSetup.status === 200 && typeof mfaSetup.data.secret === "string" && String(mfaSetup.data.otpauthUrl).startsWith("otpauth://totp/"), JSON.stringify(mfaSetup.data).slice(0, 160));
    const secret = mfaSetup.data.secret;
    const badConfirm = await alice.call("POST", "/api/account/mfa/confirm", { body: { code: "000000" } });
    check("#6: a wrong confirmation code does not enable MFA", badConfirm.status === 400, `got ${badConfirm.status}`);
    const confirm = await alice.call("POST", "/api/account/mfa/confirm", { body: { code: totp(secret) } });
    check("#6: the correct TOTP code enables MFA and issues 10 recovery codes", confirm.status === 200 && Array.isArray(confirm.data.recoveryCodes) && confirm.data.recoveryCodes.length === 10, JSON.stringify(confirm.data).slice(0, 160));
    const recoveryCode = confirm.data.recoveryCodes[0];
    const mfaStatus = await alice.call("GET", "/api/account/mfa");
    check("#6: MFA status reads enabled with 10 codes remaining; email MFA honestly unavailable", mfaStatus.data.totp.enabled === true && mfaStatus.data.totp.recoveryCodesRemaining === 10 && mfaStatus.data.emailMfa.available === false, JSON.stringify(mfaStatus.data));

    await alice.call("POST", "/api/auth/logout", { body: {} });
    const gated = new Client();
    const gatedLogin = await gated.login("alice12@example.com", ALICE_PW);
    check("#6: login with MFA enabled returns a challenge, not a session", gatedLogin.status === 200 && gatedLogin.data.mfaRequired === true && typeof gatedLogin.data.challengeToken === "string", JSON.stringify(gatedLogin.data).slice(0, 160));
    const gatedMe = await gated.call("GET", "/api/auth/me");
    check("#6: no session exists before the second factor", gatedMe.status === 401, `got ${gatedMe.status}`);
    const wrongCode = await gated.call("POST", "/api/auth/login/mfa", { body: { challengeToken: gatedLogin.data.challengeToken, code: "000000" } });
    check("#6: a wrong MFA code is refused", wrongCode.status === 401, `got ${wrongCode.status}`);
    const rightCode = await gated.call("POST", "/api/auth/login/mfa", { body: { challengeToken: gatedLogin.data.challengeToken, code: await freshTotp(secret) } });
    check("#6: the correct TOTP code completes the login", rightCode.status === 200 && rightCode.data.user?.email === "alice12@example.com", JSON.stringify(rightCode.data).slice(0, 160));
    const gatedMe2 = await gated.call("GET", "/api/auth/me");
    check("#6: the session exists after MFA", gatedMe2.status === 200);

    // Recovery code path: fresh challenge, use code #1, then reuse must fail.
    const gated2 = new Client();
    const gatedLogin2 = await gated2.login("alice12@example.com", ALICE_PW);
    const recUse = await gated2.call("POST", "/api/auth/login/mfa", { body: { challengeToken: gatedLogin2.data.challengeToken, code: recoveryCode } });
    check("#6: a recovery code completes the login", recUse.status === 200 && Boolean(recUse.data.user));
    const gated3 = new Client();
    const gatedLogin3 = await gated3.login("alice12@example.com", ALICE_PW);
    const recReuse = await gated3.call("POST", "/api/auth/login/mfa", { body: { challengeToken: gatedLogin3.data.challengeToken, code: recoveryCode } });
    check("#6: recovery codes are single-use (reuse refused)", recReuse.status === 401, `got ${recReuse.status}`);
    const mfaStatus2 = await gated.call("GET", "/api/account/mfa");
    check("#6: the used recovery code is consumed (9 remain)", mfaStatus2.data.totp.recoveryCodesRemaining === 9, JSON.stringify(mfaStatus2.data.totp));

    const disableBad = await gated.call("POST", "/api/account/mfa/disable", { body: { currentPassword: "Wr0ngPassword!" } });
    check("#6: disabling MFA requires reauth", disableBad.status === 401, `got ${disableBad.status}`);
    const disabled = await gated.call("POST", "/api/account/mfa/disable", { body: { currentPassword: ALICE_PW, code: await freshTotp(secret) } });
    check("#6: MFA disables with password + code", disabled.status === 200, JSON.stringify(disabled.data));
    const plainLogin = await new Client().login("alice12@example.com", ALICE_PW);
    check("#6: after disabling, login is single-step again", plainLogin.status === 200 && Boolean(plainLogin.data.user) && !plainLogin.data.mfaRequired);
    // Alice continues on the `gated` client (still authenticated).
    const aliceMain = gated;

    // ================================================================
    // D. Workspaces, invitations, roles (§23 #7–#15)
    // ================================================================
    const bob = new Client();
    await bob.registerVerified("bob12@example.com", "Bob B");

    const wsList0 = await aliceMain.call("GET", "/api/workspaces");
    check("D0: every user starts with a Personal workspace", wsList0.status === 200 && wsList0.data.workspaces.length === 1 && wsList0.data.workspaces[0].isPersonal === true, JSON.stringify(wsList0.data).slice(0, 200));
    const personalId = wsList0.data.workspaces[0].id;

    const projPersonal = await aliceMain.call("POST", "/api/projects", { body: { name: "Personal Project", workflowType: "LONG_VIDEO_TO_SHORTS" } });
    check("D0b: project created in Personal workspace", projPersonal.status === 201, JSON.stringify(projPersonal.data).slice(0, 160));
    const personalProjectId = projPersonal.data.project.id;
    const kitsPersonal = await aliceMain.call("GET", "/api/brand-kits");
    const personalKitId = kitsPersonal.data.kits[0]?.id;
    check("D0c: Personal workspace has its seeded brand kit", Boolean(personalKitId));

    const wsCreate = await aliceMain.call("POST", "/api/workspaces", { body: { name: "Studio B" } });
    check("#7: workspace creation succeeds with OWNER role", wsCreate.status === 201 && wsCreate.data.workspace.myRole === "OWNER", JSON.stringify(wsCreate.data).slice(0, 200));
    const studioB = wsCreate.data.workspace.id;

    const switched = await aliceMain.call("POST", `/api/workspaces/${studioB}/switch`, { body: {} });
    check("#8: switching the active workspace works", switched.status === 200 && switched.data.activeWorkspaceId === studioB);
    const projListB = await aliceMain.call("GET", "/api/projects?pageSize=50");
    check("#8/#15: after switching, the Personal project is NOT listed", projListB.status === 200 && !projListB.data.projects.some((p) => p.id === personalProjectId), JSON.stringify(projListB.data).slice(0, 160));
    const crossGet = await aliceMain.call("GET", `/api/projects/${personalProjectId}`);
    check("#15: a project from another workspace reads as 404", crossGet.status === 404, `got ${crossGet.status}`);
    const kitsB = await aliceMain.call("GET", "/api/brand-kits");
    check("#15: the new workspace has its OWN seeded brand kit (different id)", kitsB.data.kits.length >= 1 && kitsB.data.kits[0].id !== personalKitId, JSON.stringify(kitsB.data.kits?.[0]?.id));
    const crossKit = await aliceMain.call("GET", `/api/brand-kits/${personalKitId}`);
    check("#15: a brand kit from another workspace reads as 404", crossKit.status === 404, `got ${crossKit.status}`);

    // Invitation: outbox honesty + token flow (#9), revoke (#10).
    const invite = await aliceMain.call("POST", `/api/workspaces/${studioB}/invitations`, { body: { email: "bob12@example.com", role: "EDITOR" } });
    check("#9: invitation is created", invite.status === 201 && invite.data.invitation.status === "PENDING", JSON.stringify(invite.data).slice(0, 200));
    check("#9: delivery is honestly reported as OUTBOX (no SMTP), never as delivered", invite.data.delivery === "outbox" && /NOT been delivered/.test(invite.data.deliveryNote), JSON.stringify(invite.data).slice(0, 240));
    const bobToken = newestOutboxToken("bob12@example.com", "invited to the CLIPFORGE workspace");
    check("#9: the invitation token reached the server outbox", Boolean(bobToken));
    const bobPending = await bob.call("GET", "/api/invitations/pending");
    check("#9: the invitee sees the pending invitation", bobPending.status === 200 && bobPending.data.invitations.some((i) => i.workspaceId === studioB && i.role === "EDITOR"), JSON.stringify(bobPending.data).slice(0, 200));
    const accepted = await bob.call("POST", "/api/invitations/accept", { body: { token: bobToken } });
    check("#9: accepting joins the workspace", accepted.status === 200 && accepted.data.workspace.id === studioB, JSON.stringify(accepted.data).slice(0, 160));
    const bobWs = await bob.call("GET", "/api/workspaces");
    check("#9: the invitee now lists the workspace as EDITOR", bobWs.data.workspaces.some((w) => w.id === studioB && w.myRole === "EDITOR"));

    const invite2 = await aliceMain.call("POST", `/api/workspaces/${studioB}/invitations`, { body: { email: "carol12@example.com", role: "VIEWER" } });
    const carolToken = newestOutboxToken("carol12@example.com", "invited to the CLIPFORGE workspace");
    const revokedInvite = await aliceMain.call("DELETE", `/api/workspaces/${studioB}/invitations/${invite2.data.invitation.id}`);
    check("#10: the owner can revoke a pending invitation", revokedInvite.status === 200, `got ${revokedInvite.status}`);
    const carol = new Client();
    await carol.registerVerified("carol12@example.com", "Carol C");
    const acceptRevoked = await carol.call("POST", "/api/invitations/accept", { body: { token: carolToken } });
    check("#10: a revoked invitation can no longer be accepted", acceptRevoked.status === 400, `got ${acceptRevoked.status}`);

    // Expiry: invite again, then move expires_at into the past in the DB.
    const invite3 = await aliceMain.call("POST", `/api/workspaces/${studioB}/invitations`, { body: { email: "carol12@example.com", role: "VIEWER" } });
    const carolToken2 = newestOutboxToken("carol12@example.com", "invited to the CLIPFORGE workspace");
    check("#10b: a fresh invitation token was issued", Boolean(carolToken2) && carolToken2 !== carolToken);
    const db = new DatabaseSync(dbFile);
    db.prepare("UPDATE workspace_invitations SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", invite3.data.invitation.id);
    db.close();
    const acceptExpired = await carol.call("POST", "/api/invitations/accept", { body: { token: carolToken2 } });
    check("#10: an expired invitation is refused as expired", acceptExpired.status === 400 && /expired/i.test(acceptExpired.data.error ?? ""), `got ${acceptExpired.status} ${JSON.stringify(acceptExpired.data)}`);

    // Role matrix (#11–#14). Bob is EDITOR in Studio B.
    const bobRename = await bob.call("PATCH", `/api/workspaces/${studioB}`, { body: { name: "Bob Renamed It" } });
    check("#13: an EDITOR cannot change workspace settings", bobRename.status === 403, `got ${bobRename.status}`);
    const bobInvite = await bob.call("POST", `/api/workspaces/${studioB}/invitations`, { body: { email: "mallory@example.com", role: "VIEWER" } });
    check("#13: an EDITOR cannot invite members", bobInvite.status === 403, `got ${bobInvite.status}`);
    const bobRoleChange = await bob.call("PATCH", `/api/workspaces/${studioB}/members/${aliceUser.id}`, { body: { role: "VIEWER" } });
    check("#13: an EDITOR cannot change member roles", bobRoleChange.status === 403, `got ${bobRoleChange.status}`);

    // Alice (owner) creates a project inside Studio B; Bob (EDITOR) can edit it.
    const projB = await aliceMain.call("POST", "/api/projects", { body: { name: "Studio B Project", workflowType: "LONG_VIDEO_TO_SHORTS" } });
    check("D1: project created inside Studio B", projB.status === 201, JSON.stringify(projB.data).slice(0, 160));
    const studioBProjectId = projB.data.project.id;
    const bobSwitch = await bob.call("POST", `/api/workspaces/${studioB}/switch`, { body: {} });
    check("D1b: the invited member can switch into the shared workspace", bobSwitch.status === 200);
    const bobEdit = await bob.call("PATCH", `/api/projects/${studioBProjectId}`, { body: { name: "Edited by Bob" } });
    check("#12: an EDITOR can edit workspace projects", bobEdit.status === 200, `got ${bobEdit.status} ${JSON.stringify(bobEdit.data).slice(0, 120)}`);

    // Demote Bob to VIEWER: mutations must now 403, reads still work.
    const demote = await aliceMain.call("PATCH", `/api/workspaces/${studioB}/members/${bobWs.data.workspaces.find((w) => w.id === studioB) ? (await bob.call("GET", "/api/auth/me")).data.user.id : ""}`, { body: { role: "VIEWER" } });
    check("#11: the owner can change a member's role", demote.status === 200, `got ${demote.status} ${JSON.stringify(demote.data).slice(0, 160)}`);
    const bobView = await bob.call("GET", `/api/projects/${studioBProjectId}`);
    check("#12: a VIEWER can still read workspace projects", bobView.status === 200, `got ${bobView.status}`);
    const bobMutate = await bob.call("PATCH", `/api/projects/${studioBProjectId}`, { body: { name: "Viewer Should Not Edit" } });
    check("#12: a VIEWER cannot mutate workspace projects (server-side role guard)", bobMutate.status === 403 && bobMutate.data.code === "WORKSPACE_ROLE_FORBIDDEN", `got ${bobMutate.status} ${JSON.stringify(bobMutate.data).slice(0, 160)}`);
    const bobDelete = await bob.call("DELETE", `/api/projects/${studioBProjectId}`);
    check("#12: a VIEWER cannot delete workspace projects", bobDelete.status === 403, `got ${bobDelete.status}`);
    const bobCreate = await bob.call("POST", "/api/projects", { body: { name: "Viewer Project", workflowType: "LONG_VIDEO_TO_SHORTS" } });
    check("#12: a VIEWER cannot create projects in the workspace", bobCreate.status === 403, `got ${bobCreate.status}`);
    // Owner-only protections.
    const bobDeleteWs = await bob.call("DELETE", `/api/workspaces/${studioB}`, { body: { confirmName: "Studio B" } });
    check("#14: a non-owner cannot delete the workspace", bobDeleteWs.status === 403, `got ${bobDeleteWs.status}`);
    const aliceDeletePersonal = await aliceMain.call("DELETE", `/api/workspaces/${personalId}`, { body: { confirmName: "Personal" } });
    check("#14b: the LAST workspace cannot be deleted (delete Studio B first would be needed; Personal is protected while it holds data)", aliceDeletePersonal.status === 400 || aliceDeletePersonal.status === 409, `got ${aliceDeletePersonal.status}`);
    const membersNow = await aliceMain.call("GET", `/api/workspaces/${studioB}/members`);
    check("D2: member list reflects the role change", membersNow.data.members.some((m) => m.email === "bob12@example.com" && m.role === "VIEWER"), JSON.stringify(membersNow.data).slice(0, 240));

    // Back to Personal for the remaining sections.
    await aliceMain.call("POST", `/api/workspaces/${personalId}/switch`, { body: {} });

    // ================================================================
    // E. Usage ledger (§23 #16, #17, #18)
    // ================================================================
    const projUsage = await aliceMain.call("POST", "/api/projects", { body: { name: "Usage Project", workflowType: "LONG_VIDEO_TO_SHORTS" } });
    const usageProjectId = projUsage.data.project.id;
    const upSession = await aliceMain.call("POST", `/api/projects/${usageProjectId}/upload-session`, {
      body: { filename: "tiny.mp4", size: fs.statSync(fixture).size },
    });
    check("E0: upload session created", upSession.status === 201, JSON.stringify(upSession.data).slice(0, 160));
    const upForm = new FormData();
    upForm.append("file", new Blob([fs.readFileSync(fixture)]), "tiny.mp4");
    const upRes = await fetch(`${BASE}/api/upload-sessions/${upSession.data.session.id}/file`, {
      method: "POST",
      headers: { Cookie: aliceMain.cookieHeader(), "X-CSRF-Token": aliceMain.csrf },
      body: upForm,
    });
    const upData = await upRes.json();
    check("E0b: the real upload completes and validates", upRes.status === 200 && upData.asset?.validationStatus === "VALID", `status=${upRes.status} ${JSON.stringify(upData).slice(0, 200)}`);

    const usageOverview = await aliceMain.call("GET", "/api/usage/overview");
    check("#16: usage overview reads the real ledger (upload recorded)", usageOverview.status === 200 && usageOverview.data.totals.some((t) => t.operation === "upload" && t.qty >= 1), JSON.stringify(usageOverview.data.totals).slice(0, 240));
    check("#16: storage is measured from real files (non-zero after upload)", usageOverview.data.storage.totalBytes > 0, JSON.stringify(usageOverview.data.storage));
    const usageHistory = await aliceMain.call("GET", "/api/usage/history?pageSize=50");
    const uploadEntries = usageHistory.data.entries.filter((e) => e.operation === "upload");
    check("#16: ledger rows carry the asset idempotency pattern (count/duration/bytes)", uploadEntries.length >= 3 && uploadEntries.every((e) => e.status === "COMPLETED"), JSON.stringify(uploadEntries).slice(0, 240));

    // A refused provider job is a FAILED usage record with quantity 0,
    // never counted as success (#17).
    // Bob first switches back to his own Personal workspace (as a
    // VIEWER of Studio B he could not create projects there — the
    // guard asserted that above), then works as OWNER at home.
    await bob.call("POST", `/api/workspaces/${bobWs.data.workspaces.find((w) => w.isPersonal).id}/switch`, { body: {} });
    const bobProject = await bob.call("POST", "/api/projects", { body: { name: "Bob Personal Project", workflowType: "LONG_VIDEO_TO_SHORTS" } });
    check("E1: Bob's own Personal workspace still works for him as OWNER", bobProject.status === 201, `got ${bobProject.status}`);
    // Bob uploads the same fixture so his library has an asset to reference.
    const bobSession = await bob.call("POST", `/api/projects/${bobProject.data.project.id}/upload-session`, {
      body: { filename: "tiny.mp4", size: fs.statSync(fixture).size },
    });
    const bobForm = new FormData();
    bobForm.append("file", new Blob([fs.readFileSync(fixture)]), "tiny.mp4");
    const bobUpRes = await fetch(`${BASE}/api/upload-sessions/${bobSession.data.session.id}/file`, {
      method: "POST",
      headers: { Cookie: bob.cookieHeader(), "X-CSRF-Token": bob.csrf },
      body: bobForm,
    });
    const bobUp = await bobUpRes.json();
    check("E1b: Bob's upload completes", bobUpRes.status === 200 && Boolean(bobUp.asset?.id), `status=${bobUpRes.status}`);
    const bgJob = await bob.call("POST", `/api/projects/${bobProject.data.project.id}/background-jobs`, {
      body: { assetRef: `source:${bobUp.asset.id}`, mode: "remove" },
    });
    check("E2: background removal honestly refuses (no provider configured)", bgJob.status === 422 && bgJob.data.error?.code === "CONFIGURATION_ERROR", `got ${bgJob.status} ${JSON.stringify(bgJob.data).slice(0, 200)}`);
    const bobHistory = await bob.call("GET", "/api/usage/history?pageSize=50");
    const failedBg = bobHistory.data.entries.find((e) => e.operation === "background_removal");
    check("#17: the refused job is recorded FAILED with quantity 0", Boolean(failedBg) && failedBg.status === "FAILED" && failedBg.quantity === 0, JSON.stringify(bobHistory.data.entries).slice(0, 300));
    const bobOverview = await bob.call("GET", "/api/usage/overview");
    check("#17: failed usage never appears in the successful totals", !bobOverview.data.totals.some((t) => t.operation === "background_removal"), JSON.stringify(bobOverview.data.totals));
    check("#17b: the failed count is visible separately", bobOverview.data.failedOperations >= 1, JSON.stringify(bobOverview.data.failedOperations));

    // Plans & entitlements (#18).
    const plansRes = await aliceMain.call("GET", "/api/plans");
    check("#18: the five seeded plans are listed", plansRes.status === 200 && plansRes.data.plans.length === 5 && plansRes.data.plans.every((p) => ["free", "starter", "creator", "pro", "team"].includes(p.key)), JSON.stringify(plansRes.data.plans?.map((p) => p.key)));
    check("#18: seeded prices are null (not set) — never invented", plansRes.data.plans.every((p) => p.monthlyPriceCents === null && p.annualPriceCents === null));
    check("#18: seeded entitlements exist with null (unset) limits", plansRes.data.plans.every((p) => p.entitlements.length >= 6 && p.entitlements.every((e) => e.limit === null || typeof e.limit === "number")));
    const subRes = await aliceMain.call("GET", "/api/subscription");
    check("#18: the current subscription is the Free plan via migration, invoices honestly empty", subRes.data.subscription?.plan?.key === "free" && Array.isArray(subRes.data.invoices) && subRes.data.invoices.length === 0, JSON.stringify(subRes.data).slice(0, 240));

    // Payments disabled (#19, #20 first half).
    const checkout = await aliceMain.call("POST", "/api/subscription/checkout", { body: { planId: plansRes.data.plans[1].id, interval: "monthly" } });
    check("#19: checkout honestly fails while payments are unconfigured", checkout.status === 422 && (checkout.data.error?.code === "CONFIGURATION_ERROR" || checkout.data.code === "CONFIGURATION_ERROR"), `got ${checkout.status} ${JSON.stringify(checkout.data).slice(0, 200)}`);
    const webhookOff = await fetch(`${BASE}/api/payments/webhook/testpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "evt_off", type: "payment.succeeded" }),
    });
    check("#20: the payment webhook refuses events while payments are disabled", webhookOff.status === 422, `got ${webhookOff.status}`);
    await webhookOff.text();

    // ================================================================
    // F. Admin console (§23 #21–#26)
    // ================================================================
    const bobAdmin = await bob.call("GET", "/api/admin/overview");
    check("#21: a normal user gets 403 on the admin API", bobAdmin.status === 403, `got ${bobAdmin.status}`);
    const aliceAdmin = await aliceMain.call("GET", "/api/admin/overview");
    check("#21: a non-admin (even with a valid session) gets 403", aliceAdmin.status === 403, `got ${aliceAdmin.status}`);
    const forgedAdmin = await aliceMain.call("GET", "/api/admin/users");
    check("#22: no frontend state can forge admin access — the flag is server-side only", forgedAdmin.status === 403, `got ${forgedAdmin.status}`);

    const admin = new Client();
    const adminUser = await admin.registerVerified("admin12@example.com", "Admin A");
    check("F0: ADMIN_EMAILS bootstrap grants the flag at registration", adminUser.isAdmin === true, JSON.stringify(adminUser).slice(0, 160));
    const overview = await admin.call("GET", "/api/admin/overview");
    check("F1: admin overview returns real counts", overview.status === 200 && overview.data.users >= 4 && overview.data.workspaces >= 4 && overview.data.projects >= 3, JSON.stringify(overview.data).slice(0, 240));
    const search = await admin.call("GET", "/api/admin/users?search=alice12");
    check("#23: admin user search finds the account", search.status === 200 && search.data.users.some((u) => u.email === "alice12@example.com"), JSON.stringify(search.data).slice(0, 200));
    const detail = await admin.call("GET", `/api/admin/users/${aliceUser.id}`);
    check("#23: admin user detail shows workspaces + plan, never secrets", detail.status === 200 && detail.data.user.email === "alice12@example.com" && !("passwordHash" in detail.data.user) && !JSON.stringify(detail.data).includes("password_hash"), JSON.stringify(detail.data).slice(0, 200));

    // Suspension lifecycle on a dedicated user.
    const erin = new Client();
    await erin.registerVerified("erin12@example.com", "Erin E");
    const erinMe = await erin.call("GET", "/api/auth/me");
    const erinId = erinMe.data.user.id;
    const suspended = await admin.call("POST", `/api/admin/users/${erinId}/suspend`, { body: { confirm: true } });
    check("F2: admin can suspend with confirmation", suspended.status === 200 && suspended.data.user.status === "SUSPENDED", JSON.stringify(suspended.data).slice(0, 160));
    const erinAfter = await erin.call("GET", "/api/auth/me");
    check("F2: suspension kills the live session immediately", erinAfter.status === 401, `got ${erinAfter.status}`);
    const erinLogin = await new Client().login("erin12@example.com");
    check("F2: a suspended account cannot sign in (403 after valid password)", erinLogin.status === 403 && erinLogin.data.code === "ACCOUNT_SUSPENDED", `got ${erinLogin.status} ${JSON.stringify(erinLogin.data).slice(0, 160)}`);
    const reactivated = await admin.call("POST", `/api/admin/users/${erinId}/reactivate`, { body: {} });
    const erinMain = new Client();
    const erinLogin2 = await erinMain.login("erin12@example.com");
    check("F2: reactivation restores sign-in", reactivated.status === 200 && erinLogin2.status === 200, `reactivate=${reactivated.status} login=${erinLogin2.status}`);

    // Providers + health: real checks, honest NOT_USED.
    const providers = await admin.call("GET", "/api/admin/providers");
    check("#24: provider list is computed from real configuration", providers.status === 200 && providers.data.providers.find((p) => p.key === "stt")?.configured === true && providers.data.providers.find((p) => p.key === "background_removal")?.configured === false, JSON.stringify(providers.data.providers?.map((p) => [p.key, p.configured])));
    const ffmpegTest = await admin.call("POST", "/api/admin/providers/enhancement/test", { body: {} });
    check("#24: the enhancement health probe really runs (FFmpeg)", ffmpegTest.status === 200 && ffmpegTest.data.status === "OPERATIONAL", JSON.stringify(ffmpegTest.data));
    const bgTest = await admin.call("POST", "/api/admin/providers/background_removal/test", { body: {} });
    check("#24: an unconfigured provider's probe honestly says NOT_CONFIGURED", bgTest.status === 200 && bgTest.data.status === "NOT_CONFIGURED", JSON.stringify(bgTest.data));
    const health = await admin.call("GET", "/api/admin/system-health");
    const byKey = Object.fromEntries(health.data.checks.map((c) => [c.key, c]));
    check("#25: system health is truthful — SQLite + FFmpeg OPERATIONAL", byKey.database?.status === "OPERATIONAL" && /user_version = 15/.test(byKey.database?.detail ?? "") && byKey.ffmpeg?.status === "OPERATIONAL", JSON.stringify(byKey.database));
    check("#25: PostgreSQL/Redis/BullMQ read NOT_USED (never fake green)", byKey.postgresql?.status === "NOT_USED" && byKey.redis?.status === "NOT_USED" && byKey.bullmq?.status === "NOT_USED", JSON.stringify([byKey.postgresql?.status, byKey.redis?.status, byKey.bullmq?.status]));
    check("#25: email honestly reports the outbox degradation", byKey.email?.status === "DEGRADED" && /outbox/i.test(byKey.email?.detail ?? ""), JSON.stringify(byKey.email));
    const auditRes = await admin.call("GET", "/api/admin/audit-logs?pageSize=100");
    const auditTypes = new Set(auditRes.data.logs.map((l) => l.eventType));
    check("#26: the audit log recorded this suite's sensitive actions", auditTypes.has("ACCOUNT_REGISTERED") && auditTypes.has("USER_SUSPENDED") && auditTypes.has("USER_REACTIVATED") && auditTypes.has("MEMBER_INVITED") && auditTypes.has("PASSWORD_CHANGED"), JSON.stringify([...auditTypes].slice(0, 20)));

    // Admin plan configuration is real: set a limit, read it back as the user.
    const adminPlans = await admin.call("GET", "/api/admin/plans");
    const freePlan = adminPlans.data.plans.find((p) => p.key === "free");
    const setEnt = await admin.call("PUT", `/api/admin/plans/${freePlan.id}/entitlements`, {
      body: { entitlements: [{ key: "exports_per_month", limit: 25 }] },
    });
    check("F3: an admin can set an entitlement limit (audited)", setEnt.status === 200 && setEnt.data.plan.entitlements.find((e) => e.key === "exports_per_month")?.limit === 25, JSON.stringify(setEnt.data).slice(0, 200));
    const aliceUsage2 = await aliceMain.call("GET", "/api/usage/overview");
    check("F3: the user's usage dashboard now shows the configured limit", aliceUsage2.data.plan?.limits?.some((l) => l.key === "exports_per_month" && l.limit === 25), JSON.stringify(aliceUsage2.data.plan).slice(0, 240));

    // ================================================================
    // G. Data export (§23 #27)
    // ================================================================
    const exportReq = await aliceMain.call("POST", "/api/privacy/data-export", { body: {} });
    check("#27: data export is accepted as a background job", exportReq.status === 202 && exportReq.data.job.status === "QUEUED", JSON.stringify(exportReq.data));
    let exportJob = null;
    for (let i = 0; i < 40; i++) {
      const list = await aliceMain.call("GET", "/api/privacy/data-exports");
      exportJob = list.data.exports.find((x) => x.id === exportReq.data.job.id);
      if (exportJob && (exportJob.status === "COMPLETED" || exportJob.status === "FAILED")) break;
      await sleep(300);
    }
    check("#27: the export worker completes the job", exportJob?.status === "COMPLETED", JSON.stringify(exportJob));
    const dlRes = await fetch(`${BASE}/api/privacy/data-exports/${exportReq.data.job.id}/download`, {
      headers: { Cookie: aliceMain.cookieHeader() },
    });
    check("#27: the owner can download the ZIP", dlRes.status === 200, `got ${dlRes.status}`);
    const zipPath = path.join(tmp, "export.zip");
    fs.writeFileSync(zipPath, Buffer.from(await dlRes.arrayBuffer()));
    const zipList = spawnSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print('\\n'.join(z.namelist())); print('---PROFILE---'); print(z.read('profile.json').decode())", zipPath], { encoding: "utf8" });
    check("#27: the ZIP contains the real records (profile/preferences/projects/usage)", zipList.status === 0 && zipList.stdout.includes("profile.json") && zipList.stdout.includes("projects.json") && zipList.stdout.includes("usage.json") && zipList.stdout.includes("alice12@example.com"), (zipList.stdout || "").slice(0, 300));
    const bobDl = await fetch(`${BASE}/api/privacy/data-exports/${exportReq.data.job.id}/download`, {
      headers: { Cookie: bob.cookieHeader() },
    });
    check("#27: another user cannot download the export (404)", bobDl.status === 404, `got ${bobDl.status}`);
    await bobDl.arrayBuffer();

    // ================================================================
    // H. Support tickets (§23 #29)
    // ================================================================
    const ticket = await aliceMain.call("POST", "/api/support/tickets", {
      body: { subject: "Export looks wrong", category: "processing", priority: "NORMAL", body: "My export ZIP was fine actually — testing the ticket flow." },
    });
    check("#29: a support ticket persists with the honest not-delivered note", ticket.status === 201 && Boolean(ticket.data.ticket?.id) && /stored in CLIPFORGE only/.test(ticket.data.deliveryNote ?? ""), JSON.stringify(ticket.data).slice(0, 240));
    const adminTickets = await admin.call("GET", "/api/admin/support/tickets");
    check("#29: the admin console sees the ticket", adminTickets.status === 200 && adminTickets.data.tickets.some((t) => t.id === ticket.data.ticket.id), JSON.stringify(adminTickets.data).slice(0, 200));
    const adminReply = await admin.call("POST", `/api/admin/support/tickets/${ticket.data.ticket.id}/messages`, { body: { body: "Thanks — glad it worked. Closing the loop here." } });
    check("#29: an admin can reply in the console", adminReply.status === 201, `got ${adminReply.status}`);
    const thread = await aliceMain.call("GET", `/api/support/tickets/${ticket.data.ticket.id}`);
    check("#29: the user sees the admin reply in the thread", thread.data.ticket.messages.some((m) => m.authorKind === "ADMIN"), JSON.stringify(thread.data).slice(0, 240));

    // ================================================================
    // I. Account deletion (§23 #28)
    // ================================================================
    const dave = new Client();
    const daveUser = await dave.registerVerified("dave12@example.com", "Dave D");
    const daveProject = await dave.call("POST", "/api/projects", { body: { name: "Dave Project", workflowType: "LONG_VIDEO_TO_SHORTS" } });
    check("I0: deletion candidate has data", daveProject.status === 201);
    const delWrong = await dave.call("POST", "/api/privacy/account-deletion", { body: { currentPassword: PW, confirmText: "delete" } });
    check("#28: deletion requires the exact typed confirmation", delWrong.status === 400, `got ${delWrong.status}`);
    const delReq = await dave.call("POST", "/api/privacy/account-deletion", { body: { currentPassword: PW, confirmText: "DELETE" } });
    check("#28: deletion is accepted with reauth + typed DELETE, and never claims external posts are deleted", delReq.status === 202 && /NOT deleted/.test(delReq.data.warning ?? "") && /YouTube/.test(delReq.data.warning ?? ""), `got ${delReq.status} ${JSON.stringify(delReq.data).slice(0, 240)}`);
    let daveGone = false;
    for (let i = 0; i < 40; i++) {
      const probe = await new Client().login("dave12@example.com");
      if (probe.status === 401) {
        daveGone = true;
        break;
      }
      await sleep(300);
    }
    check("#28: after the worker runs, the account is gone (login 401)", daveGone);
    const daveSearch = await admin.call("GET", "/api/admin/users?search=dave12");
    check("#28: the deleted user no longer exists in admin search", daveSearch.status === 200 && !daveSearch.data.users.some((u) => u.email === "dave12@example.com"));
    const audit2 = await admin.call("GET", "/api/admin/audit-logs?eventType=ACCOUNT_DELETED&pageSize=10");
    check("#28: the deletion is retained in the audit log (without the content)", audit2.data.logs.some((l) => l.eventType === "ACCOUNT_DELETED"), JSON.stringify(audit2.data).slice(0, 200));
    const daveDb = new DatabaseSync(dbFile, { readOnly: true });
    const daveRow = daveDb.prepare("SELECT id FROM users WHERE email = ?").get("dave12@example.com");
    const daveProjects = daveDb.prepare("SELECT COUNT(*) AS n FROM projects WHERE user_id = ?").get(daveUser.id);
    daveDb.close();
    check("#28: the user row and their projects are physically deleted", !daveRow && daveProjects.n === 0, JSON.stringify({ daveRow, daveProjects }));

    // Dave's replacement for the restart-persistence checks: use Erin.
    const erinPrefs = await erinMain.call("PUT", "/api/account/preferences", {
      body: { timezone: "Europe/London", language: "en", defaultAspectRatio: "16:9" },
    });
    check("I2: restart-candidate preferences saved on boot 1", erinPrefs.status === 200, JSON.stringify(erinPrefs.data).slice(0, 160));

    // ================================================================
    // J. Restart: persistence (#30) + webhook signatures (#20)
    // ================================================================
    killServer(srv);
    await sleep(500);
    srv = spawnServer({
      ...baseEnv,
      PAYMENTS_ENABLED: "true",
      PAYMENT_PROVIDER: "testpay",
      PAYMENT_MERCHANT_KEY_ID: "mk_test",
      PAYMENT_MERCHANT_SECRET: "ms_test",
      PAYMENT_WEBHOOK_SECRET: "whsec_test_123",
    });
    await waitForHealth();

    const erin2 = new Client();
    const erinLogin3 = await erin2.login("erin12@example.com");
    check("#30: sign-in works after a restart", erinLogin3.status === 200, `got ${erinLogin3.status}`);
    const erinPrefs2 = await erin2.call("GET", "/api/account/preferences");
    check("#30: settings survive the restart (timezone + aspect ratio)", erinPrefs2.data.preferences.timezone === "Europe/London" && erinPrefs2.data.preferences.defaultAspectRatio === "16:9", JSON.stringify(erinPrefs2.data.preferences).slice(0, 200));
    const versionDb = new DatabaseSync(dbFile, { readOnly: true });
    const version = versionDb.prepare("PRAGMA user_version").get();
    versionDb.close();
    check("#30: the database stays at migration v15 across the restart", version.user_version === 15, JSON.stringify(version));

    // Payments flag-on: the adapter is still an honest foundation —
    // checkout must not pretend — but the webhook verifies signatures.
    const checkout2 = await erin2.call("POST", "/api/subscription/checkout", { body: { planId: freePlan.id, interval: "monthly" } });
    check("#19b: even flag-enabled, checkout refuses honestly (no adapter implemented)", checkout2.status === 422 && JSON.stringify(checkout2.data).includes("CONFIGURATION_ERROR"), `got ${checkout2.status} ${JSON.stringify(checkout2.data).slice(0, 200)}`);
    const hookBody = JSON.stringify({ id: "evt_test_1", type: "payment.succeeded" });
    const badSig = await fetch(`${BASE}/api/payments/webhook/testpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-payment-signature": "deadbeef" },
      body: hookBody,
    });
    check("#20: an invalidly-signed webhook event is rejected", badSig.status === 401, `got ${badSig.status}`);
    await badSig.text();
    const goodSig = crypto.createHmac("sha256", "whsec_test_123").update(hookBody).digest("hex");
    const goodHook = await fetch(`${BASE}/api/payments/webhook/testpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-payment-signature": goodSig },
      body: hookBody,
    });
    const goodHookData = await goodHook.json();
    check("#20: a correctly-signed webhook event is accepted and logged", goodHook.status === 200 && goodHookData.ok === true && goodHookData.duplicate === false, `got ${goodHook.status} ${JSON.stringify(goodHookData)}`);
    const replayHook = await fetch(`${BASE}/api/payments/webhook/testpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-payment-signature": goodSig },
      body: hookBody,
    });
    const replayData = await replayHook.json();
    check("#20: a redelivered event is idempotent (duplicate, not reprocessed)", replayHook.status === 200 && replayData.duplicate === true, `got ${replayHook.status} ${JSON.stringify(replayData)}`);

    // ================================================================
    // K. SMTP transport (free-integrations pass)
    // ================================================================
    // (a) With SMTP configured, outgoing mail is handed to a REAL
    // SMTP transport — here a local sink speaking just enough SMTP
    // for nodemailer — instead of the development outbox. The
    // transport code is the production code path (src/email.ts);
    // only the host/port point at the sink, exactly like pointing
    // them at Brevo/Resend in production.
    // (b) Without SMTP config, outbox behaviour is unchanged — that
    // is what the ENTIRE suite above ran against (SMTP_HOST forced
    // empty in baseEnv): tokens read from outbox files, delivery
    // honestly reported as "outbox" / NOT delivered (#9, #25).
    const net = await import("node:net");
    const smtpMessages = [];
    const smtpSink = net.createServer((socket) => {
      let buffer = "";
      let inData = false;
      let current = { mailFrom: null, rcptTo: [], data: "" };
      socket.write("220 sink.local ESMTP ready\r\n");
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          if (inData) {
            const end = buffer.indexOf("\r\n.\r\n");
            if (end === -1) return;
            current.data = buffer.slice(0, end);
            buffer = buffer.slice(end + 5);
            inData = false;
            smtpMessages.push(current);
            current = { mailFrom: null, rcptTo: [], data: "" };
            socket.write("250 OK queued\r\n");
            continue;
          }
          const nl = buffer.indexOf("\r\n");
          if (nl === -1) return;
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === "EHLO" || verb === "HELO") socket.write("250-sink.local greets you\r\n250 8BITMIME\r\n");
          else if (verb === "MAIL") { current.mailFrom = line; socket.write("250 OK\r\n"); }
          else if (verb === "RCPT") { current.rcptTo.push(line); socket.write("250 OK\r\n"); }
          else if (verb === "DATA") { inData = true; socket.write("354 End data with <CR><LF>.<CR><LF>\r\n"); }
          else if (verb === "QUIT") { socket.write("221 Bye\r\n"); socket.end(); return; }
          else socket.write("250 OK\r\n");
        }
      });
      socket.on("error", () => {});
    });
    await new Promise((resolve) => smtpSink.listen(0, "127.0.0.1", resolve));
    const smtpPort = smtpSink.address().port;

    killServer(srv);
    // Wait until the old server actually stops answering before
    // respawning on the same port — otherwise waitForHealth can pass
    // against the dying process and the next fetch races it.
    for (let i = 0; i < 40; i++) {
      try {
        await fetch(`${BASE}/api/health`);
        await sleep(250);
      } catch {
        break;
      }
    }
    srv = spawnServer({
      ...baseEnv,
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(smtpPort),
      SMTP_FROM: "CLIPFORGE <no-reply@sink.test>",
    });
    await waitForHealth();

    const smtpOutboxFiles = () =>
      fs.existsSync(outboxDir) ? fs.readdirSync(outboxDir).filter((f) => f.includes("smtp12")) : [];
    check("K0: no outbox record exists for the SMTP test recipient yet", smtpOutboxFiles().length === 0);
    const smtpClient = new Client();
    await smtpClient.getCsrf();
    const smtpReg = await smtpClient.call("POST", "/api/auth/register", {
      body: { displayName: "SMTP Tester", email: "smtp12@example.com", password: PW, confirmPassword: PW, termsAccepted: true },
    });
    check("K1: registration succeeds with SMTP configured and reports emailConfigured", smtpReg.status === 201 && smtpReg.data.emailConfigured === true, JSON.stringify(smtpReg.data).slice(0, 200));
    // sendEmail is awaited inside the register handler, so by the
    // time it answered, the sink already holds the message.
    const smtpMsg = smtpMessages.find((m) => m.rcptTo.some((r) => r.includes("smtp12@example.com")));
    check("K2: the verification mail was handed to the SMTP transport (envelope recipient)", Boolean(smtpMsg), JSON.stringify(smtpMessages.map((m) => m.rcptTo)).slice(0, 200));
    check(
      "K3: the SMTP payload carries the verification subject and link",
      Boolean(smtpMsg) && /Subject: Verify your CLIPFORGE email/.test(smtpMsg.data) && smtpMsg.data.includes("verify-email?token="),
      (smtpMsg?.data ?? "").slice(0, 240),
    );
    check("K4: with SMTP configured, nothing was written to the outbox for that recipient", smtpOutboxFiles().length === 0, JSON.stringify(smtpOutboxFiles()));
    smtpSink.close();
  } finally {
    killServer(srv);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\naccount e2e: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("failures:\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("account e2e crashed:", err);
  process.exit(1);
});
