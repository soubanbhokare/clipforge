// CLIPFORGE Settings (Phase 12) — every section is backed by the
// real account API: profile, preferences, security (password, MFA,
// sessions, login activity), connected accounts, notifications,
// workspaces, usage, plan, privacy and support. Nothing here stores
// state locally; what you see is what the server holds.

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import Button from "../components/Button";
import ConfirmationDialog from "../components/ConfirmationDialog";
import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import Input from "../components/Input";
import LoadingState from "../components/LoadingState";
import Select from "../components/Select";
import Tabs from "../components/Tabs";
import Textarea from "../components/Textarea";
import { useAuth } from "../features/auth/AuthContext";
import {
  accountApi,
  type AccountPreferences,
  type AccountProfile,
  type AppNotification,
  type ConnectedAccount,
  type DataExportJob,
  type LoginEvent,
  type AccountSession,
  type MfaStatus,
  type NotificationPreference,
  type Plan,
  type Subscription,
  type SupportTicket,
  type UsageOverview,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceInvitation,
} from "../services/account";
import { AuthApiError } from "../services/auth";
import { brandApi, captionsApi } from "../services/captions";
import styles from "./SettingsPage.module.css";

function errText(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (err instanceof AuthApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function Section({
  title,
  children,
  note,
}: {
  title: string;
  children: ReactNode;
  note?: string;
}) {
  return (
    <section className={styles.card}>
      <h3>{title}</h3>
      {note ? <p className={styles.muted}>{note}</p> : null}
      {children}
    </section>
  );
}

// ============================================================================
// Profile
// ============================================================================

function ProfileSection({ profile, onProfile }: { profile: AccountProfile; onProfile: (p: AccountProfile) => void }) {
  const [name, setName] = useState(profile.displayName);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [emailPw, setEmailPw] = useState("");
  const [token, setToken] = useState("");

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const { profile: p } = await accountApi.updateProfile({ displayName: name.trim() });
      onProfile(p);
      setMsg("Display name saved.");
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  const onAvatar = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await accountApi.uploadAvatar(file);
      const { profile: p } = await accountApi.getProfile();
      onProfile(p);
      setMsg("Profile photo updated.");
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  const removeAvatar = async () => {
    setBusy(true);
    setErr(null);
    try {
      await accountApi.removeAvatar();
      const { profile: p } = await accountApi.getProfile();
      onProfile(p);
      setMsg("Profile photo removed.");
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  const requestEmailChange = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      // The server answers with delivery + deliveryNote; older
      // responses carried the same text as `message`. Read both so
      // the note the user sees is always the server's real wording.
      const r = (await accountApi.requestEmailChange({ newEmail: newEmail.trim(), currentPassword: emailPw })) as {
        delivery?: string;
        deliveryNote?: string;
        message?: string;
      };
      setMsg(r.deliveryNote ?? r.message ?? "Confirmation sent — follow the link sent to the new address to complete the change.");
      setEmailPw("");
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  const confirmEmailChange = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await accountApi.confirmEmailChange(token.trim());
      onProfile(r.profile);
      setMsg("Your email address has been changed. Other sessions were signed out.");
      setToken("");
      setNewEmail("");
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Profile" note={`Account created ${fmtDate(profile.createdAt)} · Profile ${profile.profileCompletion}% complete`}>
      {err ? <p className={styles.error} role="alert">{err}</p> : null}
      {msg ? <p className={`${styles.notice} ${styles.success}`} role="status">{msg}</p> : null}
      <div className={styles.avatarRow}>
        {profile.hasAvatar ? (
          <img className={styles.avatarImg} src="/api/account/avatar" alt="Your profile" />
        ) : (
          <span className={styles.avatarFallback} aria-hidden="true">{profile.displayName.slice(0, 1).toUpperCase()}</span>
        )}
        <div className={styles.row}>
          <label>
            <span className={styles.muted}>Upload photo (PNG/JPEG/WebP/GIF, max 2 MB)</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(e) => void onAvatar(e.target.files?.[0] ?? null)}
              disabled={busy}
            />
          </label>
          {profile.hasAvatar ? (
            <Button variant="secondary" onClick={() => void removeAvatar()} disabled={busy}>Remove photo</Button>
          ) : null}
        </div>
      </div>
      <form onSubmit={saveName} className={styles.grid2}>
        <Input label="Display name" id="sp-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        <Input label="Email address" id="sp-email" value={profile.email} disabled hint="Email changes need verification — use the flow below." />
        <div>
          <Button variant="primary" type="submit" loading={busy}>Save display name</Button>
        </div>
      </form>
      <h4>Change email address</h4>
      <p className={styles.muted}>
        We send a confirmation link to the NEW address. The change only applies once that link's
        token is confirmed here, and other sessions are signed out. For privacy, the first step
        answers the same way whether or not the address is already in use.
      </p>
      <form onSubmit={requestEmailChange} className={styles.grid2}>
        <Input label="New email address" id="sp-new-email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
        <Input label="Current password" id="sp-email-pw" type="password" value={emailPw} onChange={(e) => setEmailPw(e.target.value)} autoComplete="current-password" />
        <div>
          <Button variant="secondary" type="submit" loading={busy} disabled={!newEmail.trim() || !emailPw}>Send confirmation</Button>
        </div>
      </form>
      <form onSubmit={confirmEmailChange} className={styles.grid2}>
        <Input label="Confirmation token from the email" id="sp-email-token" value={token} onChange={(e) => setToken(e.target.value)} hint="When SMTP is not configured, the message is in the server outbox instead of a real inbox." />
        <div>
          <Button variant="secondary" type="submit" loading={busy} disabled={!token.trim()}>Confirm email change</Button>
        </div>
      </form>
    </Section>
  );
}

// ============================================================================
// Security (password + MFA + login activity)
// ============================================================================

function SecuritySection() {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [mfa, setMfa] = useState<MfaStatus | null>(null);
  const [setupPw, setSetupPw] = useState("");
  const [setupData, setSetupData] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disablePw, setDisablePw] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [activity, setActivity] = useState<LoginEvent[] | null>(null);

  const [mfaErr, setMfaErr] = useState<string | null>(null);
  const [activityErr, setActivityErr] = useState<string | null>(null);

  const loadMfa = useCallback(async () => {
    try {
      setMfa(await accountApi.getMfa());
      setMfaErr(null);
    } catch (e) {
      setMfaErr(errText(e));
    }
  }, []);

  const loadActivity = useCallback(async () => {
    try {
      const r = await accountApi.loginActivity();
      setActivity(r.events);
      setActivityErr(null);
    } catch (e) {
      setActivityErr(errText(e));
    }
  }, []);

  useEffect(() => {
    void loadMfa();
    void loadActivity();
  }, [loadMfa, loadActivity]);

  const changePw = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await accountApi.changePassword({ currentPassword: cur, newPassword: next, confirmPassword: confirm });
      setMsg("Password changed. Your other sessions were signed out.");
      setCur("");
      setNext("");
      setConfirm("");
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  const startSetup = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      setSetupData(await accountApi.setupMfa({ currentPassword: setupPw }));
      setSetupPw("");
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  const confirmSetup = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await accountApi.confirmMfa({ code: confirmCode.trim() });
      setRecoveryCodes(r.recoveryCodes);
      setSetupData(null);
      setConfirmCode("");
      await loadMfa();
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  const disable = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await accountApi.disableMfa({ currentPassword: disablePw, code: disableCode.trim() || undefined });
      setMsg("Two-factor authentication is off.");
      setDisablePw("");
      setDisableCode("");
      await loadMfa();
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  const regen = async () => {
    const pw = window.prompt("Enter your current password to generate new recovery codes:");
    if (!pw) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await accountApi.regenerateRecoveryCodes({ currentPassword: pw });
      setRecoveryCodes(r.recoveryCodes);
      await loadMfa();
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Security">
      {err ? <p className={styles.error} role="alert">{err}</p> : null}
      {msg ? <p className={`${styles.notice} ${styles.success}`} role="status">{msg}</p> : null}

      <h4>Change password</h4>
      <form onSubmit={changePw} className={styles.grid2}>
        <Input label="Current password" id="sec-cur" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
        <Input label="New password (10+ characters)" id="sec-next" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        <Input label="Confirm new password" id="sec-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        <div>
          <Button variant="primary" type="submit" loading={busy} disabled={!cur || !next || !confirm}>Change password</Button>
        </div>
      </form>

      <h4>Two-factor authentication (authenticator app)</h4>
      {mfa === null && mfaErr ? (
        <div className={styles.row}>
          <p className={styles.error} role="alert">Two-factor status could not be loaded: {mfaErr}</p>
          <Button variant="ghost" onClick={() => void loadMfa()}>Retry</Button>
        </div>
      ) : mfa === null ? (
        <LoadingState message="Loading MFA status…" />
      ) : mfa.totp.enabled ? (
        <>
          <p className={styles.muted}>
            Status: <span className={styles.pill}>Enabled</span>{" "}
            {mfa.totp.confirmedAt ? `since ${fmtDate(mfa.totp.confirmedAt)} · ` : ""}
            {mfa.totp.recoveryCodesRemaining} recovery code(s) remaining. Signing in now asks for a
            code after your password.
          </p>
          <div className={styles.row}>
            <Button variant="secondary" onClick={() => void regen()} disabled={busy}>Regenerate recovery codes</Button>
          </div>
          <form onSubmit={disable} className={styles.grid2}>
            <Input label="Current password" id="mfa-disable-pw" type="password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} autoComplete="current-password" />
            <Input label="Current authenticator code (or a recovery code)" id="mfa-disable-code" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} />
            <div>
              <Button variant="secondary" type="submit" loading={busy} disabled={!disablePw}>Turn off two-factor</Button>
            </div>
          </form>
        </>
      ) : (
        <>
          <p className={styles.muted}>
            Status: <span className={styles.pill}>Off</span> — add an authenticator app (TOTP) for a
            second step at sign-in. The secret is stored encrypted on the server.
          </p>
          {!setupData ? (
            <form onSubmit={startSetup} className={styles.grid2}>
              <Input label="Current password" id="mfa-setup-pw" type="password" value={setupPw} onChange={(e) => setSetupPw(e.target.value)} autoComplete="current-password" />
              <div>
                <Button variant="primary" type="submit" loading={busy} disabled={!setupPw}>Start setup</Button>
              </div>
            </form>
          ) : (
            <>
              <p className={styles.muted}>
                Add this secret to your authenticator app (or open the otpauth link on your phone),
                then enter the 6-digit code it shows to confirm. The secret is shown only during setup.
              </p>
              <div className={styles.codeBox}>{setupData.secret}</div>
              <p className={styles.small}>{setupData.otpauthUrl}</p>
              <form onSubmit={confirmSetup} className={styles.grid2}>
                <Input label="6-digit code from the app" id="mfa-confirm-code" value={confirmCode} onChange={(e) => setConfirmCode(e.target.value)} autoComplete="one-time-code" />
                <div>
                  <Button variant="primary" type="submit" loading={busy} disabled={confirmCode.trim().length < 6}>Confirm and enable</Button>
                </div>
              </form>
            </>
          )}
        </>
      )}
      {recoveryCodes ? (
        <>
          <p className={styles.notice} role="status">
            Save these recovery codes somewhere safe — each works once, and they are shown only now.
            Anyone with a code can pass your second factor.
          </p>
          <div className={styles.codeGrid}>
            {recoveryCodes.map((c) => (
              <span key={c} className={styles.codeBox}>{c}</span>
            ))}
          </div>
          <div className={styles.row}>
            <Button variant="secondary" onClick={() => setRecoveryCodes(null)}>I saved them</Button>
          </div>
        </>
      ) : null}
      <p className={styles.small}>
        Email-based MFA: {mfa?.emailMfa.available ? "available" : `not available — ${mfa?.emailMfa.reason ?? "not configured."}`}
      </p>

      <h4>Recent login activity</h4>
      {activityErr ? (
        <div className={styles.row}>
          <p className={styles.error} role="alert">Login activity could not be loaded: {activityErr}</p>
          <Button variant="ghost" onClick={() => void loadActivity()}>Retry</Button>
        </div>
      ) : activity === null ? (
        <LoadingState message="Loading activity…" />
      ) : activity.length === 0 ? (
        <EmptyState title="No login events yet" description="Sign-ins, failures and MFA challenges will be listed here." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>Event</th><th>When</th><th>IP</th><th>Device</th></tr>
            </thead>
            <tbody>
              {activity.slice(0, 15).map((ev) => (
                <tr key={ev.id}>
                  <td>{ev.type}</td>
                  <td>{fmtDate(ev.createdAt)}</td>
                  <td>{ev.ip ?? "—"}</td>
                  <td>{ev.userAgent ? ev.userAgent.slice(0, 60) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ============================================================================
// Sessions
// ============================================================================

function SessionsSection() {
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await accountApi.listSessions();
      setSessions(r.sessions);
    } catch (e) {
      setErr(errText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: string) => {
    setBusy(true);
    setErr(null);
    try {
      await accountApi.revokeSession(id);
      setMsg("Session revoked.");
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const revokeOthers = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await accountApi.revokeOtherSessions();
      setMsg(`${r.revoked} other session(s) revoked. This session stays signed in.`);
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Sessions" note="Every browser or device currently signed in to your account. Revoking a session signs that device out immediately.">
      {err ? <p className={styles.error} role="alert">{err}</p> : null}
      {msg ? <p className={`${styles.notice} ${styles.success}`} role="status">{msg}</p> : null}
      {sessions === null ? (
        err ? (
          <Button variant="secondary" onClick={() => void load()}>Try again</Button>
        ) : (
          <LoadingState message="Loading sessions…" />
        )
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr><th>Device</th><th>IP</th><th>Signed in</th><th>Last active</th><th></th></tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{s.userAgent ? s.userAgent.slice(0, 70) : "Unknown device"} {s.current ? <span className={`${styles.pill} ${styles.pillLime}`}>This session</span> : null}</td>
                    <td>{s.ip ?? "—"}</td>
                    <td>{fmtDate(s.createdAt)}</td>
                    <td>{fmtDate(s.lastActiveAt)}</td>
                    <td>
                      {s.current ? (
                        <span className={styles.small}>current</span>
                      ) : (
                        <Button variant="ghost" onClick={() => void revoke(s.id)} disabled={busy}>Revoke</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.row}>
            <Button variant="secondary" onClick={() => void revokeOthers()} disabled={busy}>Sign out all other sessions</Button>
          </div>
        </>
      )}
    </Section>
  );
}

// ============================================================================
// Connected accounts
// ============================================================================

function ConnectedAccountsSection() {
  const [accounts, setAccounts] = useState<ConnectedAccount[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await accountApi.connectedAccounts();
      setAccounts(r.accounts);
      setErr(null);
    } catch (e) {
      setErr(errText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Section
      title="Connected accounts"
      note="Social accounts linked for publishing. Connecting and disconnecting happens in the Publishing Center — this list is the current state of those connections."
    >
      {err ? (
        <div className={styles.row}>
          <p className={styles.error} role="alert">Connected accounts could not be loaded: {err}</p>
          <Button variant="ghost" onClick={() => void load()}>Retry</Button>
        </div>
      ) : accounts === null ? (
        <LoadingState message="Loading connected accounts…" />
      ) : accounts.length === 0 ? (
        <EmptyState
          title="No accounts connected"
          description="Connect YouTube, Instagram or TikTok from the Publishing Center to publish directly. Platforms without server credentials show a not-configured state there."
        />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>Platform</th><th>Account</th><th>Status</th><th>Connected</th></tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.platform}</td>
                  <td>{a.displayName ?? "—"}</td>
                  <td><span className={styles.pill}>{a.status}</span></td>
                  <td>{fmtDate(a.connectedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className={styles.row}>
        <a href="#/publishing-queue">Open the Publishing Center</a>
      </div>
    </Section>
  );
}

// ============================================================================
// Notifications
// ============================================================================

const CATEGORY_LABELS: Record<string, string> = {
  account: "Account",
  ai_processing: "AI Processing",
  publishing: "Publishing",
  workspace: "Workspace",
};

function NotificationsSection() {
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [prefs, setPrefs] = useState<NotificationPreference[] | null>(null);
  const [emailNote, setEmailNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [n, p] = await Promise.all([
        accountApi.listNotifications(30),
        accountApi.getNotificationPreferences(),
      ]);
      setItems(n.notifications);
      setPrefs(p.preferences);
      setEmailNote(p.emailDeliveryNote);
    } catch (e) {
      setErr(errText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (category: string, field: "inApp" | "email" | "browser") => {
    setPrefs((prev) =>
      prev ? prev.map((p) => (p.category === category ? { ...p, [field]: !p[field] } : p)) : prev,
    );
  };

  const savePrefs = async () => {
    if (!prefs) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await accountApi.updateNotificationPreferences(prefs);
      setMsg("Notification preferences saved.");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const markAll = async () => {
    setBusy(true);
    try {
      await accountApi.markAllNotificationsRead();
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const markOne = async (n: AppNotification) => {
    if (n.readAt) return;
    try {
      await accountApi.markNotificationRead(n.id);
      setItems((prev) =>
        prev ? prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)) : prev,
      );
    } catch (e) {
      setErr(errText(e));
    }
  };

  const clearAll = async () => {
    setBusy(true);
    try {
      await accountApi.clearNotifications();
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Notifications" note="Notifications are generated only by real events — finished or failed jobs, publishing results and account security events.">
      {err ? <p className={styles.error} role="alert">{err}</p> : null}
      {msg ? <p className={`${styles.notice} ${styles.success}`} role="status">{msg}</p> : null}
      {items === null ? (
        err ? (
          <Button variant="secondary" onClick={() => void load()}>Try again</Button>
        ) : (
          <LoadingState message="Loading notifications…" />
        )
      ) : items.length === 0 ? (
        <EmptyState title="No notifications yet" description="When a job finishes or a security event happens, it will appear here." />
      ) : (
        <>
          <div className={styles.row}>
            <Button variant="secondary" onClick={() => void markAll()} disabled={busy}>Mark all read</Button>
            <Button variant="ghost" onClick={() => void clearAll()} disabled={busy}>Clear all</Button>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr><th>Notification</th><th>Category</th><th>When</th><th></th></tr>
              </thead>
              <tbody>
                {items.map((n) => (
                  <tr
                    key={n.id}
                    onClick={() => void markOne(n)}
                    style={!n.readAt ? { cursor: "pointer" } : undefined}
                    title={!n.readAt ? "Click to mark as read" : undefined}
                  >
                    <td>
                      <strong>{n.title}</strong>
                      {n.body ? <div className={styles.small}>{n.body}</div> : null}
                    </td>
                    <td>{CATEGORY_LABELS[n.category] ?? n.category}</td>
                    <td>{fmtDate(n.createdAt)}</td>
                    <td>{n.readAt ? <span className={styles.small}>read</span> : <span className={`${styles.pill} ${styles.pillLime}`}>new</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <h4>Channels per category</h4>
      {prefs === null ? (
        <LoadingState message="Loading preferences…" />
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr><th>Category</th><th>In-app</th><th>Email</th><th>Browser</th></tr>
              </thead>
              <tbody>
                {prefs.map((p) => (
                  <tr key={p.category}>
                    <td>{CATEGORY_LABELS[p.category] ?? p.category}</td>
                    {(["inApp", "email", "browser"] as const).map((field) => (
                      <td key={field}>
                        <input
                          type="checkbox"
                          checked={p[field]}
                          onChange={() => toggle(p.category, field)}
                          aria-label={`${CATEGORY_LABELS[p.category] ?? p.category} via ${field}`}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.small}>{emailNote}</p>
          <p className={styles.small}>
            Browser notifications are a preference only: this app does not request browser
            notification permission, so nothing is pushed to your browser today.
          </p>
          <div className={styles.row}>
            <Button variant="primary" onClick={() => void savePrefs()} loading={busy}>Save preferences</Button>
          </div>
        </>
      )}
    </Section>
  );
}

// ============================================================================
// Preferences
// ============================================================================

const TIMEZONES = [
  "UTC",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Australia/Sydney",
];

function PreferencesSection({ profile }: { profile: AccountProfile }) {
  const [prefs, setPrefs] = useState<AccountPreferences | null>(null);
  const [kits, setKits] = useState<{ id: string; name: string; isDefault: boolean }[]>([]);
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [optErr, setOptErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    accountApi.getPreferences().then((r) => setPrefs(r.preferences)).catch((e) => setErr(errText(e)));
    brandApi.listKits().then((r) => setKits(r.kits.map((k) => ({ id: k.id, name: k.name, isDefault: k.isDefault })))).catch((e) => { setKits([]); setOptErr((prev) => `${prev ? `${prev} ` : ""}Brand kits could not be loaded: ${errText(e)}`); });
    captionsApi.listTemplates().then((r) => setTemplates(r.templates.map((t) => ({ id: t.id, name: t.name })))).catch((e) => { setTemplates([]); setOptErr((prev) => `${prev ? `${prev} ` : ""}Caption templates could not be loaded: ${errText(e)}`); });
    accountApi.listWorkspaces().then((r) => setWorkspaces(r.workspaces)).catch((e) => { setWorkspaces([]); setOptErr((prev) => `${prev ? `${prev} ` : ""}Workspaces could not be loaded: ${errText(e)}`); });
  }, []);

  const set = <K extends keyof AccountPreferences>(key: K, value: AccountPreferences[K]) => {
    setPrefs((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!prefs) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await accountApi.updatePreferences(prefs);
      setPrefs(r.preferences);
      setMsg("Preferences saved on the server — they will be here when you sign in again, on any device.");
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  if (err && !prefs) return <ErrorState message={err} />;
  if (!prefs) return <LoadingState message="Loading preferences…" />;

  const tzOptions = TIMEZONES.includes(prefs.timezone)
    ? TIMEZONES
    : [prefs.timezone, ...TIMEZONES];

  return (
    <Section title="Preferences" note="Stored on the server against your account — not in this browser.">
      {err ? <p className={styles.error} role="alert">{err}</p> : null}
      {msg ? <p className={`${styles.notice} ${styles.success}`} role="status">{msg}</p> : null}
      {optErr ? <p className={styles.error} role="alert">{optErr} The affected dropdown below may be incomplete — reload the page to try again.</p> : null}
      <form onSubmit={save} className={styles.grid2}>
        <Select
          label="Language"
          id="pref-lang"
          value={prefs.language}
          onChange={(e) => set("language", e.target.value)}
          options={[
            { value: "en", label: "English" },
            { value: "hi", label: "Hindi" },
          ]}
          hint="Interface language preference (stored; full localization ships separately)."
        />
        <Select
          label="Timezone"
          id="pref-tz"
          value={prefs.timezone}
          onChange={(e) => set("timezone", e.target.value)}
          options={tzOptions.map((tz) => ({ value: tz, label: tz }))}
        />
        <Select
          label="Date format"
          id="pref-date"
          value={prefs.dateFormat}
          onChange={(e) => set("dateFormat", e.target.value)}
          options={[
            { value: "YYYY-MM-DD", label: "2026-11-02 (YYYY-MM-DD)" },
            { value: "DD/MM/YYYY", label: "02/11/2026 (DD/MM/YYYY)" },
            { value: "MM/DD/YYYY", label: "11/02/2026 (MM/DD/YYYY)" },
          ]}
        />
        <Select
          label="Time format"
          id="pref-time"
          value={prefs.timeFormat}
          onChange={(e) => set("timeFormat", e.target.value)}
          options={[
            { value: "24h", label: "24-hour" },
            { value: "12h", label: "12-hour" },
          ]}
        />
        <Select
          label="Default aspect ratio for new projects"
          id="pref-ar"
          value={prefs.defaultAspectRatio}
          onChange={(e) => set("defaultAspectRatio", e.target.value)}
          options={[
            { value: "9:16", label: "9:16 vertical" },
            { value: "16:9", label: "16:9 landscape" },
            { value: "1:1", label: "1:1 square" },
            { value: "4:5", label: "4:5 portrait" },
          ]}
        />
        <Select
          label="Default export resolution"
          id="pref-res"
          value={prefs.defaultExportResolution}
          onChange={(e) => set("defaultExportResolution", e.target.value)}
          options={["720p", "1080p", "1440p", "2160p"].map((r) => ({ value: r, label: r }))}
        />
        <Select
          label="Default caption language"
          id="pref-caplang"
          value={prefs.captionLanguage}
          onChange={(e) => set("captionLanguage", e.target.value)}
          options={[
            { value: "en", label: "English" },
            { value: "hi", label: "Hindi" },
            { value: "mr", label: "Marathi (मराठी)" },
            { value: "auto", label: "Auto-detect" },
          ]}
        />
        <Select
          label="Default caption template"
          id="pref-template"
          value={prefs.defaultCaptionTemplateId ?? ""}
          onChange={(e) => set("defaultCaptionTemplateId", e.target.value || null)}
          options={[
            { value: "", label: "No default" },
            ...templates.map((t) => ({ value: t.id, label: t.name })),
          ]}
        />
        <Select
          label="Default brand kit"
          id="pref-kit"
          value={prefs.defaultBrandKitId ?? ""}
          onChange={(e) => set("defaultBrandKitId", e.target.value || null)}
          options={[
            { value: "", label: "No default" },
            ...kits.map((k) => ({ value: k.id, label: k.name })),
          ]}
        />
        <Select
          label="Default workspace at sign-in"
          id="pref-ws"
          value={prefs.defaultWorkspaceId ?? ""}
          onChange={(e) => set("defaultWorkspaceId", e.target.value || null)}
          options={[
            { value: "", label: "Last used workspace" },
            ...workspaces.map((w) => ({ value: w.id, label: w.name })),
          ]}
          hint={`Signed in as ${profile.email}.`}
        />
        <div>
          <Button variant="primary" type="submit" loading={busy}>Save preferences</Button>
        </div>
      </form>
    </Section>
  );
}

// ============================================================================
// Workspace
// ============================================================================

function WorkspaceSection({ onSwitched }: { onSwitched: () => void }) {
  const { user } = useAuth();
  const [list, setList] = useState<Workspace[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  const [pending, setPending] = useState<WorkspaceInvitation[]>([]);
  const [newName, setNewName] = useState("");
  const [rename, setRename] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("EDITOR");
  const [tokenInput, setTokenInput] = useState("");
  const [deleteName, setDeleteName] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await accountApi.listWorkspaces();
      setList(r.workspaces);
      setActiveId(r.activeWorkspaceId);
      setSelectedId((prev) => prev ?? r.activeWorkspaceId ?? r.workspaces[0]?.id ?? null);
    } catch (e) {
      setErr(errText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = list?.find((w) => w.id === selectedId) ?? null;

  const [membersErr, setMembersErr] = useState<string | null>(null);
  const loadMembers = useCallback(async (workspaceId: string) => {
    try {
      const r = await accountApi.listMembers(workspaceId);
      setMembers(r.members);
      setPending(r.pendingInvitations);
      setMembersErr(null);
    } catch (e) {
      setMembersErr(errText(e));
    }
  }, []);

  useEffect(() => {
    if (!selected) {
      setMembers(null);
      return;
    }
    setRename(selected.name);
    void loadMembers(selected.id);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const canManage = selected ? ["OWNER", "ADMIN"].includes(selected.myRole ?? "") : false;
  const isOwner = selected?.myRole === "OWNER";

  const run = async (fn: () => Promise<void>, okMsg?: string) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await fn();
      if (okMsg) setMsg(okMsg);
      await load();
      if (selected) {
        const r = await accountApi.listMembers(selected.id);
        setMembers(r.members);
        setPending(r.pendingInvitations);
        setMembersErr(null);
      }
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      const r = await accountApi.createWorkspace({ name: newName.trim() });
      setNewName("");
      setSelectedId(r.workspace.id);
    }, "Workspace created.");
  };

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await accountApi.inviteMember(selected.id, { email: inviteEmail.trim(), role: inviteRole });
      setMsg(r.deliveryNote);
      setInviteEmail("");
      const m = await accountApi.listMembers(selected.id);
      setPending(m.pendingInvitations);
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  const acceptWithToken = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await accountApi.acceptInvitation(tokenInput.trim());
      setMsg("Invitation accepted — you are now a member of that workspace.");
      setTokenInput("");
      await load();
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  const rejectWithToken = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await accountApi.rejectInvitation(tokenInput.trim());
      if (r.ok) {
        setMsg("Invitation rejected — you have not joined that workspace.");
        setTokenInput("");
      } else {
        setErr("Invitation could not be rejected — the token may be invalid or already used.");
      }
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Workspace"
      note="Projects and brand kits belong to a workspace. The switcher in the top bar changes your active workspace; everything you see in Studio then belongs to it."
    >
      {err ? <p className={styles.error} role="alert">{err}</p> : null}
      {msg ? <p className={`${styles.notice} ${styles.success}`} role="status">{msg}</p> : null}
      {list === null ? (
        err ? (
          <Button variant="secondary" onClick={() => void load()}>Try again</Button>
        ) : (
          <LoadingState message="Loading workspaces…" />
        )
      ) : (
        <>
          <div className={styles.grid2}>
            <Select
              label="Manage workspace"
              id="ws-select"
              value={selectedId ?? ""}
              onChange={(e) => setSelectedId(e.target.value)}
              options={list.map((w) => ({
                value: w.id,
                label: `${w.name}${w.id === activeId ? " (active)" : ""}${w.status !== "ACTIVE" ? ` — ${w.status}` : ""}`,
              }))}
            />
            <form onSubmit={create}>
              <Input label="New workspace name" id="ws-new" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} />
              <Button variant="secondary" type="submit" loading={busy} disabled={!newName.trim()}>Create workspace</Button>
            </form>
          </div>

          {selected ? (
            <>
              <p className={styles.muted}>
                <strong>{selected.name}</strong> · your role: <span className={styles.pill}>{selected.myRole ?? "—"}</span>{" "}
                · {selected.memberCount} member(s) · {selected.isPersonal ? "personal workspace" : "team workspace"} · status {selected.status}
              </p>
              <div className={styles.row}>
                {selected.id !== activeId ? (
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await accountApi.switchWorkspace(selected.id);
                        onSwitched();
                      }, "Active workspace switched.")
                    }
                  >
                    Switch to this workspace
                  </Button>
                ) : null}
                <Button variant="ghost" disabled={busy} onClick={() => void run(async () => { await accountApi.setDefaultWorkspace(selected.id); }, "Set as your default workspace.")}>
                  Set as default
                </Button>
                {isOwner && selected.status === "ACTIVE" ? (
                  <Button variant="ghost" disabled={busy} onClick={() => void run(async () => { await accountApi.archiveWorkspace(selected.id); }, "Workspace archived.")}>
                    Archive
                  </Button>
                ) : null}
              </div>

              {canManage ? (
                <div className={styles.row}>
                  {selected.hasLogo ? (
                    <img src={selected.logoUrl ?? undefined} alt={`${selected.name} logo`} style={{ width: 40, height: 40, objectFit: "contain", borderRadius: 8, border: "1px solid var(--border)" }} />
                  ) : null}
                  <label>
                    <span className={styles.muted}>Workspace logo (PNG/JPEG/WebP/GIF, max 2 MB)</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      disabled={busy}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void run(async () => { await accountApi.uploadWorkspaceLogo(selected.id, f); }, "Workspace logo updated.");
                      }}
                    />
                  </label>
                </div>
              ) : null}
              {canManage ? (
                <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await accountApi.renameWorkspace(selected.id, rename.trim()); }, "Workspace renamed."); }} className={styles.grid2}>
                  <Input label="Rename workspace" id="ws-rename" value={rename} onChange={(e) => setRename(e.target.value)} maxLength={80} />
                  <div>
                    <Button variant="secondary" type="submit" loading={busy} disabled={!rename.trim() || rename.trim() === selected.name}>Rename</Button>
                  </div>
                </form>
              ) : null}

              <h4>Members</h4>
              {membersErr ? (
                <div className={styles.row}>
                  <p className={styles.error} role="alert">Members could not be loaded: {membersErr}</p>
                  <Button variant="ghost" disabled={busy} onClick={() => void loadMembers(selected.id)}>Retry</Button>
                </div>
              ) : members === null ? (
                <LoadingState message="Loading members…" />
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr><th>Member</th><th>Role</th><th>Joined</th><th></th></tr>
                    </thead>
                    <tbody>
                      {members.map((m) => (
                        <tr key={m.userId}>
                          <td>{m.displayName}<div className={styles.small}>{m.email}</div></td>
                          <td>
                            {canManage && m.role !== "OWNER" && m.userId !== user?.id ? (
                              <select
                                value={m.role}
                                disabled={busy}
                                onChange={(e) =>
                                  void run(async () => { await accountApi.changeMemberRole(selected.id, m.userId, e.target.value); }, "Role updated.")
                                }
                                aria-label={`Role for ${m.email}`}
                              >
                                {["ADMIN", "EDITOR", "VIEWER"].map((r) => (
                                  <option key={r} value={r}>{r}</option>
                                ))}
                              </select>
                            ) : (
                              <span className={styles.pill}>{m.role}</span>
                            )}
                          </td>
                          <td>{fmtDate(m.joinedAt)}</td>
                          <td>
                            {canManage && m.role !== "OWNER" ? (
                              <Button variant="ghost" disabled={busy} onClick={() => void run(async () => { await accountApi.removeMember(selected.id, m.userId); }, "Member removed.")}>
                                Remove
                              </Button>
                            ) : m.userId === user?.id && m.role !== "OWNER" ? (
                              <Button variant="ghost" disabled={busy} onClick={() => void run(async () => { await accountApi.removeMember(selected.id, m.userId); }, "You left the workspace.")}>
                                Leave
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {canManage ? (
                <>
                  <h4>Invite a member</h4>
                  <form onSubmit={invite} className={styles.grid2}>
                    <Input label="Email address" id="ws-invite-email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
                    <Select
                      label="Role"
                      id="ws-invite-role"
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value)}
                      options={["ADMIN", "EDITOR", "VIEWER"].map((r) => ({ value: r, label: r }))}
                    />
                    <div>
                      <Button variant="primary" type="submit" loading={busy} disabled={!inviteEmail.trim()}>Send invitation</Button>
                    </div>
                  </form>
                  {pending.length > 0 ? (
                    <div className={styles.tableWrap}>
                      <table className={styles.table}>
                        <thead>
                          <tr><th>Pending invitation</th><th>Role</th><th>Expires</th><th></th></tr>
                        </thead>
                        <tbody>
                          {pending.map((i) => (
                            <tr key={i.id}>
                              <td>{i.email}</td>
                              <td>{i.role}</td>
                              <td>{fmtDate(i.expiresAt)}</td>
                              <td>
                                <Button variant="ghost" disabled={busy} onClick={() => void run(async () => { await accountApi.revokeInvitation(selected.id, i.id); }, "Invitation revoked.")}>
                                  Revoke
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className={styles.small}>Only Owners and Admins can invite members or change roles. Viewers can browse; Editors can work on projects but not manage the workspace.</p>
              )}

              {isOwner ? (
                <div className={`${styles.card} ${styles.danger}`}>
                  <h4>Delete this workspace</h4>
                  <p className={styles.muted}>
                    Only possible while the workspace holds no projects or brand kits, and never for
                    your last remaining workspace. Type the workspace name to confirm.
                  </p>
                  <div className={styles.row}>
                    <Input label="Type the workspace name" id="ws-delete-name" value={deleteName} onChange={(e) => setDeleteName(e.target.value)} />
                    <Button variant="secondary" disabled={busy || deleteName !== selected.name} onClick={() => setDeleteOpen(true)}>
                      Delete workspace
                    </Button>
                  </div>
                </div>
              ) : null}
              <ConfirmationDialog
                open={deleteOpen}
                title={`Delete “${selected.name}”?`}
                message="The workspace and its memberships are removed. Projects or brand kits inside it would block this — move or delete them first."
                confirmLabel="Delete workspace"
                onConfirm={() => {
                  setDeleteOpen(false);
                  void run(async () => {
                    await accountApi.deleteWorkspace(selected.id, deleteName);
                    setSelectedId(null);
                    setDeleteName("");
                  }, "Workspace deleted.");
                }}
                onCancel={() => setDeleteOpen(false)}
              />
            </>
          ) : null}

          <h4>Accept or reject an invitation</h4>
          <p className={styles.muted}>
            Invitations arrive by email with a token. When SMTP is not configured, the message is
            written to the server outbox instead of a real inbox — paste the token from that
            message here to accept it, or reject it if you do not want to join.
          </p>
          <form onSubmit={acceptWithToken} className={styles.grid2}>
            <Input label="Invitation token" id="ws-token" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} />
            <div className={styles.row}>
              <Button variant="secondary" type="submit" loading={busy} disabled={!tokenInput.trim()}>Accept invitation</Button>
              <Button variant="ghost" type="button" disabled={busy || !tokenInput.trim()} onClick={() => void rejectWithToken()}>Reject invitation</Button>
            </div>
          </form>
        </>
      )}
    </Section>
  );
}

// ============================================================================
// Usage
// ============================================================================

const LIMIT_LABELS: Record<string, string> = {
  storage_bytes: "Storage",
  ai_processing_minutes: "AI processing",
  exports_per_month: "Exports this period",
  connected_accounts: "Connected accounts",
  team_members: "Team members",
};

function UsageSection() {
  const [data, setData] = useState<UsageOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    setErr(null);
    accountApi.usageOverview(30).then(setData).catch((e) => setErr(errText(e)));
  }, []);
  useEffect(load, [load]);
  if (err) return <ErrorState message={err} onRetry={load} />;
  if (!data) return <LoadingState message="Loading usage…" />;
  return (
    <Section title="Usage" note={`Measured from the real usage ledger and the files on disk. Updated ${fmtDate(data.lastUpdated)}.`}>
      <div className={styles.grid2}>
        <div>
          <h4>Storage</h4>
          <p className={styles.muted}>
            {fmtBytes(data.storage.totalBytes)} total — uploads {fmtBytes(data.storage.sourceBytes)},
            exports {fmtBytes(data.storage.outputBytes)}, project media {fmtBytes(data.storage.projectMediaBytes)}.
          </p>
        </div>
        <div>
          <h4>Publishing</h4>
          <p className={styles.muted}>
            {data.publishing.publishedPosts} published post(s) · {data.publishing.connectedAccounts} connected account(s).
            {data.failedOperations > 0 ? ` ${data.failedOperations} failed operation(s) are recorded with zero billed quantity.` : ""}
          </p>
        </div>
      </div>
      <h4>Activity (all time)</h4>
      {data.totals.length === 0 ? (
        <EmptyState title="No usage recorded yet" description="Uploads, analysis, renders, exports and publishes will be recorded here as they happen." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>Operation</th><th>Quantity</th><th>Events</th></tr>
            </thead>
            <tbody>
              {data.totals.map((t) => (
                <tr key={`${t.operation}-${t.unit}`}>
                  <td>{t.operation}</td>
                  <td>{t.qty} {t.unit}</td>
                  <td>{t.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h4>Plan limits</h4>
      {data.plan ? (
        data.plan.limitsConfigured || data.plan.limits.length > 0 ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr><th>Limit</th><th>Used</th><th>Limit</th><th></th></tr>
              </thead>
              <tbody>
                {data.plan.limits.map((l) => {
                  const pct = l.limit && l.used !== null ? Math.min(100, (l.used / l.limit) * 100) : 0;
                  return (
                    <tr key={l.key}>
                      <td>{LIMIT_LABELS[l.key] ?? l.key}</td>
                      <td>{l.used === null ? "—" : l.key === "storage_bytes" ? fmtBytes(l.used) : `${l.used} ${l.unit ?? ""}`}</td>
                      <td>{l.limit === null ? "Not set" : l.key === "storage_bytes" ? fmtBytes(l.limit) : l.limit}</td>
                      <td style={{ minWidth: 120 }}>
                        {l.limit ? (
                          <div className={styles.barOuter}><div className={styles.barInner} style={{ width: `${pct}%` }} /></div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.notice}>
            Your plan ({data.plan.name}) has no limits configured by an administrator yet, so no
            quotas are shown. CLIPFORGE does not invent limits.
          </p>
        )
      ) : (
        <p className={styles.muted}>No plan is assigned to your account.</p>
      )}
    </Section>
  );
}

// ============================================================================
// Plan & billing
// ============================================================================

function PlanSection() {
  const [sub, setSub] = useState<Subscription | null>(null);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([accountApi.getSubscription(), accountApi.listPlans()]);
      setSub(s);
      setPlans(p.plans);
      setNote(p.note);
    } catch (e) {
      setErr(errText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const checkout = async (planId: string) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await accountApi.checkout({ planId, interval: "monthly" });
      setMsg("Checkout completed.");
    } catch (e) {
      // The honest, expected outcome in this deployment: the server
      // answers CONFIGURATION_ERROR because no payment provider is
      // configured. Shown verbatim, never dressed up as success.
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await accountApi.requestCancellation();
      setMsg(r.note);
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (err && !sub) return <ErrorState message={err} onRetry={() => void load()} />;
  if (!sub || !plans) return <LoadingState message="Loading your plan…" />;
  const current = sub.subscription;

  return (
    <Section title="Plan & billing" note={note}>
      {err ? <p className={styles.error} role="alert">{err}</p> : null}
      {msg ? <p className={`${styles.notice} ${styles.success}`} role="status">{msg}</p> : null}
      {current ? (
        <p className={styles.muted}>
          Current plan: <strong>{current.plan.name}</strong> · status {current.status} · source {current.source}
          {current.cancelRequestedAt ? ` · cancellation requested ${fmtDate(current.cancelRequestedAt)}` : ""}
        </p>
      ) : (
        <p className={styles.muted}>No subscription record exists for your account.</p>
      )}
      {!sub.payments.enabled ? (
        <p className={styles.notice}>
          Payments are not configured on this server (missing: {sub.payments.missing.join(", ") || "provider"}).
          Checkout is disabled — no plan can be bought here until a payment provider is connected.
        </p>
      ) : null}
      <div className={styles.planGrid}>
        {plans.map((p) => (
          <div key={p.id} className={`${styles.planCard} ${current?.plan.id === p.id ? styles.planCurrent : ""}`}>
            <h4>{p.name}</h4>
            <p className={styles.price}>
              {p.monthlyPriceCents === null
                ? "Price not set"
                : `${p.currency} ${(p.monthlyPriceCents / 100).toFixed(2)} / mo`}
            </p>
            <p className={styles.small}>{p.description || "No description set."}</p>
            <ul className={styles.small} style={{ margin: 0, paddingLeft: 16 }}>
              {p.entitlements.map((e) => (
                <li key={e.key}>
                  {e.key}: {e.limit !== null ? e.limit : e.featureEnabled === null ? "not set" : e.featureEnabled ? "included" : "not included"}
                </li>
              ))}
            </ul>
            {current?.plan.id === p.id ? (
              <span className={`${styles.pill} ${styles.pillLime}`}>Current plan</span>
            ) : (
              <Button variant="secondary" disabled={busy || !sub.payments.enabled} onClick={() => void checkout(p.id)}>
                Choose {p.name}
              </Button>
            )}
          </div>
        ))}
      </div>
      {current && !current.cancelRequestedAt ? (
        <div className={styles.row}>
          <Button variant="ghost" onClick={() => void cancel()} disabled={busy}>Request cancellation</Button>
          <span className={styles.small}>Records the request and stops renewal at the provider level once payments are configured; with no provider there is nothing to charge or refund.</span>
        </div>
      ) : null}
      <h4>Invoices</h4>
      {sub.invoices.length === 0 ? (
        <EmptyState title="No invoices" description="Invoices appear only when a real payment event creates them. None exist for this account." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>Issued</th><th>Amount</th><th>Status</th></tr>
            </thead>
            <tbody>
              {sub.invoices.map((i) => (
                <tr key={i.id}>
                  <td>{fmtDate(i.issuedAt)}</td>
                  <td>{i.currency} {(i.amountCents / 100).toFixed(2)}</td>
                  <td>{i.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h4>Plan history</h4>
      {sub.history.length === 0 ? (
        <p className={styles.muted}>No plan changes recorded.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>Event</th><th>When</th></tr>
            </thead>
            <tbody>
              {sub.history.map((h) => (
                <tr key={h.id}>
                  <td>{h.type}</td>
                  <td>{fmtDate(h.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ============================================================================
// Privacy & data
// ============================================================================

function PrivacySection({ onDeleted }: { onDeleted: () => void }) {
  const [exports, setExports] = useState<DataExportJob[] | null>(null);
  const [pw, setPw] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [exportsErr, setExportsErr] = useState<string | null>(null);
  const loadExports = useCallback(async () => {
    try {
      const r = await accountApi.listDataExports();
      setExports(r.exports);
      setExportsErr(null);
    } catch (e) {
      setExportsErr(errText(e));
    }
  }, []);

  useEffect(() => {
    void loadExports();
  }, [loadExports]);

  const requestExport = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await accountApi.requestDataExport();
      setMsg("Export requested. It is prepared in the background — download it here when it completes.");
      await loadExports();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setConfirmOpen(false);
    setBusy(true);
    setErr(null);
    try {
      const r = await accountApi.requestAccountDeletion({ currentPassword: pw, confirmText });
      setMsg(`${r.warning} Your deletion request is recorded and you are being signed out now — the deletion itself completes in the background.`);
      onDeleted();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section title="Privacy & data" note="Export a copy of your data, or delete your account. Both run as background jobs on the server.">
        {err ? <p className={styles.error} role="alert">{err}</p> : null}
        {msg ? <p className={`${styles.notice} ${styles.success}`} role="status">{msg}</p> : null}
        <h4>Download your data</h4>
        <p className={styles.muted}>
          A ZIP of your profile, preferences, workspaces, project metadata, usage history,
          notifications, subscription and support tickets — your real records only.
        </p>
        <div className={styles.row}>
          <Button variant="primary" onClick={() => void requestExport()} loading={busy}>Request data export</Button>
          <Button variant="ghost" onClick={() => void loadExports()} disabled={busy}>Refresh status</Button>
        </div>
        {exportsErr ? (
          <div className={styles.row}>
            <p className={styles.error} role="alert">Your data exports could not be loaded: {exportsErr}</p>
            <Button variant="ghost" onClick={() => void loadExports()}>Retry</Button>
          </div>
        ) : exports === null ? (
          <LoadingState message="Loading exports…" />
        ) : exports.length === 0 ? (
          <p className={styles.small}>No exports requested yet.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr><th>Requested</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {exports.map((x) => (
                  <tr key={x.id}>
                    <td>{fmtDate(x.createdAt)}</td>
                    <td><span className={styles.pill}>{x.status}</span>{x.error ? <div className={styles.small}>{x.error}</div> : null}</td>
                    <td>
                      {x.downloadUrl ? (
                        <a href={x.downloadUrl}>Download ZIP</a>
                      ) : (
                        <span className={styles.small}>preparing…</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <section className={`${styles.card} ${styles.danger}`}>
        <h3>Delete account</h3>
        <p className={styles.muted}>
          This permanently deletes your account: queued jobs and scheduled posts are cancelled,
          connected platform accounts are disconnected and their tokens deleted, your media,
          projects and records are removed, and audit rows are retained without your content.
          Posts already published to YouTube, Instagram or TikTok are NOT deleted — CLIPFORGE
          cannot remove content from those platforms for you.
        </p>
        {err ? <p className={styles.error} role="alert">{err}</p> : null}
        <div className={styles.grid2}>
          <Input label="Current password" id="del-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
          <Input label="Type DELETE to confirm" id="del-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
        </div>
        <div className={styles.row}>
          <Button variant="secondary" disabled={busy || !pw || confirmText !== "DELETE"} onClick={() => setConfirmOpen(true)}>
            Delete my account
          </Button>
        </div>
        <ConfirmationDialog
          open={confirmOpen}
          title="Delete your account permanently?"
          message="This cannot be undone. Your projects, media and records are deleted; posts already live on external platforms stay there."
          confirmLabel="Delete account"
          onConfirm={() => void doDelete()}
          onCancel={() => setConfirmOpen(false)}
        />
      </section>
    </>
  );
}

// ============================================================================
// Support
// ============================================================================

function SupportSection() {
  const [tickets, setTickets] = useState<SupportTicket[] | null>(null);
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState("other");
  const [priority, setPriority] = useState("NORMAL");
  const [body, setBody] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [thread, setThread] = useState<(SupportTicket & { messages: { id: string; authorKind: string; body: string; createdAt: string }[] }) | null>(null);
  const [reply, setReply] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await accountApi.listTickets();
      setTickets(r.tickets);
    } catch (e) {
      setErr(errText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await accountApi.createTicket({ subject: subject.trim(), category, priority, body: body.trim() });
      setNote(r.deliveryNote);
      setSubject("");
      setBody("");
      await load();
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  const open = async (id: string) => {
    setOpenId(id);
    setThread(null);
    setErr(null);
    try {
      const r = await accountApi.getTicket(id);
      setThread(r.ticket);
    } catch (e) {
      setErr(errText(e));
    }
  };

  const sendReply = async (e: FormEvent) => {
    e.preventDefault();
    if (!openId) return;
    setBusy(true);
    try {
      const r = await accountApi.postTicketMessage(openId, reply.trim());
      setReply("");
      setThread((prev) => (prev ? { ...prev, messages: r.messages } : prev));
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Help & support" note="Tickets are stored in the app and answered by an administrator in the Admin Console.">
      {note ? <p className={styles.notice} role="status">{note}</p> : null}
      {err ? <p className={styles.error} role="alert">{err}</p> : null}
      <form onSubmit={create} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Input label="Subject" id="sup-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={160} />
        <div className={styles.grid2}>
          <Select
            label="Category"
            id="sup-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            options={[
              { value: "other", label: "General" },
              { value: "account", label: "Account" },
              { value: "billing", label: "Billing" },
              { value: "upload", label: "Upload" },
              { value: "export", label: "Export" },
              { value: "processing", label: "Processing" },
              { value: "publishing", label: "Publishing" },
            ]}
          />
          <Select
            label="Priority"
            id="sup-priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            options={[
              { value: "LOW", label: "Low" },
              { value: "NORMAL", label: "Normal" },
              { value: "HIGH", label: "High" },
            ]}
          />
        </div>
        <Textarea label="Describe the problem" id="sup-body" value={body} onChange={(e) => setBody(e.target.value)} />
        <div>
          <Button variant="primary" type="submit" loading={busy} disabled={!subject.trim() || !body.trim()}>Open ticket</Button>
        </div>
      </form>
      <h4>Your tickets</h4>
      {tickets === null ? (
        err ? (
          <Button variant="secondary" onClick={() => void load()}>Try again</Button>
        ) : (
          <LoadingState message="Loading tickets…" />
        )
      ) : tickets.length === 0 ? (
        <EmptyState title="No tickets yet" description="When you open a support ticket, it will be listed here with its replies." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {tickets.map((t) => (
            <button key={t.id} type="button" className={styles.ticketItem} onClick={() => void open(t.id)}>
              <span><strong>{t.subject}</strong> · <span className={styles.pill}>{t.status}</span></span>
              <span className={styles.small}>{t.category} · {t.priority} · updated {fmtDate(t.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}
      {openId ? (
        thread === null ? (
          err ? (
            <div className={styles.row}>
              <Button variant="secondary" onClick={() => void open(openId)}>Try again</Button>
              <Button variant="ghost" onClick={() => setOpenId(null)}>Close</Button>
            </div>
          ) : (
            <LoadingState message="Loading conversation…" />
          )
        ) : (
          <>
            <h4>{thread.subject}</h4>
            <div className={styles.messages}>
              {thread.messages.map((m) => (
                <div key={m.id} className={m.authorKind === "ADMIN" ? styles.messageAdmin : styles.messageUser}>
                  <div className={styles.small}>{m.authorKind === "ADMIN" ? "Support" : "You"} · {fmtDate(m.createdAt)}</div>
                  <div>{m.body}</div>
                </div>
              ))}
            </div>
            <form onSubmit={sendReply} className={styles.row}>
              <Textarea label="Reply" id="sup-reply" value={reply} onChange={(e) => setReply(e.target.value)} />
              <Button variant="primary" type="submit" loading={busy} disabled={!reply.trim()}>Send reply</Button>
            </form>
          </>
        )
      ) : null}
    </Section>
  );
}

// ============================================================================
// Page
// ============================================================================

const SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "security", label: "Security" },
  { id: "sessions", label: "Sessions" },
  { id: "accounts", label: "Connected Accounts" },
  { id: "notifications", label: "Notifications" },
  { id: "preferences", label: "Preferences" },
  { id: "workspace", label: "Workspace" },
  { id: "usage", label: "Usage" },
  { id: "plan", label: "Plan & Billing" },
  { id: "privacy", label: "Privacy & Data" },
  { id: "support", label: "Help & Support" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export default function SettingsPage() {
  const { user, refresh, logout } = useAuth();
  const [tab, setTab] = useState<SectionId>("profile");
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    accountApi
      .getProfile()
      .then((r) => setProfile(r.profile))
      .catch((e) => setLoadErr(errText(e)));
  }, [reloadKey]);

  if (loadErr) return <ErrorState message={loadErr} onRetry={() => { setLoadErr(null); setReloadKey((k) => k + 1); }} />;
  if (!profile) return <LoadingState message="Loading your settings…" />;

  const content: Record<SectionId, ReactNode> = {
    profile: <ProfileSection profile={profile} onProfile={setProfile} />,
    security: <SecuritySection />,
    sessions: <SessionsSection />,
    accounts: <ConnectedAccountsSection />,
    notifications: <NotificationsSection />,
    preferences: <PreferencesSection profile={profile} />,
    workspace: (
      <WorkspaceSection
        onSwitched={() => {
          void refresh();
          setReloadKey((k) => k + 1);
        }}
      />
    ),
    usage: <UsageSection />,
    plan: <PlanSection />,
    privacy: (
      <PrivacySection
        onDeleted={() => {
          void logout();
          window.location.hash = "#";
        }}
      />
    ),
    support: <SupportSection />,
  };

  return (
    <div className={styles.layout}>
      <p className={styles.muted}>
        Signed in as <strong>{user?.displayName ?? profile.displayName}</strong> ({profile.email}).
        Settings are saved on the server and follow your account.
      </p>
      <Tabs
        label="Settings sections"
        value={tab}
        onChange={(id) => setTab(id as SectionId)}
        tabs={SECTIONS.map((s) => ({ id: s.id, label: s.label, content: content[s.id] }))}
      />
    </div>
  );
}
