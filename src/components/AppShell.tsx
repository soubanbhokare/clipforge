import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useAuth } from "../features/auth/AuthContext";
import { useUpload } from "../features/studio/UploadContext";
import { accountApi, type Workspace } from "../services/account";
import { AuthApiError, authApi } from "../services/auth";
import Button from "./Button";
import ConfirmationDialog from "./ConfirmationDialog";
import Dropdown from "./Dropdown";
import Logo from "./Logo";
import Modal from "./Modal";
import NotificationPanel from "./NotificationPanel";
import StatusIndicator from "./StatusIndicator";
import Tooltip from "./Tooltip";
import styles from "./AppShell.module.css";

export type AppRoute =
  | "studio"
  | "projects"
  | "clips"
  | "editor"
  | "exports"
  | "templates"
  | "publishing"
  | "publishing-calendar"
  | "publishing-queue"
  | "analytics"
  | "settings"
  | "admin";

// Sidebar structure: a short primary list of daily-use destinations,
// then quiet labelled groups, then Settings/Admin at the bottom.
// Every route stays reachable; this is organisation only.
// "publishing" stays as a route alias for publishing-calendar so
// older links keep working; it is not a separate nav item.
interface NavItem {
  id: AppRoute;
  label: string;
}
interface NavGroup {
  label: string | null;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [
      { id: "studio", label: "Studio" },
      { id: "projects", label: "Projects" },
      { id: "clips", label: "My Clips" },
      { id: "editor", label: "AI Editor" },
      { id: "analytics", label: "Analytics" },
    ],
  },
  {
    label: "Publish",
    items: [
      { id: "publishing-calendar", label: "Publishing Calendar" },
      { id: "publishing-queue", label: "Publishing Queue" },
    ],
  },
  {
    label: "Library",
    items: [
      { id: "exports", label: "Export Studio" },
      { id: "templates", label: "Templates & Brand Kit" },
    ],
  },
];

const SYSTEM_GROUP: NavGroup = {
  label: "System",
  items: [{ id: "settings", label: "Settings" }],
};

interface AppShellProps {
  route: AppRoute;
  title: string;
  children: ReactNode;
}

