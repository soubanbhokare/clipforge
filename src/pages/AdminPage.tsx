// CLIPFORGE Admin Console (Phase 12). The API is the real gate:
// every /api/admin route re-checks the caller's server-side admin
// flag. This page only renders what the API returns — a non-admin
// sees the API's 403 as an honest "not authorized" state.

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Button from "../components/Button";
import ConfirmationDialog from "../components/ConfirmationDialog";
import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import Input from "../components/Input";
import LoadingState from "../components/LoadingState";
import Select from "../components/Select";
import Tabs from "../components/Tabs";
import Textarea from "../components/Textarea";
import {
  adminApi,
  type AdminOverview,
  type AdminProvider,
  type AdminUser,
  type AuditLogEntry,
  type HealthCheck,
} from "../services/admin";
import type { Plan } from "../services/account";
import { AuthApiError } from "../services/auth";
import styles from "./AdminPage.module.css";

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

function StatusPill({ status }: { status: string }) {
  const cls =
    status === "OPERATIONAL" || status === "ACTIVE" || status === "COMPLETED" || status === "CONNECTED"
      ? styles.pillOk
      : status === "UNAVAILABLE" || status === "FAILED" || status === "SUSPENDED"
        ? styles.pillBad
        : status === "NOT_USED" || status === "NOT_CONFIGURED"
          ? styles.pillMuted
          : "";
  return <span className={`${styles.pill} ${cls}`}>{status}</span>;
}

function Card({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <section className={styles.card}>
      <h3>{title}</h3>
      {note ? <p className={styles.muted}>{note}</p> : null}
      {children}
    </section>
  );
}

// ============================================================================

