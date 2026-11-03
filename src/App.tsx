import { useEffect, useState } from "react";
import AppShell, { type AppRoute } from "./components/AppShell";
import { AuthProvider, useAuth } from "./features/auth/AuthContext";
import { navigateTo, parseHash } from "./features/auth/routing";
import { UploadProvider } from "./features/studio/UploadContext";
import AdminPage from "./pages/AdminPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import ClipsPage from "./pages/ClipsPage";
import EditorPage from "./pages/EditorPage";
import ExportsPage from "./pages/ExportsPage";
import HomePage from "./pages/HomePage";
import ProjectsPage from "./pages/ProjectsPage";
import PublishingPage from "./pages/PublishingPage";
import SettingsPage from "./pages/SettingsPage";
import StudioPage from "./pages/StudioPage";
import TemplatesPage from "./pages/TemplatesPage";
import CreateShortsPage from "./pages/studio/CreateShortsPage";
import EnhanceVideoPage from "./pages/studio/EnhanceVideoPage";
import ProjectDetailPage from "./pages/studio/ProjectDetailPage";
import VideoEditorPage from "./pages/studio/VideoEditorPage";
import AcceptInvitationPage from "./pages/auth/AcceptInvitationPage";
import ForgotPasswordPage from "./pages/auth/ForgotPasswordPage";
import LoginPage from "./pages/auth/LoginPage";
import ResetPasswordPage from "./pages/auth/ResetPasswordPage";
import SignupPage from "./pages/auth/SignupPage";
import VerifyEmailPage from "./pages/auth/VerifyEmailPage";
import authStyles from "./pages/auth/AuthPages.module.css";
import Logo from "./components/Logo";

const ROUTES: Record<AppRoute, { title: string; page: () => React.JSX.Element }> = {
  studio: { title: "Studio", page: StudioPage },
  projects: { title: "Projects", page: ProjectsPage },
  clips: { title: "My Clips", page: ClipsPage },
  editor: { title: "AI Editor", page: EditorPage },
  exports: { title: "Export Studio", page: () => <ExportsPage /> },
  templates: { title: "Templates & Brand Kit", page: TemplatesPage },
  publishing: { title: "Publishing Calendar", page: () => <PublishingPage variant="calendar" /> },
  "publishing-calendar": {
    title: "Publishing Calendar",
    page: () => <PublishingPage variant="calendar" />,
  },
  "publishing-queue": {
    title: "Publishing Queue",
    page: () => <PublishingPage variant="queue" />,
  },
  analytics: { title: "Analytics", page: AnalyticsPage },
  settings: { title: "Settings", page: SettingsPage },
  admin: { title: "Admin Console", page: AdminPage },
};

const AUTH_ROUTES: Record<string, () => React.JSX.Element> = {
  login: LoginPage,
  signup: SignupPage,
  "forgot-password": ForgotPasswordPage,
  "reset-password": ResetPasswordPage,
  "verify-email": VerifyEmailPage,
  "accept-invitation": AcceptInvitationPage,
};

interface WorkspaceTarget {
  /** Nav route to highlight in the shell. */
  route: AppRoute;
  title: string;
  page: () => React.JSX.Element;
}

/**
 * Resolve the hash path to a workspace target. Supports the original
 * hashes (#/studio, …), the /app/* aliases (#/app/studio, …), the
 * Phase 3 workflow sub-routes (studio/create, studio/enhance) and the
 * project detail route (projects/<id>). Landing anchors and unknown
 * paths return null, i.e. the landing page.
 */
function workspaceTarget(path: string): WorkspaceTarget | null {
  const clean = path.startsWith("app/") ? path.slice(4) : path;
  if (clean === "studio/create") {
    return { route: "studio", title: "Create Multiple Shorts", page: CreateShortsPage };
  }
  if (clean === "studio/enhance") {
    return { route: "studio", title: "Enhance Existing Video", page: EnhanceVideoPage };
  }
  const editor = /^projects\/([A-Za-z0-9-]+)\/editor$/.exec(clean);
  if (editor) {
    const id = editor[1];
    return { route: "editor", title: "Video Editor", page: () => <VideoEditorPage projectId={id} /> };
  }
  const exportsRoute = /^projects\/([A-Za-z0-9-]+)\/exports$/.exec(clean);
  if (exportsRoute) {
    const id = exportsRoute[1];
    return { route: "exports", title: "Export Studio", page: () => <ExportsPage projectId={id} /> };
  }
  const detail = /^projects\/([A-Za-z0-9-]+)$/.exec(clean);
  if (detail) {
    const id = detail[1];
    return { route: "projects", title: "Project", page: () => <ProjectDetailPage projectId={id} /> };
  }
  if ((Object.keys(ROUTES) as AppRoute[]).includes(clean as AppRoute)) {
    const entry = ROUTES[clean as AppRoute];
    // The legacy "publishing" hash highlights its modern nav item.
    const route = clean === "publishing" ? "publishing-calendar" : (clean as AppRoute);
    return { route, title: entry.title, page: entry.page };
  }
  return null;
}

function useHashPath(): string {
  const [path, setPath] = useState<string>(() => parseHash().path);
  useEffect(() => {
    const onHash = () => setPath(parseHash().path);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return path;
}

function LoadingScreen() {
  return (
    <div className={authStyles.loadingPage} role="status" aria-label="Checking your session">
      <Logo />
      <span className={authStyles.spinner} aria-hidden="true" />
      <p>Checking your session…</p>
    </div>
  );
}

function Shell() {
  const path = useHashPath();
  const { status } = useAuth();

  const authPage = AUTH_ROUTES[path];
  const target = workspaceTarget(path);

  // ---- Public auth routes ----
  if (authPage) {
    // Already signed in — no reason to show any auth form again.
    // One exception: an invitation link carrying a token is FOR a
    // signed-in invitee, so it must stay reachable while the token
    // is in the URL.
    const invitationWithToken =
      path === "accept-invitation" && Boolean(parseHash().params.get("token"));
    if (status === "authenticated" && !invitationWithToken) {
      navigateTo("app/studio");
      return <LoadingScreen />;
    }
    if ((path === "login" || path === "signup") && status === "loading") {
      return <LoadingScreen />;
    }
    const Page = authPage;
    return <Page />;
  }

  // ---- Protected workspace routes ----
  if (target) {
    if (status === "loading") return <LoadingScreen />;
    if (status === "anonymous") {
      // Preserve the intended destination safely (workspace routes
      // only — returnTarget() re-validates it on the way back).
      navigateTo(`login?return=${encodeURIComponent(path)}`);
      return <LoadingScreen />;
    }
    const Page = target.page;
    return (
      <AppShell route={target.route} title={target.title}>
        <Page />
      </AppShell>
    );
  }

  // ---- Landing (no hash, in-page anchors, unknown paths) ----
  return <HomePage />;
}

// Lightweight hash routing (no router dependency).
// Phase 2 added real auth routes and protected the workspace.
// Phase 3 adds the Studio workflows and project detail inside the
// same shell; the server session remains the source of truth.
export default function App() {
  return (
    <AuthProvider>
      <UploadProvider>
        <Shell />
      </UploadProvider>
    </AuthProvider>
  );
}