export default function AppShell({ route, title, children }: AppShellProps) {
  const { user, isGuest, logout, exitGuest, resendVerification, refresh } = useAuth();
  const { activeUpload } = useUpload();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [resendNote, setResendNote] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  // Phase 12: workspace switcher — the ACTIVE workspace lives on the
  // server (per user), and switching re-scopes projects + brand kits.
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  // Workspace switcher is a custom dark dropdown (the shared Dropdown
  // pattern), not a native <select> — no light popup, no lime box.
  const [wsOpen, setWsOpen] = useState(false);
  const wsWrapRef = useRef<HTMLDivElement>(null);
  const wsTriggerRef = useRef<HTMLButtonElement>(null);
  const [switchNote, setSwitchNote] = useState<string | null>(null);
  const [workspaceLoadError, setWorkspaceLoadError] = useState<string | null>(null);
  const [emailConfigured, setEmailConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    if (isGuest || !user) return;
    setWorkspaceLoadError(null);
    accountApi
      .listWorkspaces()
      .then((r) => {
        setWorkspaces(r.workspaces.filter((w) => w.status === "ACTIVE"));
        setActiveWorkspaceId(r.activeWorkspaceId);
        setWorkspaceLoadError(null);
      })
      .catch((err) => {
        setWorkspaces([]);
        setWorkspaceLoadError(
          err instanceof AuthApiError
            ? `Workspaces could not be loaded: ${err.message}`
            : "Workspaces could not be loaded. The workspace switcher is unavailable until the server responds.",
        );
      });
  }, [isGuest, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isGuest || !user || user.emailVerified) {
      setEmailConfigured(null);
      return;
    }
    let alive = true;
    authApi
      .getConfig()
      .then((config) => {
        if (alive) setEmailConfigured(config.emailConfigured);
      })
      .catch(() => {
        if (alive) setEmailConfigured(null);
      });
    return () => {
      alive = false;
    };
  }, [isGuest, user?.id, user?.emailVerified]);

  const switchWorkspace = async (id: string) => {
    if (!id || id === activeWorkspaceId) return;
    try {
      await accountApi.switchWorkspace(id);
      // Reload so every surface re-reads under the new workspace scope.
      window.location.reload();
    } catch (err) {
      setSwitchNote(err instanceof AuthApiError ? err.message : "Could not switch workspace.");
    }
  };

  // Switcher menu dismissal, mirroring the shared Dropdown pattern:
  // Escape closes (and refocuses the trigger), outside click closes.
  useEffect(() => {
    if (!wsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setWsOpen(false);
        wsTriggerRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (wsWrapRef.current && !wsWrapRef.current.contains(e.target as Node)) setWsOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [wsOpen]);

  // On open, focus lands on the active workspace option so keyboard
  // users start from the current selection.
  useEffect(() => {
    if (!wsOpen) return;
    const target =
      wsWrapRef.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]') ??
      wsWrapRef.current?.querySelector<HTMLButtonElement>('[role="option"]');
    target?.focus();
  }, [wsOpen]);

  const onWsMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(
      wsWrapRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
    );
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    e.preventDefault();
    const next =
      e.key === "ArrowDown"
        ? items[Math.min(idx + 1, items.length - 1)]
        : items[Math.max(idx - 1, 0)];
    next?.focus();
  };

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

  const navGroups: NavGroup[] = user?.isAdmin
    ? [
        ...NAV_GROUPS,
        {
          ...SYSTEM_GROUP,
          items: [
            ...SYSTEM_GROUP.items,
            { id: "admin" as AppRoute, label: "Admin Console" },
          ],
        },
      ]
    : [...NAV_GROUPS, SYSTEM_GROUP];

  const handleSignOut = async () => {
    setSignOutOpen(false);
    if (isGuest) {
      exitGuest();
    } else {
      await logout();
    }
    window.location.hash = "#";
  };

  const handleResend = async () => {
    setResending(true);
    setResendNote(null);
    try {
      const result = await resendVerification();
      setEmailConfigured(result.emailConfigured);
      setResendNote(
        result.emailConfigured
          ? "Verification email sent — check your inbox."
          : "Verification email prepared. Email delivery is not configured on this server, so it was written to the server outbox (server/data/outbox) instead of being delivered.",
      );
      await refresh();
    } catch (err) {
      setResendNote(
        err instanceof AuthApiError ? err.message : "Could not resend right now. Please try again later.",
      );
    } finally {
      setResending(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Account menu holds account-level actions only. Settings lives in
  // the sidebar (System group); Help lives here — one home each.
  const profileMenu = (
    <>
      {isGuest ? (
        <a className={styles.menuLink} href="#/signup" role="menuitem">Create account</a>
      ) : null}
      <button type="button" className={styles.menuLink} role="menuitem" onClick={() => setHelpOpen(true)}>Help</button>
      <a className={styles.menuLink} href="#" role="menuitem">Back to landing</a>
      <button type="button" className={styles.menuLink} role="menuitem" onClick={() => setSignOutOpen(true)}>
        {isGuest ? "Exit demo" : "Sign out"}
      </button>
    </>
  );

  // Topbar shows identity only. The "Create account" CTA lives in the
  // demo banner and the account menu; email-verification state lives
  // in the banner below (with its resend action) — no duplicates here.
  const accountArea = isGuest ? (
    <span className={styles.accountArea}>
      <span className={styles.demoBadge}>DEMO MODE</span>
    </span>
  ) : user ? (
    <span className={styles.accountArea}>
      <span className={styles.accountName}>{user.displayName}</span>
    </span>
  ) : null;

  return (
    <div className={styles.shell}>
      <aside className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ""}`} aria-label="Main navigation">
        <a className={styles.brand} href="#" aria-label="CLIPFORGE home">
          <Logo />
        </a>
        <nav aria-label="Application">
          {navGroups.map((group) => (
            <div className={styles.navGroup} key={group.label ?? "primary"}>
              {group.label ? (
                <p className={styles.navGroupLabel} id={`nav-group-${group.label.toLowerCase()}`}>
                  {group.label}
                </p>
              ) : null}
              <ul
                className={styles.navList}
                aria-labelledby={group.label ? `nav-group-${group.label.toLowerCase()}` : undefined}
              >
                {group.items.map((item) => (
                  <li key={item.id}>
                    <a
                      href={`#/${item.id}`}
                      className={item.id === route ? styles.navActive : styles.navLink}
                      aria-current={item.id === route ? "page" : undefined}
                      onClick={() => setSidebarOpen(false)}
                    >
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className={styles.sidebarBottom}>
          <Dropdown label="Account menu" triggerLabel="Account" dropUp>
            {profileMenu}
          </Dropdown>
        </div>
      </aside>

      {sidebarOpen && <button type="button" className={styles.scrim} aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}

      <div className={styles.mainWrap}>
        <header className={styles.topbar}>
          <button
            type="button"
            className={styles.menuButton}
            aria-label="Open navigation"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            ☰
          </button>
          <div className={styles.topbarRight}>
            {workspaceLoadError ? (
              <span className={styles.resendNote} role="alert">{workspaceLoadError}</span>
            ) : null}
            {!isGuest && user && workspaces.length > 0 ? (
              <div className={`${styles.accountArea} ${styles.wsWrap}`} ref={wsWrapRef}>
                <span className={styles.accountName} id="workspace-switcher-label">Workspace</span>
                <button
                  type="button"
                  ref={wsTriggerRef}
                  className={styles.wsTrigger}
                  aria-haspopup="listbox"
                  aria-expanded={wsOpen}
                  aria-labelledby="workspace-switcher-label workspace-current-name"
                  onClick={() => setWsOpen((v) => !v)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown" && !wsOpen) {
                      e.preventDefault();
                      setWsOpen(true);
                    }
                  }}
                >
                  <span id="workspace-current-name">{activeWorkspace?.name ?? "Choose workspace"}</span>
                  <span className={styles.wsChevron} aria-hidden="true">▾</span>
                </button>
                {wsOpen ? (
                  <div
                    className={styles.wsMenu}
                    role="listbox"
                    aria-label="Active workspace"
                    onKeyDown={onWsMenuKeyDown}
                  >
                    {workspaces.map((w) => {
                      const isActive = w.id === activeWorkspaceId;
                      return (
                        <button
                          key={w.id}
                          type="button"
                          role="option"
                          aria-selected={isActive}
                          className={isActive ? styles.wsItemActive : styles.wsItem}
                          onClick={() => {
                            setWsOpen(false);
                            void switchWorkspace(w.id);
                          }}
                        >
                          <span className={isActive ? styles.wsDot : styles.wsDotSpace} aria-hidden="true" />
                          {w.name}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
            {switchNote ? <span className={styles.resendNote} role="alert">{switchNote}</span> : null}
            {accountArea}
            {activeUpload ? (
              <Tooltip text={`Uploading ${activeUpload.filename}`}>
                <span>
                  <StatusIndicator status="processing" label={`Uploading ${activeUpload.percent}%`} />
                </span>
              </Tooltip>
            ) : (
              <Tooltip text="No file upload is in progress">
                <span><StatusIndicator status="idle" label="No active uploads" /></span>
              </Tooltip>
            )}
            <Dropdown label="Notifications" triggerLabel="Notifications">
              <NotificationPanel />
            </Dropdown>
          </div>
        </header>

        <main className={styles.main}>
          {isGuest && (
            <p className={styles.demoBanner} role="note">
              You are exploring a demo workspace. Sign up to save projects
              and use real processing.{" "}
              <a href="#/signup">Create a free account</a>
            </p>
          )}
          {!isGuest && user && !user.emailVerified && (
            <div className={styles.verifyBanner} role="note">
              <span>
                {emailConfigured === false
                  ? "Email not verified — email delivery is not configured on this server, so the verification message was written to the server outbox (server/data/outbox), not delivered to an inbox. You can resend it below."
                  : "Email not verified — check your inbox for the verification link, or resend it."}
              </span>
              <button
                type="button"
                className={styles.resendButton}
                onClick={handleResend}
                disabled={resending}
              >
                {resending ? "Resending…" : "Resend verification email"}
              </button>
              {resendNote && <span className={styles.resendNote}>{resendNote}</span>}
            </div>
          )}
          <h1 className={styles.pageTitle}>{title}</h1>
          {children}
        </main>
      </div>

      <Modal open={helpOpen} title="Help" onClose={() => setHelpOpen(false)}>
        <p>
          Use the Studio to upload videos, manage projects, generate
          AI clips, edit, add captions, apply Face Lock, enhance and
          export. Publishing and analytics connect to your platform
          accounts. Features that need platform credentials or scopes
          you have not granted show what is missing.
        </p>
        <Button variant="secondary" onClick={() => setHelpOpen(false)}>Close</Button>
      </Modal>

      <ConfirmationDialog
        open={signOutOpen}
        title={isGuest ? "Exit demo?" : "Sign out?"}
        message={
          isGuest
            ? "You are exploring in demo mode. Exiting returns you to the landing page — nothing was saved, because demo mode never stores personal projects."
            : "This revokes your session on the server and returns you to the landing page. You can sign in again at any time."
        }
        confirmLabel={isGuest ? "Exit demo" : "Sign out"}
        onConfirm={handleSignOut}
        onCancel={() => setSignOutOpen(false)}
      />
    </div>
  );
}
