// Typed client for the Phase 12 account API (server: /api/account,
// /api/workspaces, /api/notifications, /api/usage, /api/plans,
// /api/subscription, /api/privacy, /api/support, /api/payments).
// Built on the same session + CSRF plumbing as services/auth.ts.

import { API_BASE_URL } from "./api";
import { apiRequest, AuthApiError, fetchCsrfToken } from "./auth";

export interface AccountProfile {
  id: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  hasAvatar: boolean;
  avatarUrl: string | null;
  status: string;
  isAdmin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  language: string;
  timezone: string;
  profileCompletion: number;
}

export interface AccountPreferences {
  language: string;
  timezone: string;
  dateFormat: string;
  timeFormat: string;
  defaultAspectRatio: string;
  defaultExportResolution: string;
  captionLanguage: string;
  defaultCaptionTemplateId: string | null;
  defaultBrandKitId: string | null;
  defaultWorkspaceId: string | null;
  editorPrefs: Record<string, unknown>;
  updatedAt: string;
}

export interface AccountSession {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastActiveAt: string | null;
  expiresAt: string;
  current: boolean;
}

export interface LoginEvent {
  id: string;
  type: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface MfaStatus {
  totp: {
    available: boolean;
    enabled: boolean;
    confirmedAt: string | null;
    recoveryCodesRemaining: number;
  };
  emailMfa: { available: boolean; reason: string };
}

export interface ConnectedAccount {
  id: string;
  platform: string;
  displayName: string | null;
  status: string;
  connectedAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  ownerUserId: string;
  hasLogo: boolean;
  logoUrl: string | null;
  settings: Record<string, unknown>;
  status: string;
  isPersonal: boolean;
  myRole: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMember {
  userId: string;
  displayName: string;
  email: string;
  role: string;
  status: string;
  joinedAt: string;
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}

export interface PendingInvitation {
  id: string;
  workspaceId: string;
  workspaceName: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}

export interface AppNotification {
  id: string;
  category: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPreference {
  category: string;
  inApp: boolean;
  email: boolean;
  browser: boolean;
}

export interface UsageLimit {
  key: string;
  limit: number | null;
  used: number | null;
  unit: string | null;
}

export interface UsageOverview {
  periodDays: number;
  totals: { operation: string; resource: string; unit: string; qty: number; n: number }[];
  period: { operation: string; resource: string; unit: string; qty: number; n: number }[];
  history: { day: string; operation: string; qty: number; n: number }[];
  failedOperations: number;
  storage: {
    sourceBytes: number;
    outputBytes: number;
    projectMediaBytes: number;
    totalBytes: number;
    measuredAt: string;
  };
  publishing: { publishedPosts: number; connectedAccounts: number };
  plan: {
    key: string;
    name: string;
    status: string;
    limits: UsageLimit[];
    limitsConfigured: boolean;
  } | null;
  lastUpdated: string;
}

export interface UsageEntry {
  id: string;
  workspaceId: string | null;
  projectId: string | null;
  jobId: string | null;
  operation: string;
  provider: string | null;
  resource: string;
  unit: string;
  quantity: number;
  status: string;
  createdAt: string;
}

export interface PlanEntitlement {
  key: string;
  limit: number | null;
  featureEnabled: boolean | null;
}

export interface Plan {
  id: string;
  key: string;
  name: string;
  description: string;
  monthlyPriceCents: number | null;
  annualPriceCents: number | null;
  currency: string;
  isActive: boolean;
  entitlements: PlanEntitlement[];
}

export interface PaymentsStatus {
  enabled: boolean;
  provider: string | null;
  missing: string[];
}

export interface Subscription {
  subscription: {
    id: string;
    status: string;
    source: string;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelRequestedAt: string | null;
    plan: Plan;
  } | null;
  history: { id: string; type: string; detail: unknown; createdAt: string }[];
  invoices: {
    id: string;
    amountCents: number;
    currency: string;
    status: string;
    provider: string | null;
    issuedAt: string;
  }[];
  payments: PaymentsStatus;
}

export interface DataExportJob {
  id: string;
  status: string;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  downloadUrl: string | null;
}

export interface SupportTicket {
  id: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface SupportMessage {
  id: string;
  authorKind: string;
  body: string;
  createdAt: string;
}

/** Build the AuthApiError for a failed upload response, parsing BOTH
 *  server error shapes exactly like request() in services/auth.ts:
 *  the { error: "…" } string form and the { error: { code, message } }
 *  object form (plus a top-level `code`), classified the same way. */
function uploadApiError(status: number, data: Record<string, unknown>): AuthApiError {
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
  if (status === 400 || status === 409 || status === 403 || status === 429) {
    return new AuthApiError("validation", status, message, code);
  }
  if (status === 401) {
    return new AuthApiError("credentials", status, message, code);
  }
  return new AuthApiError("server", status, message, code);
}

async function uploadForm<T>(url: string, form: FormData): Promise<T> {
  const csrf = await fetchCsrfToken();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "X-CSRF-Token": csrf },
      credentials: "include",
      body: form,
    });
  } catch {
    throw new AuthApiError(
      "network",
      0,
      "Cannot reach the server. Check that the CLIPFORGE server is running, then try again.",
    );
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw uploadApiError(res.status, data);
  }
  return data as T;
}