function OverviewSection() {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    adminApi.overview().then(setData).catch((e) => setErr(errText(e)));
  }, []);
  if (err) return <ErrorState message={err} />;
  if (!data) return <LoadingState message="Loading overview…" />;
  const stats: [string, string][] = [
    ["Users", String(data.users)],
    ["Active users (live sessions)", String(data.activeUsers)],
    ["Suspended users", String(data.suspendedUsers)],
    ["Workspaces", String(data.workspaces)],
    ["Projects", String(data.projects)],
    ["Media assets", String(data.mediaAssets)],
    ["Analysis jobs", String(data.analysisJobs)],
    ["Generated clips", String(data.generatedClips)],
    ["Tracking jobs", String(data.trackingJobs)],
    ["Export jobs", String(data.exportJobs)],
    ["Completed exports", String(data.completedExports)],
    ["Failed jobs", String(data.failedJobs)],
    ["Published posts", String(data.publishedPosts)],
    ["Connected accounts", `${data.connectedAccounts} / ${data.platformAccounts}`],
    ["Storage used", fmtBytes(data.storageBytes)],
    ["Open support tickets", String(data.openSupportTickets)],
  ];
  return (
    <Card title="Overview" note={`Live counts from the database · generated ${fmtDate(data.generatedAt)} · background workers: ${data.workers} (this process).`}>
      <div className={styles.statGrid}>
        {stats.map(([label, value]) => (
          <div key={label} className={styles.stat}>
            <div className={styles.statValue}>{value}</div>
            <div className={styles.statLabel}>{label}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ============================================================================

function UsersSection({ plans, plansError, onRetryPlans }: { plans: Plan[]; plansError?: string | null; onRetryPlans?: () => void }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof adminApi.getUser>> | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<AdminUser | null>(null);
  const [planChoice, setPlanChoice] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Sequence guard: the search/filter re-fires this load per
  // keystroke, so a slow earlier response must never overwrite a
  // newer result set.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const r = await adminApi.listUsers({ search: search.trim() || undefined, status: status || undefined });
      if (seq !== loadSeq.current) return;
      setUsers(r.users);
      setErr(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setErr(errText(e));
    }
  }, [search, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (id: string) => {
    setErr(null);
    try {
      setDetail(await adminApi.getUser(id));
    } catch (e) {
      setErr(errText(e));
    }
  };

  const doSuspend = async () => {
    if (!suspendTarget) return;
    setBusy(true);
    try {
      await adminApi.suspendUser(suspendTarget.id);
      setMsg(`${suspendTarget.email} suspended — their sessions were revoked. The action is in the audit log.`);
      setSuspendTarget(null);
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="User management" note="Passwords and tokens are never shown here. Suspension signs the user out everywhere and blocks sign-in until reactivation.">
      {err ? <p className={styles.error} role="alert">{err}</p> : null}
      {msg ? <p className={`${styles.notice} ${styles.success}`} role="status">{msg}</p> : null}
      <div className={styles.grid2}>
        <Input label="Search by name or email" id="adm-search" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select
          label="Status filter"
          id="adm-status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[
            { value: "", label: "All statuses" },
            { value: "ACTIVE", label: "Active" },
            { value: "SUSPENDED", label: "Suspended" },
          ]}
        />
      </div>
      {users === null ? (
        err ? (
          <Button variant="secondary" onClick={() => void load()}>Try again</Button>
        ) : (
          <LoadingState message="Loading users…" />
        )
      ) : users.length === 0 ? (
        <EmptyState title="No users match" description="Try a different search or filter." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>User</th><th>Status</th><th>Joined</th><th>Last login</th><th></th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.displayName}</strong> {u.isAdmin ? <span className={`${styles.pill} ${styles.pillOk}`}>admin</span> : null}
                    <div className={styles.small}>{u.email}{u.emailVerified ? "" : " · email unverified"}</div>
                  </td>
                  <td><StatusPill status={u.status} /></td>
                  <td>{fmtDate(u.createdAt)}</td>
                  <td>{fmtDate(u.lastLoginAt)}</td>
                  <td>
                    <div className={styles.row}>
                      <Button variant="ghost" onClick={() => void openDetail(u.id)}>View</Button>
                      {u.status === "SUSPENDED" ? (
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() => {
                            void (async () => {
                              setBusy(true);
                              setErr(null);
                              setMsg(null);
                              try {
                                await adminApi.reactivateUser(u.id);
                                setMsg(`${u.email} reactivated.`);
                                await load();
                              } catch (e) {
                                setErr(errText(e));
                              } finally {
                                setBusy(false);
                              }
                            })();
                          }}
                        >
                          Reactivate
                        </Button>
                      ) : (
                        <Button variant="ghost" disabled={busy} onClick={() => setSuspendTarget(u)}>Suspend</Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {detail ? (
        <div className={styles.card}>
          <h4>{detail.user.displayName} — {detail.user.email}</h4>
          <p className={styles.muted}>
            Projects: {detail.projectCount} · Workspaces: {detail.workspaces.map((w) => `${w.name} (${w.role})`).join(", ") || "none"} ·
            Plan: {detail.subscription ? `${detail.subscription.plan.name} (${detail.subscription.status}, via ${detail.subscription.source})` : "none"}
          </p>
          {detail.usage.length > 0 ? (
            <p className={styles.small}>
              Usage: {detail.usage.map((u) => `${u.operation} ${u.qty} ${u.unit}`).join(" · ")}
            </p>
          ) : (
            <p className={styles.small}>No usage recorded for this user.</p>
          )}
          {plansError ? (
            <div className={styles.row}>
              <p className={styles.error} role="alert">The plan list failed to load, so no plan can be assigned: {plansError}</p>
              <Button variant="ghost" onClick={onRetryPlans}>Retry</Button>
            </div>
          ) : null}
          <div className={styles.row}>
            <Select
              label="Assign plan"
              id="adm-assign-plan"
              value={planChoice}
              onChange={(e) => setPlanChoice(e.target.value)}
              options={[
                { value: "", label: "Choose a plan…" },
                ...plans.map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
            <Button
              variant="secondary"
              disabled={busy || !planChoice}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  setErr(null);
                  setMsg(null);
                  try {
                    await adminApi.assignPlan(detail.user.id, planChoice);
                    setMsg(`Plan assigned to ${detail.user.email}.`);
                    setDetail(await adminApi.getUser(detail.user.id));
                  } catch (e) {
                    setErr(errText(e));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              Assign plan
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  setErr(null);
                  setMsg(null);
                  try {
                    const r = await adminApi.initiateRecovery(detail.user.id);
                    setMsg(r.deliveryNote);
                  } catch (e) {
                    setErr(errText(e));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              Send password recovery
            </Button>
            <Button variant="ghost" onClick={() => setDetail(null)}>Close</Button>
          </div>
        </div>
      ) : null}
      <ConfirmationDialog
        open={suspendTarget !== null}
        title={`Suspend ${suspendTarget?.email}?`}
        message="The user is signed out everywhere and cannot sign in until reactivated. Their data is kept. This is written to the audit log."
        confirmLabel="Suspend account"
        onConfirm={() => void doSuspend()}
        onCancel={() => setSuspendTarget(null)}
      />
    </Card>
  );
}

// ============================================================================

function WorkspacesProjectsSection() {
  const [workspaces, setWorkspaces] = useState<Awaited<ReturnType<typeof adminApi.listWorkspaces>>["workspaces"] | null>(null);
  const [projects, setProjects] = useState<Awaited<ReturnType<typeof adminApi.listProjects>>["projects"] | null>(null);
  const [wsErr, setWsErr] = useState<string | null>(null);
  const [projErr, setProjErr] = useState<string | null>(null);
  const loadWorkspaces = useCallback(async () => {
    try {
      const r = await adminApi.listWorkspaces();
      setWorkspaces(r.workspaces);
      setWsErr(null);
    } catch (e) {
      setWsErr(errText(e));
    }
  }, []);
  const loadProjects = useCallback(async () => {
    try {
      const r = await adminApi.listProjects();
      setProjects(r.projects);
      setProjErr(null);
    } catch (e) {
      setProjErr(errText(e));
    }
  }, []);
  useEffect(() => {
    void loadWorkspaces();
    void loadProjects();
  }, [loadWorkspaces, loadProjects]);
  return (
    <>
      <Card title="Workspaces">
        {wsErr ? (
          <ErrorState message={`Workspaces could not be loaded: ${wsErr}`} onRetry={() => void loadWorkspaces()} />
        ) : workspaces === null ? (
          <LoadingState message="Loading workspaces…" />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Name</th><th>Status</th><th>Members</th><th>Projects</th><th>Created</th></tr></thead>
              <tbody>
                {workspaces.map((w) => (
                  <tr key={w.id}>
                    <td>{w.name}{w.isPersonal ? " (personal)" : ""}</td>
                    <td><StatusPill status={w.status} /></td>
                    <td>{w.memberCount}</td>
                    <td>{w.projectCount}</td>
                    <td>{fmtDate(w.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Projects">
        {projErr ? (
          <ErrorState message={`Projects could not be loaded: ${projErr}`} onRetry={() => void loadProjects()} />
        ) : projects === null ? (
          <LoadingState message="Loading projects…" />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Project</th><th>Owner</th><th>Status</th><th>Updated</th></tr></thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}<div className={styles.small}>{p.workflow_type}</div></td>
                    <td>{p.owner_email}</td>
                    <td>{p.status}</td>
                    <td>{fmtDate(p.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

// ============================================================================

function JobsSection() {
  const [jobs, setJobs] = useState<Awaited<ReturnType<typeof adminApi.listJobs>>["jobs"] | null>(null);
  const [renders, setRenders] = useState<Awaited<ReturnType<typeof adminApi.renderQueue>>["jobs"] | null>(null);
  const [pubs, setPubs] = useState<Awaited<ReturnType<typeof adminApi.publishingJobs>>["jobs"] | null>(null);
  const [jobsErr, setJobsErr] = useState<string | null>(null);
  const [rendersErr, setRendersErr] = useState<string | null>(null);
  const [pubsErr, setPubsErr] = useState<string | null>(null);
  const loadJobs = useCallback(async () => {
    try {
      const r = await adminApi.listJobs();
      setJobs(r.jobs);
      setJobsErr(null);
    } catch (e) {
      setJobsErr(errText(e));
    }
  }, []);
  const loadRenders = useCallback(async () => {
    try {
      const r = await adminApi.renderQueue();
      setRenders(r.jobs);
      setRendersErr(null);
    } catch (e) {
      setRendersErr(errText(e));
    }
  }, []);
  const loadPubs = useCallback(async () => {
    try {
      const r = await adminApi.publishingJobs();
      setPubs(r.jobs);
      setPubsErr(null);
    } catch (e) {
      setPubsErr(errText(e));
    }
  }, []);
  useEffect(() => {
    void loadJobs();
    void loadRenders();
    void loadPubs();
  }, [loadJobs, loadRenders, loadPubs]);
  return (
    <>
      <Card title="Processing jobs" note="Analysis, tracking and enhancement jobs across all users (most recent first).">
        {jobsErr ? <ErrorState message={`Processing jobs could not be loaded: ${jobsErr}`} onRetry={() => void loadJobs()} /> : jobs === null ? <LoadingState message="Loading jobs…" /> : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Kind</th><th>Status</th><th>Created</th><th>Updated</th></tr></thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={`${j.kind}-${j.id}`}>
                    <td>{j.kind}</td>
                    <td><StatusPill status={j.status} /></td>
                    <td>{fmtDate(j.created_at)}</td>
                    <td>{fmtDate(j.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Render & export queue">
        {rendersErr ? <ErrorState message={`Render queue could not be loaded: ${rendersErr}`} onRetry={() => void loadRenders()} /> : renders === null ? <LoadingState message="Loading render queue…" /> : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Kind</th><th>Status</th><th>Stage</th><th>Worker</th><th>Updated</th></tr></thead>
              <tbody>
                {renders.map((j) => (
                  <tr key={j.id}>
                    <td>{j.kind}</td>
                    <td><StatusPill status={j.status} /></td>
                    <td>{j.stage}</td>
                    <td>{j.worker_id ?? "—"}</td>
                    <td>{fmtDate(j.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Publishing jobs">
        {pubsErr ? <ErrorState message={`Publishing jobs could not be loaded: ${pubsErr}`} onRetry={() => void loadPubs()} /> : pubs === null ? <LoadingState message="Loading publishing jobs…" /> : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Platform</th><th>Status</th><th>Scheduled (UTC)</th><th>Updated</th></tr></thead>
              <tbody>
                {pubs.map((j) => (
                  <tr key={j.id}>
                    <td>{j.platform}</td>
                    <td><StatusPill status={j.status} /></td>
                    <td>{fmtDate(j.scheduled_for_utc)}</td>
                    <td>{fmtDate(j.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

// ============================================================================

function ProvidersSection() {
  const [providers, setProviders] = useState<AdminProvider[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await adminApi.listProviders();
      setProviders(r.providers);
      setErr(null);
    } catch (e) {
      setErr(errText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const test = async (key: string) => {
    setBusyKey(key);
    setErr(null);
    try {
      const r = await adminApi.testProvider(key);
      setMsg(`${key}: ${r.status} — ${r.detail}`);
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusyKey(null);
    }
  };

  const toggle = async (p: AdminProvider) => {
    setBusyKey(p.key);
    try {
      await adminApi.updateProvider(p.key, { enabled: !p.enabled });
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusyKey(null);
    }
  };

  const setSecretRef = async (p: AdminProvider) => {
    const ref = window.prompt(
      `Secret REFERENCE for ${p.displayName} — an environment variable NAME only (e.g. OPENAI_API_KEY). Secret values are never accepted or stored. Leave empty to clear.`,
      p.secretRef ?? "",
    );
    if (ref === null) return;
    setBusyKey(p.key);
    try {
      await adminApi.updateProvider(p.key, { secretRef: ref.trim() === "" ? null : ref.trim().toUpperCase() });
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Card title="AI & media providers" note="“Configured” is computed from real signals — environment credentials, model files on disk, the FFmpeg binary. The enable toggle and health results persist; a toggle never makes an unconfigured provider look configured.">
      {err ? <p className={styles.error} role="alert">{err}</p> : null}
      {msg ? <p className={`${styles.notice} ${styles.success}`} role="status">{msg}</p> : null}
      {providers === null ? (
        err ? (
          <Button variant="secondary" onClick={() => void load()}>Try again</Button>
        ) : (
          <LoadingState message="Loading providers…" />
        )
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>Provider</th><th>Configured</th><th>Enabled</th><th>Last health check</th><th></th></tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.key}>
                  <td>
                    <strong>{p.displayName}</strong>
                    <div className={styles.small}>{p.configDetail}</div>
                    <div className={styles.small}>Secret reference: {p.secretRef ?? "none set"}</div>
                  </td>
                  <td>{p.configured ? <span className={`${styles.pill} ${styles.pillOk}`}>yes</span> : <span className={styles.pill}>no</span>}</td>
                  <td>{p.enabled ? "enabled" : "disabled"}</td>
                  <td>
                    {p.lastHealthStatus ? <StatusPill status={p.lastHealthStatus} /> : <span className={styles.small}>never tested</span>}
                    {p.lastHealthAt ? <div className={styles.small}>{fmtDate(p.lastHealthAt)}</div> : null}
                  </td>
                  <td>
                    <div className={styles.row}>
                      <Button variant="secondary" disabled={busyKey === p.key} onClick={() => void test(p.key)}>Test</Button>
                      <Button variant="ghost" disabled={busyKey === p.key} onClick={() => void toggle(p)}>
                        {p.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button variant="ghost" disabled={busyKey === p.key} onClick={() => void setSecretRef(p)}>Secret ref</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ============================================================================

function IntegrationsHealthSection() {
  const [integrations, setIntegrations] = useState<Awaited<ReturnType<typeof adminApi.integrations>> | null>(null);
  const [integrationsErr, setIntegrationsErr] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthCheck[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const runHealth = useCallback(async () => {
    setBusy(true);
    try {
      const r = await adminApi.systemHealth();
      setHealth(r.checks);
      setCheckedAt(r.checkedAt);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const loadIntegrations = useCallback(async () => {
    try {
      setIntegrations(await adminApi.integrations());
      setIntegrationsErr(null);
    } catch (e) {
      setIntegrationsErr(errText(e));
    }
  }, []);

  useEffect(() => {
    void loadIntegrations();
    void runHealth();
  }, [loadIntegrations, runHealth]);

  return (
    <>
      <Card title="Platform integrations" note="Publishing and analytics configuration state, read from the server configuration.">
        {integrationsErr ? (
          <ErrorState message={`Integrations could not be loaded: ${integrationsErr}`} onRetry={() => void loadIntegrations()} />
        ) : integrations === null ? (
          <LoadingState message="Loading integrations…" />
        ) : (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>Platform</th><th>OAuth configured</th><th>Accounts</th><th>Missing</th></tr></thead>
                <tbody>
                  {integrations.platforms.map((p) => (
                    <tr key={p.platform}>
                      <td>{p.platform}</td>
                      <td>{p.configured ? <span className={`${styles.pill} ${styles.pillOk}`}>yes</span> : <span className={styles.pill}>no</span>}</td>
                      <td>{p.connected} connected / {p.accounts} total</td>
                      <td>{p.missing.length ? p.missing.join(", ") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={styles.muted}>
              Token encryption: {integrations.tokenEncryption.ready ? `ready (${integrations.tokenEncryption.mode})` : "NOT READY"} ·
              Email: {integrations.email.mode} · Payments: {integrations.payments.enabled ? `enabled (${integrations.payments.provider})` : `disabled (missing: ${integrations.payments.missing.join(", ")})`}
            </p>
          </>
        )}
      </Card>
      <Card title="System health" note="Checks run live on the server when you open or refresh this section: FFmpeg/FFprobe are really executed, the disk is really measured, and components this deployment does not use say so.">
        {err ? <p className={styles.error} role="alert">{err}</p> : null}
        <div className={styles.row}>
          <Button variant="secondary" onClick={() => void runHealth()} loading={busy}>Run checks again</Button>
          {checkedAt ? <span className={styles.small}>Last run {fmtDate(checkedAt)}</span> : null}
        </div>
        {health === null ? (
          <LoadingState message="Running health checks…" />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Component</th><th>Status</th><th>Detail</th></tr></thead>
              <tbody>
                {health.map((c) => (
                  <tr key={c.key}>
                    <td>{c.label}</td>
                    <td><StatusPill status={c.status} /></td>
                    <td>{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

// ============================================================================

function UsageReportsSection() {
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof adminApi.usage>> | null>(null);
  const [reports, setReports] = useState<Awaited<ReturnType<typeof adminApi.listReports>>["reports"] | null>(null);
  const [usageErr, setUsageErr] = useState<string | null>(null);
  const [reportsErr, setReportsErr] = useState<string | null>(null);
  const loadUsage = useCallback(async () => {
    try {
      setUsage(await adminApi.usage());
      setUsageErr(null);
    } catch (e) {
      setUsageErr(errText(e));
    }
  }, []);
  const loadReports = useCallback(async () => {
    try {
      const r = await adminApi.listReports();
      setReports(r.reports);
      setReportsErr(null);
    } catch (e) {
      setReportsErr(errText(e));
    }
  }, []);
  useEffect(() => {
    void loadUsage();
    void loadReports();
  }, [loadUsage, loadReports]);
  return (
    <>
      <Card title="Usage monitoring" note="Aggregates of the immutable usage ledger across all users.">
        {usageErr ? (
          <ErrorState message={`Usage could not be loaded: ${usageErr}`} onRetry={() => void loadUsage()} />
        ) : usage === null ? (
          <LoadingState message="Loading usage…" />
        ) : (
          <>
            <p className={styles.muted}>{usage.totalEntries} ledger entries.</p>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>Operation</th><th>Quantity</th><th>Events</th></tr></thead>
                <tbody>
                  {usage.byOperation.map((u) => (
                    <tr key={`${u.operation}-${u.unit}`}>
                      <td>{u.operation}</td>
                      <td>{u.qty} {u.unit}</td>
                      <td>{u.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {usage.byUser.length > 0 ? (
              <>
                <h4>By user</h4>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead><tr><th>User</th><th>Entries</th><th>Total quantity</th></tr></thead>
                    <tbody>
                      {usage.byUser.map((u) => (
                        <tr key={u.user_id}>
                          <td>{u.email}</td>
                          <td>{u.entries}</td>
                          <td>{u.total_quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
          </>
        )}
      </Card>
      <Card title="Analytics reports" note="Reports generated by users.">
        {reportsErr ? (
          <ErrorState message={`Reports could not be loaded: ${reportsErr}`} onRetry={() => void loadReports()} />
        ) : reports === null ? (
          <LoadingState message="Loading reports…" />
        ) : reports.length === 0 ? (
          <EmptyState title="No reports yet" description="When a user generates an analytics report, it will be listed here." />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Report</th><th>Owner</th><th>Status</th><th>Created</th></tr></thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td>{r.owner_email}</td>
                    <td><StatusPill status={r.status} /></td>
                    <td>{fmtDate(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

// ============================================================================

const LIMIT_KEYS = ["storage_bytes", "ai_processing_minutes", "exports_per_month", "connected_accounts", "team_members"];
const FEATURE_KEYS = ["publishing", "analytics", "ai_captions", "face_lock", "broll", "priority_rendering"];

function PlansSection({ plans, plansError, onRetryPlans, onChanged }: { plans: Plan[]; plansError?: string | null; onRetryPlans?: () => void; onChanged: () => void }) {
  const [selectedId, setSelectedId] = useState<string>("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [monthly, setMonthly] = useState("");
  const [annual, setAnnual] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  const [limits, setLimits] = useState<Record<string, string>>({});
  // Tri-state: true = included, false = not included, null = not
  // set. NULL must survive load → edit → save untouched — collapsing
  // it to false would silently rewrite "not set" plans on any save.
  const [features, setFeatures] = useState<Record<string, boolean | null>>({});
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = plans.find((p) => p.id === selectedId) ?? null;

  useEffect(() => {
    if (!selected) return;
    setName(selected.name);
    setDescription(selected.description);
    setMonthly(selected.monthlyPriceCents === null ? "" : String(selected.monthlyPriceCents));
    setAnnual(selected.annualPriceCents === null ? "" : String(selected.annualPriceCents));
    const l: Record<string, string> = {};
    const f: Record<string, boolean | null> = {};
    for (const e of selected.entitlements) {
      if (LIMIT_KEYS.includes(e.key)) l[e.key] = e.limit === null ? "" : String(e.limit);
      if (FEATURE_KEYS.includes(e.key)) f[e.key] = e.featureEnabled;
    }
    setLimits(l);
    setFeatures(f);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const cents = (v: string): number | null => {
    const t = v.trim();
    if (t === "") return null;
    const n = Number.parseInt(t, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const savePlan = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    // Validate numbers explicitly: a non-numeric price or limit must
    // be an error the admin can fix, never a silent "not set".
    for (const [label, v] of [["Monthly price", monthly], ["Annual price", annual]] as const) {
      const t = v.trim();
      if (t !== "" && !/^\d+$/.test(t)) {
        setErr(`${label} must be a whole number of cents (0 or more), or left empty for "price not set". Nothing was saved.`);
        return;
      }
    }
    for (const key of LIMIT_KEYS) {
      const t = limits[key]?.trim() ?? "";
      if (t !== "" && !/^\d+$/.test(t)) {
        setErr(`Limit "${key}" must be a whole number, or left empty for "no limit configured". Nothing was saved.`);
        return;
      }
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    let planSaved = false;
    try {
      await adminApi.updatePlan(selected.id, {
        name: name.trim(),
        description,
        monthlyPriceCents: cents(monthly),
        annualPriceCents: cents(annual),
      });
      planSaved = true;
      const entitlements: { key: string; limit?: number | null; featureEnabled?: boolean | null }[] = [
        ...LIMIT_KEYS.map((key) => ({
          key,
          limit: limits[key]?.trim() === "" || limits[key] === undefined ? null : Number.parseInt(limits[key], 10),
        })),
        ...FEATURE_KEYS.map((key) => ({ key, featureEnabled: features[key] ?? null })),
      ];
      await adminApi.setEntitlements(selected.id, entitlements);
      setMsg("Plan and entitlements saved. The change is in the audit log.");
      onChanged();
    } catch (e2) {
      setErr(
        planSaved
          ? `The plan's name and prices were saved, but its entitlements failed: ${errText(e2)}`
          : errText(e2),
      );
    } finally {
      setBusy(false);
    }
  };

  const createPlan = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await adminApi.createPlan({ key: newKey.trim(), name: newName.trim() });
      setMsg(`Plan “${r.plan.name}” created with no prices or limits set.`);
      setNewKey("");
      setNewName("");
      onChanged();
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Plans & entitlements" note="Prices are in cents and start unset — a plan shows “Price not set” to users until you enter one. Empty limit = no limit configured (shown as “not set”).">
      {err ? <p className={styles.error} role="alert">{err}</p> : null}
      {msg ? <p className={`${styles.notice} ${styles.success}`} role="status">{msg}</p> : null}
      {plansError ? (
        <div className={styles.row}>
          <p className={styles.error} role="alert">The plan list failed to load: {plansError}</p>
          <Button variant="ghost" onClick={onRetryPlans}>Retry</Button>
        </div>
      ) : null}
      <Select
        label="Select plan"
        id="adm-plan-select"
        value={selectedId}
        onChange={(e) => setSelectedId(e.target.value)}
        options={[
          { value: "", label: "Choose a plan…" },
          ...plans.map((p) => ({ value: p.id, label: `${p.name} (${p.key})` })),
        ]}
      />
      {selected ? (
        <form onSubmit={savePlan} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className={styles.grid2}>
            <Input label="Name" id="adm-plan-name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input label="Description" id="adm-plan-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
            <Input label="Monthly price (cents, empty = not set)" id="adm-plan-monthly" value={monthly} onChange={(e) => setMonthly(e.target.value)} inputMode="numeric" />
            <Input label="Annual price (cents, empty = not set)" id="adm-plan-annual" value={annual} onChange={(e) => setAnnual(e.target.value)} inputMode="numeric" />
          </div>
          <h4>Limits (empty = not set)</h4>
          <div className={styles.grid2}>
            {LIMIT_KEYS.map((key) => (
              <Input
                key={key}
                label={key}
                id={`adm-limit-${key}`}
                value={limits[key] ?? ""}
                onChange={(e) => setLimits((prev) => ({ ...prev, [key]: e.target.value }))}
                inputMode="numeric"
              />
            ))}
          </div>
          <h4>Features</h4>
          <div className={styles.grid2}>
            {FEATURE_KEYS.map((key) => (
              <Select
                key={key}
                label={key}
                id={`adm-feature-${key}`}
                value={features[key] === undefined || features[key] === null ? "unset" : features[key] ? "included" : "excluded"}
                onChange={(e) => {
                  const v = e.target.value;
                  setFeatures((prev) => ({ ...prev, [key]: v === "unset" ? null : v === "included" }));
                }}
                options={[
                  { value: "unset", label: "Not set" },
                  { value: "included", label: "Included" },
                  { value: "excluded", label: "Not included" },
                ]}
              />
            ))}
          </div>
          <div>
            <Button variant="primary" type="submit" loading={busy}>Save plan</Button>
          </div>
        </form>
      ) : null}
      <h4>Create a plan</h4>
      <form onSubmit={createPlan} className={styles.grid2}>
        <Input label="Key (lowercase, e.g. studio)" id="adm-plan-key" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
        <Input label="Name" id="adm-plan-newname" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <div>
          <Button variant="secondary" type="submit" loading={busy} disabled={!newKey.trim() || !newName.trim()}>Create plan</Button>
        </div>
      </form>
    </Card>
  );
}

// ============================================================================

function AuditSection() {
  const [logs, setLogs] = useState<AuditLogEntry[] | null>(null);
  const [eventType, setEventType] = useState("");
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  // Sequence guard: the filter re-fires this load per keystroke, so
  // a slow earlier response must never overwrite a newer result set.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const r = await adminApi.auditLogs({ eventType: eventType.trim() || undefined });
      if (seq !== loadSeq.current) return;
      setLogs(r.logs);
      setTotal(r.total);
      setErr(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      // A failed load is NOT an empty log — keep the previous
      // entries/total and say so, with a way to retry.
      setErr(errText(e));
    }
  }, [eventType]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Card title="Audit log" note="Append-only record of security- and money-relevant actions: logins, password and email changes, workspace and member events, suspensions, provider and plan changes, publishing outcomes and deletion requests. Secrets are never written here.">
      <div className={styles.row}>
        <Input label="Filter by event type (exact)" id="adm-audit-filter" value={eventType} onChange={(e) => setEventType(e.target.value)} />
        <span className={styles.small}>{total} entries</span>
      </div>
      {err ? (
        <ErrorState message={`Audit log could not be loaded: ${err}`} onRetry={() => void load()} />
      ) : logs === null ? (
        <LoadingState message="Loading audit log…" />
      ) : logs.length === 0 ? (
        <EmptyState title="No audit entries" description="Nothing has been recorded for this filter yet." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>When</th><th>Event</th><th>Target</th><th>Result</th><th>Detail</th></tr></thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td>{fmtDate(l.createdAt)}</td>
                  <td>{l.eventType}</td>
                  <td>{l.targetType ? `${l.targetType}` : "—"}</td>
                  <td>{l.result}</td>
                  <td><span className={styles.codeBox}>{JSON.stringify(l.metadata)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ============================================================================

function SupportAdminSection() {
  const [tickets, setTickets] = useState<Awaited<ReturnType<typeof adminApi.listTickets>>["tickets"] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [thread, setThread] = useState<Awaited<ReturnType<typeof adminApi.getTicket>>["ticket"] | null>(null);
  const [reply, setReply] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await adminApi.listTickets();
      setTickets(r.tickets);
      setErr(null);
    } catch (e) {
      setErr(errText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (id: string) => {
    setOpenId(id);
    setThread(null);
    setErr(null);
    try {
      setThread((await adminApi.getTicket(id)).ticket);
    } catch (e) {
      setErr(errText(e));
    }
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!openId) return;
    setBusy(true);
    try {
      await adminApi.replyTicket(openId, reply.trim());
      setReply("");
      setThread((await adminApi.getTicket(openId)).ticket);
      await load();
    } catch (e2) {
      setErr(errText(e2));
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: string) => {
    if (!openId) return;
    setBusy(true);
    try {
      await adminApi.setTicketStatus(openId, status);
      await load();
      setThread((await adminApi.getTicket(openId)).ticket);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Support tickets" note="Tickets live in the app — there is no external helpdesk configured, and users are told so.">
      {err ? <p className={styles.error} role="alert">{err}</p> : null}
      {tickets === null ? (
        err ? (
          <Button variant="secondary" onClick={() => void load()}>Try again</Button>
        ) : (
          <LoadingState message="Loading tickets…" />
        )
      ) : tickets.length === 0 ? (
        <EmptyState title="No tickets" description="User support tickets will appear here." />
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Subject</th><th>User</th><th>Priority</th><th>Status</th><th>Updated</th><th></th></tr></thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id}>
                  <td>{t.subject}</td>
                  <td>{t.user_email}</td>
                  <td>{t.priority}</td>
                  <td><StatusPill status={t.status} /></td>
                  <td>{fmtDate(t.updated_at)}</td>
                  <td><Button variant="ghost" onClick={() => void open(t.id)}>Open</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
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
            <h4>{String(thread.subject ?? "Ticket")}</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {thread.messages.map((m) => (
                <div key={m.id} className={styles.notice}>
                  <div className={styles.small}>{m.authorKind} · {fmtDate(m.createdAt)}</div>
                  <div>{m.body}</div>
                </div>
              ))}
            </div>
            <form onSubmit={send} className={styles.row}>
              <Textarea label="Reply as support" id="adm-reply" value={reply} onChange={(e) => setReply(e.target.value)} />
              <Button variant="primary" type="submit" loading={busy} disabled={!reply.trim()}>Send reply</Button>
            </form>
            <div className={styles.row}>
              {(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"] as const).map((s) => (
                <Button key={s} variant="ghost" disabled={busy} onClick={() => void setStatus(s)}>Mark {s}</Button>
              ))}
            </div>
          </>
        )
      ) : null}
    </Card>
  );
}

// ============================================================================

const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "users", label: "Users" },
  { id: "workspaces", label: "Workspaces & Projects" },
  { id: "jobs", label: "Jobs" },
  { id: "providers", label: "Providers" },
  { id: "health", label: "Integrations & Health" },
  { id: "usage", label: "Usage & Reports" },
  { id: "plans", label: "Plans" },
  { id: "audit", label: "Audit Log" },
  { id: "support", label: "Support" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export default function AdminPage() {
  const [tab, setTab] = useState<SectionId>("overview");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansErr, setPlansErr] = useState<string | null>(null);
  const [gate, setGate] = useState<"loading" | "ok" | "denied">("loading");
  const [gateMsg, setGateMsg] = useState("");

  const loadPlans = useCallback(async () => {
    try {
      const r = await adminApi.listPlans();
      setPlans(r.plans);
      setPlansErr(null);
    } catch (e) {
      // A failed load is not "no plans" — surface it wherever the
      // plan list is consumed (Plans section, Users plan-select).
      setPlansErr(errText(e));
    }
  }, []);

  useEffect(() => {
    // Probe the real gate: the overview endpoint 403s for non-admins.
    adminApi
      .overview()
      .then(() => {
        setGate("ok");
        void loadPlans();
      })
      .catch((e) => {
        setGate("denied");
        setGateMsg(errText(e));
      });
  }, [loadPlans]);

  if (gate === "loading") return <LoadingState message="Checking administrator access…" />;
  if (gate === "denied") {
    return (
      <ErrorState
        title="Administrator access required"
        message={`The server refused this console: ${gateMsg} Admin access is granted only through the ADMIN_EMAILS server configuration — never from the frontend.`}
      />
    );
  }

  const content: Record<SectionId, ReactNode> = {
    overview: <OverviewSection />,
    users: <UsersSection plans={plans} plansError={plansErr} onRetryPlans={() => void loadPlans()} />,
    workspaces: <WorkspacesProjectsSection />,
    jobs: <JobsSection />,
    providers: <ProvidersSection />,
    health: <IntegrationsHealthSection />,
    usage: <UsageReportsSection />,
    plans: <PlansSection plans={plans} plansError={plansErr} onRetryPlans={() => void loadPlans()} onChanged={() => void loadPlans()} />,
    audit: <AuditSection />,
    support: <SupportAdminSection />,
  };

  return (
    <div className={styles.layout}>
      <p className={styles.muted}>
        Every number here is a live database query; every action is audit-logged. Components this
        deployment does not use are labelled NOT_USED, never shown as healthy.
      </p>
      <Tabs
        label="Admin console sections"
        value={tab}
        onChange={(id) => setTab(id as SectionId)}
        tabs={SECTIONS.map((s) => ({ id: s.id, label: s.label, content: content[s.id] }))}
      />
    </div>
  );
}
