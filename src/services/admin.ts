// Typed client for the Phase 12 Admin Console API (server:
// /api/admin/*). Every call is gated server-side by the admin flag;
// this client only shapes requests.

import { apiRequest } from "./auth";
import type { Plan } from "./account";

export interface AdminOverview {
  users: number;
  activeUsers: number;
  suspendedUsers: number;
  workspaces: number;
  projects: number;
  mediaAssets: number;
  analysisJobs: number;
  generatedClips: number;
  trackingJobs: number;
  exportJobs: number;
  completedExports: number;
  failedJobs: number;
  publishedPosts: number;
  connectedAccounts: number;
  platformAccounts: number;
  storageBytes: number;
  openSupportTickets: number;
  workers: string;
  generatedAt: string;
}

export interface AdminUser {
  id: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  status: string;
  isAdmin: boolean;
  hasAvatar: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AdminProvider {
  key: string;
  displayName: string;
  category: string;
  operations: string[];
  configured: boolean;
  configDetail: string;
  enabled: boolean;
  secretRef: string | null;
  lastHealthStatus: string | null;
  lastHealthAt: string | null;
  lastError: string | null;
}

export interface HealthCheck {
  key: string;
  label: string;
  status: string;
  detail: string;
}

export interface AuditLogEntry {
  id: string;
  actorUserId: string | null;
  workspaceId: string | null;
  eventType: string;
  targetType: string | null;
  targetId: string | null;
  result: string;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

export const adminApi = {
  overview(): Promise<AdminOverview> {
    return apiRequest("/admin/overview");
  },
  listUsers(params: { search?: string; status?: string; page?: number } = {}): Promise<{
    users: AdminUser[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const q = new URLSearchParams();
    if (params.search) q.set("search", params.search);
    if (params.status) q.set("status", params.status);
    if (params.page) q.set("page", String(params.page));
    return apiRequest(`/admin/users?${q.toString()}`);
  },
  getUser(id: string): Promise<{
    user: AdminUser;
    workspaces: { id: string; name: string; status: string; isPersonal: boolean; role: string }[];
    usage: { operation: string; resource: string; unit: string; qty: number; n: number }[];
    subscription: { status: string; source: string; plan: Plan } | null;
    projectCount: number;
  }> {
    return apiRequest(`/admin/users/${id}`);
  },
  suspendUser(id: string): Promise<{ ok: boolean; user: AdminUser }> {
    return apiRequest(`/admin/users/${id}/suspend`, { method: "POST", body: { confirm: true } });
  },
  reactivateUser(id: string): Promise<{ ok: boolean; user: AdminUser }> {
    return apiRequest(`/admin/users/${id}/reactivate`, { method: "POST", body: {} });
  },
  initiateRecovery(id: string): Promise<{ ok: boolean; delivery: string; deliveryNote: string }> {
    return apiRequest(`/admin/users/${id}/recovery`, { method: "POST", body: {} });
  },
  assignPlan(id: string, planId: string): Promise<{ ok: boolean; plan: Plan }> {
    return apiRequest(`/admin/users/${id}/plan`, { method: "POST", body: { planId } });
  },
  listWorkspaces(): Promise<{
    workspaces: {
      id: string;
      name: string;
      ownerUserId: string;
      status: string;
      isPersonal: boolean;
      memberCount: number;
      projectCount: number;
      createdAt: string;
    }[];
  }> {
    return apiRequest("/admin/workspaces");
  },
  listProjects(): Promise<{
    projects: {
      id: string;
      name: string;
      workflow_type: string;
      status: string;
      user_id: string;
      workspace_id: string | null;
      owner_email: string;
      created_at: string;
      updated_at: string;
    }[];
  }> {
    return apiRequest("/admin/projects");
  },
  listJobs(): Promise<{
    jobs: { kind: string; id: string; user_id: string; project_id: string; status: string; created_at: string; updated_at: string }[];
  }> {
    return apiRequest("/admin/jobs");
  },
  renderQueue(): Promise<{
    jobs: {
      id: string;
      kind: string;
      user_id: string;
      project_id: string;
      status: string;
      stage: string;
      worker_id: string | null;
      created_at: string;
      updated_at: string;
    }[];
  }> {
    return apiRequest("/admin/render-queue");
  },
  publishingJobs(): Promise<{
    jobs: {
      id: string;
      user_id: string;
      platform: string;
      status: string;
      scheduled_for_utc: string | null;
      created_at: string;
      updated_at: string;
    }[];
  }> {
    return apiRequest("/admin/publishing-jobs");
  },
  listProviders(): Promise<{ providers: AdminProvider[] }> {
    return apiRequest("/admin/providers");
  },
  testProvider(key: string): Promise<{ key: string; status: string; detail: string; checkedAt: string }> {
    return apiRequest(`/admin/providers/${key}/test`, { method: "POST", body: {} });
  },
  updateProvider(
    key: string,
    input: { enabled?: boolean; secretRef?: string | null },
  ): Promise<{ provider: AdminProvider }> {
    return apiRequest(`/admin/providers/${key}`, { method: "PATCH", body: input });
  },
  integrations(): Promise<{
    platforms: { platform: string; configured: boolean; missing: string[]; accounts: number; connected: number }[];
    tokenEncryption: { ready: boolean; mode: string };
    email: { configured: boolean; mode: string };
    payments: { enabled: boolean; provider: string | null; missing: string[] };
  }> {
    return apiRequest("/admin/integrations");
  },
  usage(): Promise<{
    byOperation: { operation: string; resource: string; unit: string; qty: number; n: number }[];
    byUser: { user_id: string; email: string; entries: number; total_quantity: number }[];
    totalEntries: number;
  }> {
    return apiRequest("/admin/usage");
  },
  listPlans(): Promise<{ plans: Plan[] }> {
    return apiRequest("/admin/plans");
  },
  createPlan(input: {
    key: string;
    name: string;
    description?: string;
    monthlyPriceCents?: number | null;
    annualPriceCents?: number | null;
    currency?: string;
  }): Promise<{ plan: Plan }> {
    return apiRequest("/admin/plans", { method: "POST", body: input });
  },
  updatePlan(
    id: string,
    input: {
      name?: string;
      description?: string;
      monthlyPriceCents?: number | null;
      annualPriceCents?: number | null;
      currency?: string;
      isActive?: boolean;
    },
  ): Promise<{ plan: Plan }> {
    return apiRequest(`/admin/plans/${id}`, { method: "PATCH", body: input });
  },
  setEntitlements(
    id: string,
    entitlements: { key: string; limit?: number | null; featureEnabled?: boolean | null }[],
  ): Promise<{ plan: Plan }> {
    return apiRequest(`/admin/plans/${id}/entitlements`, { method: "PUT", body: { entitlements } });
  },
  listReports(): Promise<{
    reports: { id: string; user_id: string; name: string; status: string; created_at: string; owner_email: string }[];
  }> {
    return apiRequest("/admin/reports");
  },
  auditLogs(params: { eventType?: string; page?: number } = {}): Promise<{
    logs: AuditLogEntry[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const q = new URLSearchParams();
    if (params.eventType) q.set("eventType", params.eventType);
    if (params.page) q.set("page", String(params.page));
    return apiRequest(`/admin/audit-logs?${q.toString()}`);
  },
  systemHealth(): Promise<{ checks: HealthCheck[]; checkedAt: string }> {
    return apiRequest("/admin/system-health");
  },
  listTickets(): Promise<{
    tickets: {
      id: string;
      user_id: string;
      subject: string;
      category: string;
      priority: string;
      status: string;
      user_email: string;
      user_name: string;
      created_at: string;
      updated_at: string;
    }[];
  }> {
    return apiRequest("/admin/support/tickets");
  },
  getTicket(id: string): Promise<{
    ticket: Record<string, string> & {
      messages: { id: string; authorKind: string; body: string; createdAt: string }[];
    };
  }> {
    return apiRequest(`/admin/support/tickets/${id}`);
  },
  replyTicket(id: string, body: string): Promise<{ ok: boolean }> {
    return apiRequest(`/admin/support/tickets/${id}/messages`, { method: "POST", body: { body } });
  },
  setTicketStatus(id: string, status: string): Promise<{ ok: boolean }> {
    return apiRequest(`/admin/support/tickets/${id}`, { method: "PATCH", body: { status } });
  },
};