export const accountApi = {
  // ---- profile / preferences ----
  getProfile(): Promise<{ profile: AccountProfile }> {
    return apiRequest("/account/profile");
  },
  updateProfile(input: { displayName: string }): Promise<{ profile: AccountProfile }> {
    return apiRequest("/account/profile", { method: "PATCH", body: input });
  },
  uploadAvatar(file: File): Promise<{ ok: boolean; avatarUrl: string }> {
    const form = new FormData();
    form.append("image", file);
    return uploadForm(`${API_BASE_URL}/account/avatar`, form);
  },
  removeAvatar(): Promise<{ ok: boolean }> {
    return apiRequest("/account/avatar", { method: "DELETE" });
  },
  requestEmailChange(input: { newEmail: string; currentPassword: string }): Promise<{
    ok: boolean;
    delivery: string;
    deliveryNote: string;
  }> {
    return apiRequest("/account/email-change", { method: "POST", body: input });
  },
  confirmEmailChange(token: string): Promise<{ profile: AccountProfile }> {
    return apiRequest("/account/email-change/confirm", { method: "POST", body: { token } });
  },
  getPreferences(): Promise<{ preferences: AccountPreferences }> {
    return apiRequest("/account/preferences");
  },
  updatePreferences(input: Partial<AccountPreferences>): Promise<{ preferences: AccountPreferences }> {
    return apiRequest("/account/preferences", { method: "PUT", body: input });
  },

  // ---- security ----
  changePassword(input: {
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
  }): Promise<{ ok: boolean }> {
    return apiRequest("/account/change-password", { method: "POST", body: input });
  },
  listSessions(): Promise<{ sessions: AccountSession[] }> {
    return apiRequest("/account/sessions");
  },
  revokeSession(id: string): Promise<{ ok: boolean }> {
    return apiRequest(`/account/sessions/${id}`, { method: "DELETE" });
  },
  revokeOtherSessions(): Promise<{ ok: boolean; revoked: number }> {
    return apiRequest("/account/sessions/revoke-others", { method: "POST", body: {} });
  },
  loginActivity(): Promise<{ events: LoginEvent[] }> {
    return apiRequest("/account/login-activity");
  },
  getMfa(): Promise<MfaStatus> {
    return apiRequest("/account/mfa");
  },
  setupMfa(input: { currentPassword: string }): Promise<{ secret: string; otpauthUrl: string }> {
    return apiRequest("/account/mfa/setup", { method: "POST", body: input });
  },
  confirmMfa(input: { code: string }): Promise<{ ok: boolean; recoveryCodes: string[] }> {
    return apiRequest("/account/mfa/confirm", { method: "POST", body: input });
  },
  disableMfa(input: { currentPassword: string; code?: string }): Promise<{ ok: boolean }> {
    return apiRequest("/account/mfa/disable", { method: "POST", body: input });
  },
  regenerateRecoveryCodes(input: { currentPassword: string }): Promise<{ ok: boolean; recoveryCodes: string[] }> {
    return apiRequest("/account/mfa/recovery-codes/regenerate", { method: "POST", body: input });
  },
  connectedAccounts(): Promise<{ accounts: ConnectedAccount[] }> {
    return apiRequest("/account/connected-accounts");
  },

  // ---- workspaces ----
  listWorkspaces(): Promise<{
    workspaces: Workspace[];
    activeWorkspaceId: string | null;
    defaultWorkspaceId: string | null;
  }> {
    return apiRequest("/workspaces");
  },
  createWorkspace(input: { name: string }): Promise<{ workspace: Workspace }> {
    return apiRequest("/workspaces", { method: "POST", body: input });
  },
  renameWorkspace(id: string, name: string): Promise<{ workspace: Workspace }> {
    return apiRequest(`/workspaces/${id}`, { method: "PATCH", body: { name } });
  },
  uploadWorkspaceLogo(id: string, file: File): Promise<{ ok: boolean; logoUrl: string }> {
    const form = new FormData();
    form.append("image", file);
    return uploadForm(`${API_BASE_URL}/workspaces/${id}/logo`, form);
  },
  switchWorkspace(id: string): Promise<{ ok: boolean; activeWorkspaceId: string }> {
    return apiRequest(`/workspaces/${id}/switch`, { method: "POST", body: {} });
  },
  setDefaultWorkspace(id: string): Promise<{ ok: boolean }> {
    return apiRequest(`/workspaces/${id}/default`, { method: "POST", body: {} });
  },
  archiveWorkspace(id: string): Promise<{ ok: boolean }> {
    return apiRequest(`/workspaces/${id}/archive`, { method: "POST", body: {} });
  },
  deleteWorkspace(id: string, confirmName: string): Promise<{ ok: boolean }> {
    return apiRequest(`/workspaces/${id}`, { method: "DELETE", body: { confirmName } });
  },
  listMembers(id: string): Promise<{ members: WorkspaceMember[]; pendingInvitations: WorkspaceInvitation[] }> {
    return apiRequest(`/workspaces/${id}/members`);
  },
  changeMemberRole(id: string, userId: string, role: string): Promise<{ ok: boolean }> {
    return apiRequest(`/workspaces/${id}/members/${userId}`, { method: "PATCH", body: { role } });
  },
  removeMember(id: string, userId: string): Promise<{ ok: boolean }> {
    return apiRequest(`/workspaces/${id}/members/${userId}`, { method: "DELETE" });
  },
  inviteMember(
    id: string,
    input: { email: string; role: string },
  ): Promise<{ invitation: WorkspaceInvitation; delivery: string; deliveryNote: string }> {
    return apiRequest(`/workspaces/${id}/invitations`, { method: "POST", body: input });
  },
  revokeInvitation(id: string, inviteId: string): Promise<{ ok: boolean }> {
    return apiRequest(`/workspaces/${id}/invitations/${inviteId}`, { method: "DELETE" });
  },
  pendingInvitations(): Promise<{ invitations: PendingInvitation[] }> {
    return apiRequest("/invitations/pending");
  },
  acceptInvitation(token: string): Promise<{ ok: boolean; workspace: Workspace }> {
    return apiRequest("/invitations/accept", { method: "POST", body: { token } });
  },
  rejectInvitation(token: string): Promise<{ ok: boolean }> {
    return apiRequest("/invitations/reject", { method: "POST", body: { token } });
  },

  // ---- notifications ----
  listNotifications(limit = 30): Promise<{ notifications: AppNotification[]; unreadCount: number }> {
    return apiRequest(`/notifications?limit=${limit}`);
  },
  markNotificationRead(id: string): Promise<{ ok: boolean }> {
    return apiRequest(`/notifications/${id}/read`, { method: "POST", body: {} });
  },
  markAllNotificationsRead(): Promise<{ ok: boolean; marked: number }> {
    return apiRequest("/notifications/read-all", { method: "POST", body: {} });
  },
  clearNotifications(): Promise<{ ok: boolean; cleared: number }> {
    return apiRequest("/notifications", { method: "DELETE" });
  },
  getNotificationPreferences(): Promise<{
    preferences: NotificationPreference[];
    emailDelivery: string;
    emailDeliveryNote: string;
  }> {
    return apiRequest("/notifications/preferences");
  },
  updateNotificationPreferences(
    preferences: NotificationPreference[],
  ): Promise<{ preferences: NotificationPreference[] }> {
    return apiRequest("/notifications/preferences", {
      method: "PUT",
      body: {
        preferences: preferences.map((p) => ({
          category: p.category,
          inApp: p.inApp,
          email: p.email,
          browser: p.browser,
        })),
      },
    });
  },

  // ---- usage / plans / subscription ----
  usageOverview(days = 30): Promise<UsageOverview> {
    return apiRequest(`/usage/overview?days=${days}`);
  },
  usageHistory(page = 1, pageSize = 25): Promise<{
    entries: UsageEntry[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    return apiRequest(`/usage/history?page=${page}&pageSize=${pageSize}`);
  },
  listPlans(): Promise<{ plans: Plan[]; payments: PaymentsStatus; note: string }> {
    return apiRequest("/plans");
  },
  getSubscription(): Promise<Subscription> {
    return apiRequest("/subscription");
  },
  requestCancellation(): Promise<{ ok: boolean; note: string }> {
    return apiRequest("/subscription/cancel-request", { method: "POST", body: {} });
  },
  checkout(input: { planId: string; interval: "monthly" | "annual" }): Promise<never> {
    return apiRequest("/subscription/checkout", { method: "POST", body: input });
  },

  // ---- privacy ----
  requestDataExport(): Promise<{ job: { id: string; status: string; createdAt: string } }> {
    return apiRequest("/privacy/data-export", { method: "POST", body: {} });
  },
  listDataExports(): Promise<{ exports: DataExportJob[] }> {
    return apiRequest("/privacy/data-exports");
  },
  dataExportDownloadUrl(id: string): string {
    return `${API_BASE_URL}/privacy/data-exports/${id}/download`;
  },
  requestAccountDeletion(input: {
    currentPassword: string;
    confirmText: string;
  }): Promise<{ job: { id: string; status: string }; warning: string }> {
    return apiRequest("/privacy/account-deletion", { method: "POST", body: input });
  },

  // ---- support ----
  createTicket(input: {
    subject: string;
    category: string;
    priority: string;
    body: string;
  }): Promise<{ ticket: SupportTicket; deliveryNote: string }> {
    return apiRequest("/support/tickets", { method: "POST", body: input });
  },
  listTickets(): Promise<{ tickets: SupportTicket[] }> {
    return apiRequest("/support/tickets");
  },
  getTicket(id: string): Promise<{ ticket: SupportTicket & { messages: SupportMessage[] } }> {
    return apiRequest(`/support/tickets/${id}`);
  },
  postTicketMessage(id: string, body: string): Promise<{ ok: boolean; messages: SupportMessage[] }> {
    return apiRequest(`/support/tickets/${id}/messages`, { method: "POST", body: { body } });
  },
};
