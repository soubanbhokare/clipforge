// Phase 10 — Publishing Center.
//
// Everything on this page is real data from the Phase 10 API:
// accounts exist only after a real OAuth flow with the platform,
// jobs publish only after explicit approval, and a job shows
// PUBLISHED only when the platform's own status said so. Providers
// whose OAuth credentials are not configured on the server are
// shown as such, with the missing variable names — and clicking
// Connect still surfaces the server's configuration error naming
// them — nothing here is a sample or a simulation.
//
// Publishing NEVER adds a watermark to an upload: CLIPFORGE sends
// the exported file to the platform exactly as Phase 9 rendered it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { navigateTo } from "../features/auth/routing";
import { exportsApi, type ExportHistoryEntry } from "../services/export";
import { projectsApi } from "../services/projects";
import {
  defaultMetadataFor,
  exportDownloadUrl,
  publishingApi,
  type CalendarEvent,
  type InstagramMetadata,
  type Platform,
  type PlatformAccount,
  type PlatformMetadata,
  type ProviderStatus,
  type PublishAttempt,
  type PublishJob,
  type TiktokMetadata,
  type ValidationResult,
  type YoutubeMetadata,
} from "../services/publishing";
import styles from "./PublishingPage.module.css";

type Tab = "accounts" | "publish" | "calendar" | "queue" | "history" | "settings";

const PLATFORM_LABEL: Record<Platform, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
};

const TIMEZONES = [
  "Asia/Kolkata",
  "UTC",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Australia/Sydney",
];

/** The viewer's own browser timezone — the default wherever a
 *  timezone is picked, instead of a hardcoded zone. */
const BROWSER_TZ = ((): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata";
  } catch {
    return "Asia/Kolkata";
  }
})();

/** TIMEZONES plus the current value, so a select never holds a
 *  value that is missing from its own options. */
function tzOptions(current: string): string[] {
  return TIMEZONES.includes(current) ? TIMEZONES : [current, ...TIMEZONES];
}

const ACTIVE_STATUSES = new Set(["VALIDATING", "QUEUED", "UPLOADING", "SUBMITTED", "PLATFORM_PROCESSING"]);
const EDITABLE_STATUSES = new Set(["DRAFT", "AWAITING_APPROVAL", "FAILED", "AUTH_REQUIRED"]);

function errText(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

function fmtDateTime(iso: string | null | undefined, tz?: string): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: tz,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function jobTitle(job: PublishJob): string {
  const m = job.metadata as unknown as Record<string, unknown>;
  const t = (m.title as string) || (m.caption as string) || "";
  return t.trim() || job.export?.filename || "Untitled post";
}

function StatusPill({ status }: { status: string }) {
  const cls =
    status === "PUBLISHED" || status === "CONNECTED"
      ? styles.statusOk
      : status === "FAILED" || status === "AUTH_REQUIRED" || status === "CANCELLED"
        ? styles.statusBad
        : "";
  return <span className={`${styles.statusPill} ${cls}`}>{status.replace(/_/g, " ")}</span>;
}

// ===========================================================================
// Connected Accounts
// ===========================================================================

// Renders the capability object EXACTLY as the adapters store it
// (server/src/providers.ts getCapabilities): the stored shape has
// no `platform` field, so the platform comes from the account, and
// the field names below are the adapters' own (maxTitleChars,
// unsupportedReason, supportsCustomThumbnail, creatorUsername, …).
function CapabilitiesView({ caps, platform }: { caps: Record<string, unknown>; platform: Platform }) {
  const rows: [string, string][] = [];
  const push = (k: string, v: unknown) => {
    if (v == null) return;
    rows.push([k, Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v)]);
  };
  const plat = (caps.platform as Platform | undefined) ?? platform;
  if (plat === "youtube") {
    push("Max title length", caps.maxTitleChars != null ? `${String(caps.maxTitleChars)} characters` : null);
    push("Max description length", caps.maxDescriptionChars != null ? `${String(caps.maxDescriptionChars)} characters` : null);
    push("Max tags total length", caps.maxTagsTotalChars != null ? `${String(caps.maxTagsTotalChars)} characters` : null);
    push("Max file size", typeof caps.maxFileSizeBytes === "number" ? fmtBytes(caps.maxFileSizeBytes) : null);
    push(
      "Native scheduling (publishAt)",
      caps.supportsNativeScheduling
        ? `supported${caps.nativeSchedulingRequires ? ` — ${String(caps.nativeSchedulingRequires)}` : ""}`
        : caps.supportsNativeScheduling === false
          ? "not available"
          : null,
    );
    push("Custom thumbnails", caps.supportsCustomThumbnail === true ? "supported" : caps.supportsCustomThumbnail === false ? "not supported" : null);
    push("Shorts", caps.supportsShorts === true ? "supported" : caps.supportsShorts === false ? "not supported" : null);
    const cats = caps.categories as { id: string; title: string }[] | undefined;
    if (cats?.length) push("Categories", cats.map((c) => `${c.id} ${c.title}`).join(" · "));
  } else if (plat === "instagram") {
    push("Account type", caps.accountType);
    push(
      "Publishing supported",
      caps.publishSupported === true
        ? "yes"
        : caps.publishSupported === false
          ? `no — ${String(caps.unsupportedReason ?? "This account type cannot publish via the Instagram API.")}`
          : null,
    );
    push("Formats", caps.formats);
    push("Max caption length", caps.maxCaptionChars != null ? `${String(caps.maxCaptionChars)} characters` : null);
    push("Max duration", caps.maxDurationSec != null ? `${String(caps.maxDurationSec)} seconds` : null);
    push("Max file size", typeof caps.maxFileSizeBytes === "number" ? fmtBytes(caps.maxFileSizeBytes) : null);
    push(
      "Native scheduling",
      caps.supportsNativeScheduling === true
        ? "supported"
        : caps.supportsNativeScheduling === false
          ? "not available — CLIPFORGE submits at the chosen time"
          : null,
    );
    push("Custom cover frame (thumb offset)", caps.supportsThumbOffset === true ? "supported" : caps.supportsThumbOffset === false ? "not supported" : null);
  } else if (plat === "tiktok") {
    push("Creator username", caps.creatorUsername);
    push("Privacy options (from creator info)", caps.privacyLevelOptions);
    push("Comment allowed", typeof caps.commentDisabled === "boolean" ? (caps.commentDisabled ? "no" : "yes") : null);
    push("Duet allowed", typeof caps.duetDisabled === "boolean" ? (caps.duetDisabled ? "no" : "yes") : null);
    push("Stitch allowed", typeof caps.stitchDisabled === "boolean" ? (caps.stitchDisabled ? "no" : "yes") : null);
    push("Max video duration (s)", caps.maxVideoPostDurationSec);
    push("Max caption length", caps.maxCaptionChars != null ? `${String(caps.maxCaptionChars)} characters` : null);
    push(
      "Native scheduling",
      caps.supportsNativeScheduling === true
        ? "supported"
        : caps.supportsNativeScheduling === false
          ? "not available — CLIPFORGE submits at the chosen time"
          : null,
    );
  }
  if (rows.length === 0) return <p className={styles.muted}>No capability data returned.</p>;
  return (
    <dl className={styles.kvList}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function AccountsTab({ onChanged }: { onChanged: () => void }) {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [caps, setCaps] = useState<Record<string, Record<string, unknown> | null>>({});

  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([publishingApi.providers(), publishingApi.accounts()]);
      setProviders(p.providers);
      setAccounts(a.accounts);
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = async (platform: Platform) => {
    setBusy(platform);
    setError(null);
    try {
      const { authUrl } = await publishingApi.connect(platform);
      window.location.href = authUrl;
    } catch (err) {
      setError(errText(err));
      setBusy(null);
    }
  };

  const disconnect = async (account: PlatformAccount) => {
    setBusy(account.id);
    try {
      await publishingApi.disconnect(account.id);
      setConfirming(null);
      await load();
      onChanged();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const refresh = async (account: PlatformAccount) => {
    setBusy(account.id);
    setError(null);
    try {
      await publishingApi.refreshAccount(account.id);
      await load();
      onChanged();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const showCaps = async (account: PlatformAccount) => {
    setBusy(account.id);
    try {
      const res = await publishingApi.capabilities(account.id, true);
      setCaps((prev) => ({ ...prev, [account.id]: res.capabilities }));
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      {error && <p className={styles.errorBanner}>{error}</p>}
      <div className={styles.grid3}>
        {providers.map((provider) => {
          const platformAccounts = accounts.filter((a) => a.platform === provider.platform);
          return (
            <div className={styles.card} key={provider.platform}>
              <div>
                <span className={styles.platformBadge}>{PLATFORM_LABEL[provider.platform]}</span>
                <h2 style={{ marginTop: 4 }}>{PLATFORM_LABEL[provider.platform]}</h2>
              </div>
              {!provider.configured ? (
                <>
                  <p className={styles.muted}>
                    This integration is not configured on the server yet. Add the official{" "}
                    {PLATFORM_LABEL[provider.platform]} developer-app credentials to the server
                    environment to enable connecting accounts:
                  </p>
                  <p className={styles.hint}>Missing: {provider.missing.join(", ")}</p>
                  <button
                    className={styles.primaryButton}
                    disabled={busy === provider.platform}
                    onClick={() => void connect(provider.platform)}
                  >
                    {busy === provider.platform ? "Opening…" : `Connect ${PLATFORM_LABEL[provider.platform]}`}
                  </button>
                </>
              ) : platformAccounts.length === 0 ? (
                <>
                  <p className={styles.muted}>
                    No {PLATFORM_LABEL[provider.platform]} account is connected. Connecting opens
                    the official {PLATFORM_LABEL[provider.platform]} sign-in — CLIPFORGE never
                    sees your password, and access tokens are stored encrypted on the server.
                  </p>
                  <p className={styles.hint}>Scopes requested: {provider.scopes.join(", ")}</p>
                  <button
                    className={styles.primaryButton}
                    disabled={busy === provider.platform}
                    onClick={() => void connect(provider.platform)}
                  >
                    {busy === provider.platform ? "Opening…" : `Connect ${PLATFORM_LABEL[provider.platform]}`}
                  </button>
                </>
              ) : (
                <>
                  <p className={styles.muted}>
                    {platformAccounts.length} account{platformAccounts.length > 1 ? "s" : ""}{" "}
                    connected — see below. Connecting again adds another account.
                  </p>
                  <button
                    className={styles.secondaryButton}
                    disabled={busy === provider.platform}
                    onClick={() => void connect(provider.platform)}
                  >
                    Connect another
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {accounts.length === 0 ? (
        <div className={styles.card}>
          <h2>No connected accounts</h2>
          <p className={styles.muted}>
            Nothing is published anywhere until you connect an account above and explicitly
            approve a post. There are no sample accounts.
          </p>
        </div>
      ) : (
        accounts.map((account) => (
          <div className={styles.card} key={account.id}>
            <div className={styles.accountHead}>
              {account.profileImageUrl ? (
                <img className={styles.avatar} src={account.profileImageUrl} alt="" />
              ) : (
                <div className={styles.avatarFallback}>
                  {(account.username ?? account.displayName ?? "?").slice(0, 1).toUpperCase()}
                </div>
              )}
              <div style={{ flex: 1 }}>
                <span className={styles.platformBadge}>{PLATFORM_LABEL[account.platform]}</span>
                <div style={{ fontWeight: 600 }}>{account.displayName ?? account.username ?? account.platformAccountId}</div>
                <div className={styles.hint}>
                  {account.username ? `@${account.username.replace(/^@/, "")}` : ""}{" "}
                  {account.accountType ? `· ${account.accountType}` : ""}
                </div>
              </div>
              <StatusPill status={account.status} />
            </div>
            <dl className={styles.kvList}>
              <dt>Granted scopes</dt>
              <dd>{account.grantedScopes.join(", ") || "—"}</dd>
              <dt>Token expires</dt>
              <dd>{account.tokenExpiresAt ? fmtDateTime(account.tokenExpiresAt) : "Long-lived / no expiry reported"}</dd>
              <dt>Last synced</dt>
              <dd>{fmtDateTime(account.lastSyncedAt)}</dd>
            </dl>
            {account.status === "AUTH_REQUIRED" && (
              <p className={styles.errorBanner}>
                This account's authorization expired or was revoked. Refresh it, or disconnect and
                reconnect the account.
              </p>
            )}
            {caps[account.id] && <CapabilitiesView caps={caps[account.id]!} platform={account.platform} />}
            <div className={styles.buttonRow}>
              <button className={styles.smallButton} disabled={busy === account.id} onClick={() => void showCaps(account)}>
                Capabilities
              </button>
              <button className={styles.smallButton} disabled={busy === account.id} onClick={() => void refresh(account)}>
                Refresh token
              </button>
              {confirming === account.id ? (
                <>
                  <span className={styles.hint}>Disconnect and delete the stored tokens?</span>
                  <button className={styles.smallButtonDanger} disabled={busy === account.id} onClick={() => void disconnect(account)}>
                    Confirm disconnect
                  </button>
                  <button className={styles.smallButton} onClick={() => setConfirming(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <button className={styles.smallButtonDanger} disabled={busy === account.id} onClick={() => setConfirming(account.id)}>
                  Disconnect
                </button>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ===========================================================================
// Per-platform metadata editors
// ===========================================================================

function YoutubeEditor({
  value,
  onChange,
  categories,
  disabled,
}: {
  value: YoutubeMetadata;
  onChange: (m: YoutubeMetadata) => void;
  categories: { id: string; title: string }[];
  disabled: boolean;
}) {
  const set = (patch: Partial<YoutubeMetadata>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.formGrid}>
      <label className={styles.field}>
        Title (max 100)
        <input value={value.title} disabled={disabled} maxLength={100} onChange={(e) => set({ title: e.target.value })} />
        <span className={styles.hint}>{value.title.length} / 100 characters</span>
      </label>
      <label className={styles.field}>
        Category
        <select value={value.categoryId} disabled={disabled || categories.length === 0} onChange={(e) => set({ categoryId: e.target.value })}>
          {categories.length ? (
            categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id} — {c.title}
              </option>
            ))
          ) : (
            <option value={value.categoryId}>{value.categoryId} — server categories unavailable</option>
          )}
        </select>
        {categories.length === 0 && (
          <span className={styles.hint}>
            Categories unavailable — the server returned none for this account. Use Capabilities
            on the account card in Connected Accounts to refresh them; no local default is
            substituted.
          </span>
        )}
      </label>
      <label className={styles.field}>
        Privacy
        <select value={value.privacy} disabled={disabled} onChange={(e) => set({ privacy: e.target.value as YoutubeMetadata["privacy"] })}>
          <option value="private">Private</option>
          <option value="unlisted">Unlisted</option>
          <option value="public">Public</option>
        </select>
      </label>
      <label className={styles.field}>
        Description (max 5000)
        <textarea value={value.description} disabled={disabled} maxLength={5000} onChange={(e) => set({ description: e.target.value })} />
        <span className={styles.hint}>{value.description.length} / 5000 characters</span>
      </label>
      <label className={styles.field}>
        Tags (comma separated, max 500 characters total)
        <input
          value={value.tags.join(", ")}
          disabled={disabled}
          maxLength={500 + Math.max(0, value.tags.length - 1)}
          onChange={(e) => set({ tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })}
        />
        <span className={styles.hint}>
          {/* Server counts tags exactly this way: join(",").length */}
          {value.tags.join(",").length} / 500 characters across all tags
        </span>
      </label>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={value.madeForKids} disabled={disabled} onChange={(e) => set({ madeForKids: e.target.checked })} />
          Made for kids (audience declaration)
        </label>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={value.containsSyntheticMedia} disabled={disabled} onChange={(e) => set({ containsSyntheticMedia: e.target.checked })} />
          Contains synthetic / AI-altered media (disclosed to YouTube)
        </label>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={value.paidPromotion} disabled={disabled} onChange={(e) => set({ paidPromotion: e.target.checked })} />
          Paid promotion (declared in the description)
        </label>
      </div>
    </div>
  );
}

function InstagramEditor({
  value,
  onChange,
  disabled,
}: {
  value: InstagramMetadata;
  onChange: (m: InstagramMetadata) => void;
  disabled: boolean;
}) {
  const set = (patch: Partial<InstagramMetadata>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.formGrid}>
      <label className={styles.field}>
        Caption (max 2200)
        <textarea value={value.caption} disabled={disabled} onChange={(e) => set({ caption: e.target.value })} />
      </label>
      <label className={styles.field}>
        Hashtags (comma separated, max 30)
        <input
          value={value.hashtags.join(", ")}
          disabled={disabled}
          onChange={(e) => set({ hashtags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })}
        />
      </label>
      <label className={styles.field}>
        Cover frame offset (ms, optional)
        <input
          type="number"
          min={0}
          value={value.thumbOffsetMs ?? ""}
          disabled={disabled}
          onChange={(e) => set({ thumbOffsetMs: e.target.value === "" ? null : Number(e.target.value) })}
        />
      </label>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={value.shareToFeed} disabled={disabled} onChange={(e) => set({ shareToFeed: e.target.checked })} />
          Also share to feed
        </label>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={value.paidPromotion} disabled={disabled} onChange={(e) => set({ paidPromotion: e.target.checked })} />
          Paid promotion (declared in the caption)
        </label>
      </div>
      <p className={styles.hint}>
        Publishing requires an Instagram Business or Creator account connected through the
        official Meta flow. Personal accounts cannot publish via the API.
      </p>
    </div>
  );
}

function TiktokEditor({
  value,
  onChange,
  privacyOptions,
  creatorInfoAvailable,
  disabled,
}: {
  value: TiktokMetadata;
  onChange: (m: TiktokMetadata) => void;
  privacyOptions: string[];
  /** True only when a stored creator-info snapshot actually
   *  supplied the options; otherwise the SELF_ONLY entry below is
   *  a local fallback, NOT something TikTok reported. */
  creatorInfoAvailable: boolean;
  disabled: boolean;
}) {
  const set = (patch: Partial<TiktokMetadata>) => onChange({ ...value, ...patch });
  const options = privacyOptions.length ? privacyOptions : ["SELF_ONLY"];
  return (
    <div className={styles.formGrid}>
      <label className={styles.field}>
        Caption (max 2200)
        <textarea value={value.caption} disabled={disabled} onChange={(e) => set({ caption: e.target.value })} />
      </label>
      <label className={styles.field}>
        {creatorInfoAvailable
          ? "Privacy (options come from TikTok creator info)"
          : "Privacy (creator info unavailable — most restrictive option only)"}
        <select value={value.privacyLevel} disabled={disabled} onChange={(e) => set({ privacyLevel: e.target.value })}>
          <option value="">Select…</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        Cover timestamp (ms, optional)
        <input
          type="number"
          min={0}
          value={value.videoCoverTimestampMs ?? ""}
          disabled={disabled}
          onChange={(e) => set({ videoCoverTimestampMs: e.target.value === "" ? null : Number(e.target.value) })}
        />
      </label>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={value.disableComment} disabled={disabled} onChange={(e) => set({ disableComment: e.target.checked })} />
          Disable comments
        </label>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={value.disableDuet} disabled={disabled} onChange={(e) => set({ disableDuet: e.target.checked })} />
          Disable duet
        </label>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={value.disableStitch} disabled={disabled} onChange={(e) => set({ disableStitch: e.target.checked })} />
          Disable stitch
        </label>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={value.brandedContent} disabled={disabled} onChange={(e) => set({ brandedContent: e.target.checked })} />
          Branded content (promoting a brand/product)
        </label>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={value.brandOrganic} disabled={disabled} onChange={(e) => set({ brandOrganic: e.target.checked })} />
          Promoting my own brand/business
        </label>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={value.containsSyntheticMedia} disabled={disabled} onChange={(e) => set({ containsSyntheticMedia: e.target.checked })} />
          AI-generated content (labelled per TikTok policy)
        </label>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={value.creatorConsent} disabled={disabled} onChange={(e) => set({ creatorConsent: e.target.checked })} />
          I agree to TikTok's Music Usage Confirmation and confirm this content complies with
          TikTok's policies (required before posting)
        </label>
      </div>
      <p className={styles.hint}>
        Until TikTok completes its audit of an app, its API only allows private (SELF_ONLY)
        posts. CLIPFORGE surfaces that restriction from creator info — it is never bypassed.
        CLIPFORGE never adds a watermark to uploads.
      </p>
    </div>
  );
}

// ===========================================================================
// Job editor — metadata, validation, approval, scheduling, attempts
// ===========================================================================

function ValidationList({ validation }: { validation: ValidationResult }) {
  return (
    <ul className={styles.checkList}>
      {validation.checks.map((c) => (
        <li key={c.id} className={c.ok ? styles.checkOk : c.severity === "warning" ? styles.checkWarn : styles.checkBad}>
          <strong>{c.ok ? "Pass" : c.severity === "warning" ? "Warning" : "Blocked"} — {c.label}:</strong>{" "}
          {c.detail}
        </li>
      ))}
    </ul>
  );
}

function JobEditor({ jobId, onClose, onChanged }: { jobId: string; onClose: () => void; onChanged: () => void }) {
  const [job, setJob] = useState<PublishJob | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [caps, setCaps] = useState<Record<string, unknown> | null>(null);
  const [metadata, setMetadata] = useState<PlatformMetadata | null>(null);
  const [dirty, setDirty] = useState(false);
  const [rights, setRights] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<PublishAttempt[] | null>(null);
  const [attemptsError, setAttemptsError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<{ status: string; views: number | null; likes: number | null; comments: number | null; shares: number | null; note?: string } | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [scheduleLocal, setScheduleLocal] = useState("");
  const [scheduleTz, setScheduleTz] = useState(BROWSER_TZ);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const jobRef = useRef<PublishJob | null>(null);
  jobRef.current = job;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const load = useCallback(async () => {
    try {
      const [j, p] = await Promise.all([publishingApi.job(jobId), publishingApi.preview(jobId)]);
      setJob(j.job);
      setValidation(j.validation);
      setCaps(p.capabilities);
      setMetadata((prev) => (dirtyRef.current ? prev : j.job.metadata));
      if (j.job.status === "PUBLISHED") {
        const m = await publishingApi.metrics(jobId).catch((err: unknown) => {
          setMetricsError(errText(err));
          return null;
        });
        if (m) {
          setMetrics({
            status: m.metricsStatus,
            views: m.metrics?.views ?? null,
            likes: m.metrics?.likes ?? null,
            comments: m.metrics?.comments ?? null,
            shares: m.metrics?.shares ?? null,
            note: m.note,
          });
        }
      }
    } catch (err) {
      setError(errText(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  useEffect(() => {
    setDirty(false);
    setMetadata(null);
    setAttempts(null);
    setAttemptsError(null);
    setMetrics(null);
    setMetricsError(null);
    setRights(false);
    void load();
  }, [load]);

  // Poll while the platform is working — the status shown is always
  // the platform's own answer, refreshed by the server worker.
  useEffect(() => {
    if (!job || !ACTIVE_STATUSES.has(job.status)) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [job, load]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  if (!job || !metadata) {
    return (
      <div className={styles.card}>
        <p className={styles.muted}>Loading post…</p>
        {error && (
          <>
            <p className={styles.errorBanner}>{error}</p>
            <div className={styles.buttonRow}>
              <button className={styles.secondaryButton} onClick={() => void load()}>
                Retry
              </button>
              <button className={styles.smallButton} onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  const editable = EDITABLE_STATUSES.has(job.status);
  const categories = (caps?.categories as { id: string; title: string }[] | undefined) ?? [];
  const privacyOptions = (caps?.privacyLevelOptions as string[] | undefined) ?? [];

  return (
    <div className={styles.card}>
      <div className={styles.jobRowHead}>
        <span className={styles.platformBadge}>{PLATFORM_LABEL[job.platform]}</span>
        <span className={styles.jobTitle}>{jobTitle(job)}</span>
        <StatusPill status={job.status} />
        {job.schedulingLabel && <span className={styles.statusPill}>{job.schedulingLabel}</span>}
        <span style={{ flex: 1 }} />
        <button className={styles.smallButton} onClick={onClose}>
          Close
        </button>
      </div>

      {error && <p className={styles.errorBanner}>{error}</p>}
      {job.error && (
        <p className={styles.errorBanner}>
          {job.error}
          {job.errorClass === "user_intervention" && " Fix the post (edit the metadata) before retrying."}
          {job.ambiguous && " The outcome is uncertain — CLIPFORGE checks the platform status before any retry so the post is never duplicated."}
        </p>
      )}

      {job.export && (
        <>
          <video
            className={styles.previewVideo}
            controls
            preload="metadata"
            src={exportDownloadUrl(job.export.downloadPath)}
          />
          <dl className={styles.kvList}>
            <dt>Export</dt>
            <dd>
              {job.export.filename} · {job.export.format.toUpperCase()} ·{" "}
              {job.export.width && job.export.height ? `${job.export.width}×${job.export.height}` : "audio"} ·{" "}
              {fmtDuration(job.export.duration)} · {fmtBytes(job.export.fileSize)}
            </dd>
            <dt>Account</dt>
            <dd>
              {job.accountDisplayName ?? job.accountUsername ?? job.accountId} ({PLATFORM_LABEL[job.platform]})
            </dd>
            {job.schedule && (
              <>
                <dt>Scheduled for</dt>
                <dd>
                  {fmtDateTime(job.schedule.scheduledForUtc, job.schedule.timezone)} ({job.schedule.timezone}) —{" "}
                  {job.schedulingLabel ?? ""}
                </dd>
              </>
            )}
            {job.publishedUrl && (
              <>
                <dt>Platform post</dt>
                <dd>
                  <a href={job.publishedUrl} target="_blank" rel="noreferrer">
                    {job.publishedUrl}
                  </a>
                </dd>
              </>
            )}
            {job.platformPostId && (
              <>
                <dt>Platform post ID</dt>
                <dd>{job.platformPostId}</dd>
              </>
            )}
          </dl>
        </>
      )}

      <h3>Post details</h3>
      {!editable && (
        <p className={styles.hint}>
          This post can no longer be edited in status {job.status} — the details below are
          read-only.
        </p>
      )}
      {job.platform === "youtube" && (
        <YoutubeEditor value={metadata as YoutubeMetadata} categories={categories} disabled={!editable} onChange={(m) => { setMetadata(m); setDirty(true); }} />
      )}
      {job.platform === "instagram" && (
        <InstagramEditor value={metadata as InstagramMetadata} disabled={!editable} onChange={(m) => { setMetadata(m); setDirty(true); }} />
      )}
      {job.platform === "tiktok" && (
        <TiktokEditor
          value={metadata as TiktokMetadata}
          privacyOptions={privacyOptions}
          creatorInfoAvailable={caps != null && Array.isArray(caps.privacyLevelOptions)}
          disabled={!editable}
          onChange={(m) => { setMetadata(m); setDirty(true); }}
        />
      )}
      {editable && (
        <div className={styles.buttonRow}>
          <button
            className={styles.secondaryButton}
            disabled={!dirty || busy !== null}
            onClick={() => void run("save", async () => { await publishingApi.updateMetadata(job.id, metadata); setDirty(false); })}
          >
            Save changes
          </button>
          <span className={styles.hint}>Saving resets any earlier validation/approval — the post is re-checked before it can go out.</span>
        </div>
      )}

      {job.platform === "youtube" && editable && (
        <div className={styles.buttonRow}>
          <label className={styles.field} style={{ flexDirection: "row", alignItems: "center", gap: "var(--space-2)" }}>
            Custom thumbnail (PNG/JPEG, max 2 MB)
            <input
              type="file"
              accept="image/png,image/jpeg"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void run("thumb", () => publishingApi.uploadThumbnail(job.id, f));
              }}
            />
          </label>
          {job.hasCustomThumbnail && (
            <>
              <span className={styles.hint}>Attached — it is uploaded to YouTube right after the video.</span>
              <button className={styles.smallButton} disabled={busy !== null} onClick={() => void run("thumb-rm", () => publishingApi.removeThumbnail(job.id))}>
                Remove
              </button>
            </>
          )}
        </div>
      )}

      <h3>Validation</h3>
      {validation ? (
        <ValidationList validation={validation} />
      ) : (
        <p className={styles.muted}>Not validated yet. Validation re-checks the live platform limits (including TikTok creator info) before anything is submitted.</p>
      )}
      {editable && (
        <div className={styles.buttonRow}>
          <button className={styles.secondaryButton} disabled={busy !== null || dirty} onClick={() => void run("validate", () => publishingApi.validate(job.id))}>
            Run validation
          </button>
          {dirty && <span className={styles.hint}>Save your changes first.</span>}
        </div>
      )}

      {(job.status === "AWAITING_APPROVAL" || job.status === "SCHEDULED") && (
        <>
          <h3>Approve &amp; publish</h3>
          {job.status === "AWAITING_APPROVAL" ? (
            <label className={styles.checkRow}>
              <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} />
              I confirm I own this media or am authorised to distribute it, and that it complies
              with the platform's policies. I understand this publishes to my real{" "}
              {PLATFORM_LABEL[job.platform]} account and nothing is sent before I approve.
            </label>
          ) : (
            <p className={styles.hint}>
              Rights &amp; policy confirmation was given when this post was approved — it cannot
              be changed here. Use Move schedule or Cancel schedule below to change the plan.
            </p>
          )}
          <div className={styles.formGrid}>
            <label className={styles.field}>
              Schedule for (local time, optional)
              <input type="datetime-local" value={scheduleLocal} onChange={(e) => setScheduleLocal(e.target.value)} />
            </label>
            <label className={styles.field}>
              Timezone
              <select value={scheduleTz} onChange={(e) => setScheduleTz(e.target.value)}>
                {tzOptions(scheduleTz).map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className={styles.hint}>
            {job.platform === "youtube"
              ? "YouTube posts set to Private are scheduled natively on YouTube (publishAt). Anything else is scheduled in CLIPFORGE and submitted at the chosen time — the label on the post always says which."
              : `${PLATFORM_LABEL[job.platform]} has no native scheduling here — CLIPFORGE holds the post and submits it at the chosen time, even with this page closed.`}
          </p>
          <div className={styles.buttonRow}>
            {job.status === "AWAITING_APPROVAL" && (
              <>
                <button className={styles.primaryButton} disabled={busy !== null || !rights} onClick={() => void run("approve", () => publishingApi.approve(job.id, rights))}>
                  Approve post
                </button>
                <span className={styles.hint}>
                  Approving does not apply the time above — after approving, use Schedule below
                  to set it.
                </span>
              </>
            )}
            {job.status === "SCHEDULED" && <span className={styles.hint}>Approved — the schedule below is active.</span>}
          </div>
        </>
      )}

      {job.approvedAt && job.status !== "PUBLISHED" && job.status !== "CANCELLED" && (
        <div className={styles.buttonRow}>
          {job.status === "AWAITING_APPROVAL" && (
            <>
              <button className={styles.primaryButton} disabled={busy !== null} onClick={() => void run("submit", () => publishingApi.submit(job.id))}>
                Publish now
              </button>
              <button
                className={styles.secondaryButton}
                disabled={busy !== null || !scheduleLocal}
                onClick={() => void run("schedule", () => publishingApi.schedule(job.id, { scheduledForLocal: scheduleLocal, timezone: scheduleTz }))}
              >
                Schedule
              </button>
            </>
          )}
          {job.status === "SCHEDULED" && job.schedule && (
            <>
              <button
                className={styles.secondaryButton}
                disabled={busy !== null || !scheduleLocal}
                onClick={() => void run("move", () => publishingApi.moveSchedule(job.schedule!.id, { scheduledForLocal: scheduleLocal, timezone: scheduleTz }))}
              >
                Move schedule
              </button>
              <button className={styles.secondaryButton} disabled={busy !== null} onClick={() => void run("unschedule", () => publishingApi.cancelSchedule(job.id))}>
                Cancel schedule
              </button>
            </>
          )}
          {(job.status === "FAILED" || job.status === "AUTH_REQUIRED") && job.errorClass !== "user_intervention" && (
            <button
              className={styles.primaryButton}
              disabled={busy !== null}
              onClick={() => {
                if (job.ambiguous && !window.confirm("The platform may already have this post. CLIPFORGE will check the platform status first and only re-send if nothing is found. Continue?")) return;
                void run("retry", () => publishingApi.retry(job.id, job.ambiguous));
              }}
            >
              Retry
            </button>
          )}
          {(job.status === "SUBMITTED" || job.status === "PLATFORM_PROCESSING" || job.ambiguous) && (
            <button className={styles.secondaryButton} disabled={busy !== null} onClick={() => void run("status", () => publishingApi.statusCheck(job.id))}>
              Check platform status
            </button>
          )}
          <button className={styles.smallButtonDanger} disabled={busy !== null} onClick={() => void run("cancel", () => publishingApi.cancel(job.id))}>
            Cancel post
          </button>
        </div>
      )}

      {job.status === "PUBLISHED" && metrics && (
        <>
          <h3>Performance</h3>
          {metrics.status === "unavailable" ? (
            <p className={styles.muted}>
              Metrics are unavailable for this platform right now{metrics.note ? ` — ${metrics.note}` : ""}. Unavailable is
              shown as-is; it is never reported as zero.
            </p>
          ) : (
            <dl className={styles.kvList}>
              <dt>Views</dt>
              <dd>{metrics.views ?? "unavailable"}</dd>
              <dt>Likes</dt>
              <dd>{metrics.likes ?? "unavailable"}</dd>
              <dt>Comments</dt>
              <dd>{metrics.comments ?? "unavailable"}</dd>
              <dt>Shares</dt>
              <dd>{metrics.shares ?? "unavailable"}</dd>
            </dl>
          )}
          <div className={styles.buttonRow}>
            <button className={styles.smallButton} disabled={busy !== null} onClick={() => void run("metrics", () => publishingApi.syncMetrics(job.id))}>
              Sync metrics now
            </button>
          </div>
        </>
      )}

      {job.status === "PUBLISHED" && !metrics && metricsError && (
        <>
          <h3>Performance</h3>
          <p className={styles.errorBanner}>Performance metrics could not be loaded — {metricsError}</p>
        </>
      )}

      <details
        onToggle={(e) => {
          if ((e.target as HTMLDetailsElement).open && !attempts) {
            void publishingApi
              .attempts(job.id)
              .then((r) => setAttempts(r.attempts))
              .catch((err: unknown) => {
                setAttempts([]);
                setAttemptsError(errText(err));
              });
          }
        }}
      >
        <summary>Attempt history</summary>
        {attemptsError ? (
          <p className={styles.errorBanner}>Attempt history could not be loaded — {attemptsError}</p>
        ) : attempts === null ? (
          <p className={styles.muted}>Loading…</p>
        ) : attempts.length === 0 ? (
          <p className={styles.muted}>No submission attempts yet.</p>
        ) : (
          <div className={styles.attemptList}>
            {attempts.map((a) => (
              <div key={a.id}>
                #{a.attemptNo} <code>{a.kind}</code> — {a.status}
                {a.providerRequestId ? <> · provider ref <code>{a.providerRequestId}</code></> : null} · {fmtDateTime(a.createdAt)}
                {a.error ? <> · {a.error}</> : null}
              </div>
            ))}
          </div>
        )}
      </details>

      {(job.status === "DRAFT" || job.status === "CANCELLED" || job.status === "FAILED") && (
        <div className={styles.buttonRow}>
          {confirmingDelete ? (
            <>
              <span className={styles.hint}>Delete this draft permanently?</span>
              <button
                className={styles.smallButtonDanger}
                disabled={busy !== null}
                onClick={() => void run("delete", async () => { await publishingApi.deleteJob(job.id); onClose(); })}
              >
                Confirm delete
              </button>
              <button className={styles.smallButton} onClick={() => setConfirmingDelete(false)}>
                Keep
              </button>
            </>
          ) : (
            <button className={styles.smallButtonDanger} onClick={() => setConfirmingDelete(true)}>
              Delete draft
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Publish Content — pick an export + accounts, create drafts
// ===========================================================================

interface ReuseSeed {
  accountId: string;
  exportOutputId: string;
  metadata: PlatformMetadata;
}

function PublishTab({
  onOpenJob,
  reuse,
  onReuseConsumed,
}: {
  onOpenJob: (jobId: string) => void;
  reuse: ReuseSeed | null;
  onReuseConsumed: () => void;
}) {
  const [exportsList, setExportsList] = useState<ExportHistoryEntry[]>([]);
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [selectedExport, setSelectedExport] = useState<string>("");
  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set());
  const [created, setCreated] = useState<PublishJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idemKeys = useRef(new Map<string, string>());

  useEffect(() => {
    void (async () => {
      try {
        const [h, a] = await Promise.all([exportsApi.history(), publishingApi.accounts()]);
        setExportsList(h.outputs.filter((o) => o.status === "COMPLETED" && o.width !== null));
        setAccounts(a.accounts);
      } catch (err) {
        setError(errText(err));
      }
    })();
  }, []);

  useEffect(() => {
    if (!reuse) return;
    setSelectedExport(reuse.exportOutputId);
    setSelectedAccounts(new Set([reuse.accountId]));
  }, [reuse]);

  const toggleAccount = (id: string) => {
    setSelectedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const createDrafts = async () => {
    const exp = exportsList.find((o) => o.id === selectedExport);
    if (!exp) return;
    setBusy(true);
    setError(null);
    const jobs: PublishJob[] = [];
    const failures: string[] = [];
    try {
      for (const accountId of selectedAccounts) {
        const account = accounts.find((a) => a.id === accountId);
        if (!account) continue;
        let metadata: PlatformMetadata;
        if (reuse && reuse.accountId === accountId) {
          metadata = reuse.metadata;
        } else {
          metadata = defaultMetadataFor(account.platform);
          const base = exp.filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
          if (account.platform === "youtube") (metadata as YoutubeMetadata).title = base.slice(0, 100);
          else (metadata as InstagramMetadata | TiktokMetadata).caption = base;
        }
        const key = idemKeys.current.get(`${exp.id}:${accountId}`) ?? `pub-${exp.id}-${accountId}-${Date.now()}`;
        idemKeys.current.set(`${exp.id}:${accountId}`, key);
        try {
          const res = await publishingApi.createJob(
            { exportOutputId: exp.id, accountId, metadata },
            key,
          );
          jobs.push(res.job);
          // Surface each draft the moment it exists, so a later
          // account's failure can never hide an already-created one.
          setCreated((prev) => [res.job, ...prev]);
        } catch (err) {
          failures.push(
            `${account.displayName ?? account.username ?? PLATFORM_LABEL[account.platform]}: ${errText(err)}`,
          );
        }
      }
      if (jobs.length > 0 && reuse) onReuseConsumed();
      if (failures.length > 0) {
        setError(
          `Draft creation finished with problems — ${jobs.length} created, ${failures.length} failed. ${failures.join(" · ")}`,
        );
      } else if (jobs.length === 1) {
        onOpenJob(jobs[0].id);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      {error && <p className={styles.errorBanner}>{error}</p>}
      {reuse && (
        <p className={styles.noticeBanner}>
          Reusing the metadata from a previous post — it is pre-selected below. Review it in the
          editor before approving; nothing is copied to the platform until you approve.
        </p>
      )}
      <div className={styles.card}>
        <h2>1 · Choose a finished export</h2>
        <p className={styles.muted}>
          Only completed video exports can be published. CLIPFORGE uploads the file
          exactly as rendered — no watermark is ever added.
        </p>
        {exportsList.length === 0 ? (
          <p className={styles.muted}>
            No completed video exports yet. Render one in the Export Studio first.{" "}
            <button className={styles.smallButton} onClick={() => navigateTo("exports")}>
              Open Export Studio
            </button>
          </p>
        ) : (
          <div className={styles.jobList}>
            {exportsList.map((o) => (
              <label key={o.id} className={styles.jobRow} style={{ cursor: "pointer" }}>
                <span className={styles.jobRowHead}>
                  <input
                    type="radio"
                    name="pub-export"
                    checked={selectedExport === o.id}
                    onChange={() => setSelectedExport(o.id)}
                  />
                  <span className={styles.jobTitle}>{o.filename}</span>
                  <span className={styles.hint}>
                    {o.format.toUpperCase()} · {o.width}×{o.height} · {fmtDuration(o.duration)} · {fmtBytes(o.fileSize)}
                    {o.projectName ? ` · ${o.projectName}` : ""}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className={styles.card}>
        <h2>2 · Choose accounts</h2>
        {accounts.length === 0 ? (
          <p className={styles.muted}>No accounts are connected yet — connect one in the Connected Accounts tab.</p>
        ) : (
          <div className={styles.jobList}>
            {accounts.map((a) => {
              // Instagram PERSONAL accounts can never publish via the
              // API (server validation is the backstop) — surface that
              // here instead of letting the draft fail later.
              const igPersonal =
                a.platform === "instagram" && (a.accountType ?? "").toUpperCase() === "PERSONAL";
              const selectable = a.status === "CONNECTED" && !igPersonal;
              return (
                <label key={a.id} className={styles.jobRow} style={{ cursor: selectable ? "pointer" : "default" }}>
                  <span className={styles.jobRowHead}>
                    <input
                      type="checkbox"
                      disabled={!selectable}
                      checked={selectedAccounts.has(a.id)}
                      onChange={() => toggleAccount(a.id)}
                    />
                    <span className={styles.platformBadge}>{PLATFORM_LABEL[a.platform]}</span>
                    <span className={styles.jobTitle}>{a.displayName ?? a.username ?? a.platformAccountId}</span>
                    {a.accountType && <span className={styles.hint}>{a.accountType}</span>}
                    <StatusPill status={a.status} />
                  </span>
                  {igPersonal && (
                    <span className={styles.hint} style={{ color: "var(--error)" }}>
                      Not publishable — Instagram only allows Business or Creator accounts to
                      publish via the API. Switch this account's type in Instagram settings, then
                      reconnect it.
                    </span>
                  )}
                  {!igPersonal && a.status !== "CONNECTED" && (
                    <span className={styles.hint} style={{ color: "var(--error)" }}>
                      Not publishable in status {a.status} — reconnect this account in the
                      Connected Accounts tab before publishing.
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}
        <div className={styles.buttonRow}>
          <button
            className={styles.primaryButton}
            disabled={busy || !selectedExport || selectedAccounts.size === 0}
            onClick={() => void createDrafts()}
          >
            {busy ? "Creating…" : `Create ${selectedAccounts.size || ""} draft${selectedAccounts.size === 1 ? "" : "s"}`}
          </button>
          <span className={styles.hint}>A separate draft is created per platform — each with its own metadata, validation and approval.</span>
        </div>
      </div>

      {created.length > 0 && (
        <div className={styles.card}>
          <h2>Drafts created</h2>
          <div className={styles.jobList}>
            {created.map((j) => (
              <div key={j.id} className={styles.jobRow}>
                <span className={styles.jobRowHead}>
                  <span className={styles.platformBadge}>{PLATFORM_LABEL[j.platform]}</span>
                  <span className={styles.jobTitle}>{jobTitle(j)}</span>
                  <StatusPill status={j.status} />
                  <span style={{ flex: 1 }} />
                  <button className={styles.smallButton} onClick={() => onOpenJob(j.id)}>
                    Edit &amp; approve
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Queue / History rows
// ===========================================================================

function JobRow({
  job,
  onOpen,
  onChanged,
  showReuse,
  onReuse,
}: {
  job: PublishJob;
  onOpen: (jobId: string) => void;
  onChanged: () => void;
  showReuse?: boolean;
  onReuse?: (job: PublishJob) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptsOpen, setAttemptsOpen] = useState(false);
  const [attempts, setAttempts] = useState<PublishAttempt[] | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const canCancel = ["DRAFT", "AWAITING_APPROVAL", "SCHEDULED", "QUEUED", "FAILED", "AUTH_REQUIRED"].includes(job.status);
  const canRetry =
    (job.status === "FAILED" || job.status === "AUTH_REQUIRED") && job.errorClass !== "user_intervention";

  return (
    <div className={styles.jobRow}>
      <span className={styles.jobRowHead}>
        {job.export && (
          <video className={styles.thumbVideo} muted preload="metadata" src={exportDownloadUrl(job.export.downloadPath)} />
        )}
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span className={styles.jobTitle}>{jobTitle(job)}</span>
          <span className={styles.hint}>
            {PLATFORM_LABEL[job.platform]} · {job.accountUsername ? `@${job.accountUsername.replace(/^@/, "")}` : job.accountId} ·{" "}
            created {fmtDateTime(job.createdAt)}
            {job.schedule ? ` · scheduled ${fmtDateTime(job.schedule.scheduledForUtc, job.schedule.timezone)} (${job.schedule.timezone})` : ""}
            {job.publishedAt ? ` · published ${fmtDateTime(job.publishedAt)}` : ""}
            {job.retryCount > 0 ? ` · retries ${job.retryCount}` : ""}
          </span>
          {job.schedulingLabel && <span className={styles.hint}>{job.schedulingLabel}</span>}
          {job.error && <span style={{ color: "var(--error)", fontSize: 13 }}>{job.error}</span>}
          {error && <span style={{ color: "var(--error)", fontSize: 13 }}>{error}</span>}
        </span>
        <span style={{ flex: 1 }} />
        <StatusPill status={job.status} />
      </span>
      <span className={styles.buttonRow}>
        <button className={styles.smallButton} disabled={busy} onClick={() => onOpen(job.id)}>
          Open
        </button>
        {job.status === "AWAITING_APPROVAL" && (
          <button className={styles.smallButton} disabled={busy} onClick={() => void act(() => publishingApi.submit(job.id))}>
            Publish now
          </button>
        )}
        {(job.status === "SUBMITTED" || job.status === "PLATFORM_PROCESSING") && (
          <button className={styles.smallButton} disabled={busy} onClick={() => void act(() => publishingApi.statusCheck(job.id))}>
            Check status
          </button>
        )}
        {canRetry && (
          <button
            className={styles.smallButton}
            disabled={busy}
            onClick={() => {
              if (job.ambiguous && !window.confirm("The platform may already have this post. CLIPFORGE will check the platform status first and only re-send if nothing is found. Continue?")) return;
              void act(() => publishingApi.retry(job.id, job.ambiguous));
            }}
          >
            Retry
          </button>
        )}
        {job.status === "FAILED" && job.errorClass === "user_intervention" && (
          <span className={styles.hint}>Fix required — open the post and correct it; retry unlocks after an edit.</span>
        )}
        {canCancel && (
          <button className={styles.smallButton} disabled={busy} onClick={() => void act(() => publishingApi.cancel(job.id))}>
            Cancel
          </button>
        )}
        <button
          className={styles.smallButton}
          onClick={() => {
            setAttemptsOpen((v) => !v);
            if (!attempts)
              void publishingApi
                .attempts(job.id)
                .then((r) => setAttempts(r.attempts))
                .catch((err: unknown) => {
                  setAttempts([]);
                  setError(`Attempt history could not be loaded — ${errText(err)}`);
                });
          }}
        >
          Attempts
        </button>
        {job.export && (
          <button className={styles.smallButton} onClick={() => navigateTo("exports")}>
            Open export
          </button>
        )}
        {job.publishedUrl && (
          <a className={styles.smallButton} href={job.publishedUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            Open platform post
          </a>
        )}
        {showReuse && onReuse && (
          <button className={styles.smallButton} disabled={busy} onClick={() => onReuse(job)}>
            Reuse metadata
          </button>
        )}
      </span>
      {attemptsOpen && (
        <div className={styles.attemptList}>
          {attempts === null ? (
            "Loading…"
          ) : attempts.length === 0 ? (
            "No attempts recorded."
          ) : (
            attempts.map((a) => (
              <div key={a.id}>
                #{a.attemptNo} <code>{a.kind}</code> — {a.status}
                {a.providerRequestId ? <> · <code>{a.providerRequestId}</code></> : null} · {fmtDateTime(a.createdAt)}
                {a.error ? <> · {a.error}</> : null}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const QUEUE_FILTERS: { id: string; label: string }[] = [
  { id: "", label: "All" },
  { id: "DRAFT", label: "Drafts" },
  { id: "AWAITING_APPROVAL", label: "Awaiting approval" },
  { id: "SCHEDULED", label: "Scheduled" },
  { id: "QUEUED,UPLOADING,SUBMITTED,PLATFORM_PROCESSING", label: "In progress" },
  { id: "PUBLISHED", label: "Published" },
  { id: "FAILED", label: "Failed" },
  { id: "AUTH_REQUIRED", label: "Auth required" },
  { id: "CANCELLED", label: "Cancelled" },
];

function QueueTab({ onOpen, refreshKey }: { onOpen: (jobId: string) => void; refreshKey: number }) {
  const [jobs, setJobs] = useState<PublishJob[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [statusFilter, setStatusFilter] = useState("");
  const [platformFilter, setPlatformFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);

  const load = useCallback(async () => {
    try {
      const first = statusFilter.split(",")[0];
      const res = await publishingApi.queue({
        status: statusFilter.includes(",") ? undefined : first || undefined,
        platform: platformFilter || undefined,
      });
      let list = res.jobs;
      if (statusFilter.includes(",")) {
        const wanted = new Set(statusFilter.split(","));
        list = list.filter((j) => wanted.has(j.status));
      }
      setJobs(list);
      setCounts(res.counts);
    } catch (err) {
      setError(errText(err));
    }
  }, [statusFilter, platformFilter]);

  useEffect(() => {
    void load();
  }, [load, refreshKey, localRefresh]);

  useEffect(() => {
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      {error && <p className={styles.errorBanner}>{error}</p>}
      <div className={styles.filterRow}>
        {QUEUE_FILTERS.map((f) => (
          <button
            key={f.id || "all"}
            className={statusFilter === f.id ? styles.chipActive : styles.chip}
            onClick={() => setStatusFilter(f.id)}
          >
            {f.label}
            {f.id && !f.id.includes(",") && counts[f.id] ? ` (${counts[f.id]})` : ""}
          </button>
        ))}
        <select
          value={platformFilter}
          onChange={(e) => setPlatformFilter(e.target.value)}
          style={{ background: "var(--surface-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", padding: "6px 10px" }}
        >
          <option value="">All platforms</option>
          <option value="youtube">YouTube</option>
          <option value="instagram">Instagram</option>
          <option value="tiktok">TikTok</option>
        </select>
      </div>
      {jobs.length === 0 ? (
        <div className={styles.card}>
          <p className={styles.muted}>No posts match. Drafts you create in Publish Content appear here and move through validation, approval, scheduling and publishing.</p>
        </div>
      ) : (
        <div className={styles.jobList}>
          {jobs.map((j) => (
            <JobRow key={j.id} job={j} onOpen={onOpen} onChanged={() => setLocalRefresh((n) => n + 1)} />
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryTab({ onOpen, onReuse }: { onOpen: (jobId: string) => void; onReuse: (job: PublishJob) => void }) {
  const [jobs, setJobs] = useState<PublishJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    void (async () => {
      try {
        const res = await publishingApi.history();
        setJobs(res.jobs);
      } catch (err) {
        setError(errText(err));
      }
    })();
  }, [refresh]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      {error && <p className={styles.errorBanner}>{error}</p>}
      <p className={styles.muted}>
        Finished posts only — published, failed and cancelled — including their full attempt
        history. Drafts, scheduled and in-flight posts live in the Queue. History is kept even
        after an account is disconnected. “Reuse metadata” starts a fresh draft with the same
        text — it never re-posts by itself.
      </p>
      {jobs.length === 0 ? (
        <div className={styles.card}>
          <p className={styles.muted}>No publishing history yet.</p>
        </div>
      ) : (
        <div className={styles.jobList}>
          {jobs.map((j) => (
            <JobRow key={j.id} job={j} onOpen={onOpen} onChanged={() => setRefresh((n) => n + 1)} showReuse onReuse={onReuse} />
          ))}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Calendar
// ===========================================================================

function CalendarTab({ onOpen }: { onOpen: (jobId: string) => void }) {
  const [view, setView] = useState<"month" | "week" | "day">("month");
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [tz, setTz] = useState(BROWSER_TZ);
  const [platform, setPlatform] = useState("");
  const [accountId, setAccountId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [a, p] = await Promise.all([publishingApi.accounts(), projectsApi.listProjects({ pageSize: 100 })]);
        setAccounts(a.accounts);
        setProjects(p.projects.map((x) => ({ id: x.id, name: x.name })));
      } catch {
        // Filters stay empty, but say so — an empty filter list must
        // not look like "no accounts/projects exist". The calendar
        // itself still loads.
        setError("Account and project filters could not be loaded — the calendar below still works, but its account/project filters are unavailable.");
      }
    })();
  }, []);

  const dayKey = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

  // -- Timezone-consistent grid --------------------------------------
  // Grid cells are DAY KEYS in the SELECTED timezone — the same keys
  // events are bucketed by (dayKey above). Stepping Date objects in
  // browser-local time instead would shift the whole grid by a day
  // whenever the selected timezone differs from the browser's, so all
  // cell math below is done on calendar components (y/m/d), never on
  // browser-local dates.
  const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const keyParts = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return { y, m, d };
  };
  const toKey = (y: number, m: number, d: number) =>
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  /** UTC instant of local midnight (00:00 in tz) on the given day key. */
  const dayStartUtc = (key: string): Date => {
    const { y, m, d } = keyParts(key);
    let guess = Date.UTC(y, m - 1, d, 0, 0, 0);
    for (let i = 0; i < 3; i += 1) {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).formatToParts(new Date(guess));
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
      const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
      const next = Date.UTC(y, m - 1, d, 0, 0, 0) - (wallAsUtc - guess);
      if (next === guess) break;
      guess = next;
    }
    return new Date(guess);
  };

  const grid = useMemo(() => {
    // The anchor is the calendar day the cursor falls on IN THE
    // SELECTED TIMEZONE (month view anchors on that month's 1st).
    const anchor = keyParts(dayKey(cursor.toISOString()));
    const start = view === "month" ? { ...anchor, d: 1 } : anchor;
    const startWeekday = new Date(Date.UTC(start.y, start.m - 1, start.d)).getUTCDay();
    const back = view === "day" ? 0 : startWeekday; // weeks start on Sunday
    const count = view === "month" ? 42 : view === "week" ? 7 : 1;
    const firstUtc = Date.UTC(start.y, start.m - 1, start.d - back);
    const days = [];
    for (let i = 0; i < count; i += 1) {
      const t = new Date(firstUtc + i * 86_400_000);
      const p = { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
      days.push({
        ...p,
        key: toKey(p.y, p.m, p.d),
        weekday: WEEKDAY_LABELS[t.getUTCDay()],
        inMonth: view !== "month" || p.m === anchor.m,
      });
    }
    return { days, anchor };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, view, tz]);

  const range = useMemo(() => {
    const last = grid.days[grid.days.length - 1];
    const after = new Date(Date.UTC(last.y, last.m - 1, last.d + 1));
    return {
      from: dayStartUtc(grid.days[0].key).toISOString(),
      to: dayStartUtc(toKey(after.getUTCFullYear(), after.getUTCMonth() + 1, after.getUTCDate())).toISOString(),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, tz]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await publishingApi.calendar({
          from: range.from,
          to: range.to,
          platform: platform || undefined,
          accountId: accountId || undefined,
          projectId: projectId || undefined,
        });
        setEvents(res.events);
      } catch (err) {
        setError(errText(err));
      }
    })();
  }, [range, platform, accountId, projectId]);

  const move = (delta: number) => {
    setCursor((c) => {
      const d = new Date(c);
      if (view === "month") d.setMonth(d.getMonth() + delta);
      else if (view === "week") d.setDate(d.getDate() + 7 * delta);
      else d.setDate(d.getDate() + delta);
      return d;
    });
  };

  const timeInTz = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      {error && <p className={styles.errorBanner}>{error}</p>}
      <div className={styles.filterRow}>
        <button className={styles.smallButton} onClick={() => move(-1)}>← Prev</button>
        <strong>
          {view === "month"
            ? new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
                new Date(Date.UTC(grid.anchor.y, grid.anchor.m - 1, 1)),
              )
            : fmtDateTime(cursor.toISOString(), tz)}
        </strong>
        <button className={styles.smallButton} onClick={() => move(1)}>Next →</button>
        {(["month", "week", "day"] as const).map((v) => (
          <button key={v} className={view === v ? styles.chipActive : styles.chip} onClick={() => setView(v)}>
            {v[0].toUpperCase() + v.slice(1)}
          </button>
        ))}
        <label className={styles.hint}>
          Timezone{" "}
          <select value={tz} onChange={(e) => setTz(e.target.value)}>
            {tzOptions(tz).map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
        </label>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="">All platforms</option>
          <option value="youtube">YouTube</option>
          <option value="instagram">Instagram</option>
          <option value="tiktok">TikTok</option>
        </select>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {PLATFORM_LABEL[a.platform]} · {a.username ?? a.displayName ?? a.platformAccountId}
            </option>
          ))}
        </select>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      <p className={styles.hint}>
        Times are stored in UTC and shown in {tz}. YouTube-native schedules are held by YouTube;
        CLIPFORGE schedules are submitted by the server at the due time — no browser needs to be
        open. Open a post to move or cancel its schedule.
      </p>
      {view === "month" || view === "week" ? (
        <div className={styles.calendarGrid} style={view === "week" ? { gridTemplateColumns: "repeat(7, 1fr)" } : undefined}>
          {grid.days.map((day) => {
            const dayEvents = events.filter((e) => dayKey(e.atUtc) === day.key);
            return (
              <div key={day.key} className={`${styles.calendarCell} ${day.inMonth ? "" : styles.calendarCellDim}`}>
                <span className={styles.calendarDayNum}>
                  {day.weekday} {day.d}
                </span>
                {dayEvents.map((e) => (
                  <button
                    key={e.id}
                    className={`${styles.calEvent} ${e.kind === "published" ? styles.calPublished : e.kind === "failed" ? styles.calFailed : ""}`}
                    style={
                      e.kind === "cancelled"
                        ? { opacity: 0.55, textDecoration: "line-through", borderStyle: "dashed" }
                        : undefined
                    }
                    onClick={() => onOpen(e.jobId)}
                    title={`${e.title} — ${fmtDateTime(e.atUtc, tz)}`}
                  >
                    {timeInTz(e.atUtc)} {PLATFORM_LABEL[e.platform]} · {e.title}
                    {e.kind === "cancelled" ? " · Cancelled" : ""}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <div className={styles.jobList}>
          {events.length === 0 ? (
            <p className={styles.muted}>Nothing on this day.</p>
          ) : (
            events
              .slice()
              .sort((a, b) => a.atUtc.localeCompare(b.atUtc))
              .map((e) => (
                <button key={e.id} className={styles.calEvent} onClick={() => onOpen(e.jobId)} style={{ fontSize: 13, padding: "8px 10px" }}>
                  {fmtDateTime(e.atUtc, tz)} · {PLATFORM_LABEL[e.platform]} · {e.title} · {e.status.replace(/_/g, " ")}
                </button>
              ))
          )}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Platform settings
// ===========================================================================

function SettingsTab() {
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof publishingApi.settings>> | null>(null);
  const [accounts, setAccounts] = useState<PlatformAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Editable publishing defaults (saved via PUT /publishing/settings).
  const [defTz, setDefTz] = useState(BROWSER_TZ);
  const [defYtPrivacy, setDefYtPrivacy] = useState<YoutubeMetadata["privacy"]>("private");
  const [defTtPrivacy, setDefTtPrivacy] = useState("SELF_ONLY");
  const [defIgShareToFeed, setDefIgShareToFeed] = useState(true);
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setSettings(await publishingApi.settings());
      } catch (err) {
        setError(errText(err));
      }
    })();
    void (async () => {
      try {
        const res = await publishingApi.accounts();
        setAccounts(res.accounts);
      } catch {
        setAccounts(null); // counts below say "unavailable" instead of guessing
      }
    })();
  }, []);

  // Seed the defaults form from the saved defaults once settings
  // arrive; until the server returns any, the form starts from the
  // browser timezone and the metadata defaults.
  useEffect(() => {
    if (!settings || defaultsLoaded) return;
    const d = settings.defaults;
    if (d?.timezone) setDefTz(d.timezone);
    if (d?.youtube?.privacy) setDefYtPrivacy(d.youtube.privacy);
    if (d?.tiktok?.privacyLevel) setDefTtPrivacy(d.tiktok.privacyLevel);
    if (typeof d?.instagram?.shareToFeed === "boolean") setDefIgShareToFeed(d.instagram.shareToFeed);
    setDefaultsLoaded(true);
  }, [settings, defaultsLoaded]);

  const saveDefaults = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveNotice(null);
    try {
      const updated = await publishingApi.updateSettings({
        defaults: {
          timezone: defTz,
          youtube: { privacy: defYtPrivacy },
          instagram: { shareToFeed: defIgShareToFeed },
          tiktok: { privacyLevel: defTtPrivacy },
        },
      });
      if (updated && Array.isArray(updated.providers)) setSettings(updated);
      else setSettings(await publishingApi.settings());
      setSaveNotice("Publishing defaults saved.");
    } catch (err) {
      setSaveError(errText(err));
    } finally {
      setSaving(false);
    }
  };

  if (error) return <p className={styles.errorBanner}>{error}</p>;
  if (!settings) return <p className={styles.muted}>Loading settings…</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      <div className={styles.card}>
        <h2>Publishing defaults</h2>
        <p className={styles.muted}>
          Starting values for new posts and schedules. They never bypass validation: per-post
          checks still enforce the live platform limits (for example, TikTok only accepts a
          privacy level its creator info currently offers) before anything is submitted.
        </p>
        {saveError && <p className={styles.errorBanner}>{saveError}</p>}
        {saveNotice && <p className={styles.noticeBanner}>{saveNotice}</p>}
        <div className={styles.formGrid}>
          <label className={styles.field}>
            Default timezone
            <select value={defTz} onChange={(e) => setDefTz(e.target.value)}>
              {tzOptions(defTz).map((z) => (
                <option key={z} value={z}>{z}</option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            YouTube default privacy
            <select value={defYtPrivacy} onChange={(e) => setDefYtPrivacy(e.target.value as YoutubeMetadata["privacy"])}>
              <option value="private">Private</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select>
          </label>
          <label className={styles.field}>
            TikTok default privacy level
            <select value={defTtPrivacy} onChange={(e) => setDefTtPrivacy(e.target.value)}>
              <option value="SELF_ONLY">SELF_ONLY (only me)</option>
              <option value="MUTUAL_FOLLOW_FRIENDS">MUTUAL_FOLLOW_FRIENDS (friends)</option>
              <option value="PUBLIC_TO_EVERYONE">PUBLIC_TO_EVERYONE</option>
            </select>
          </label>
          <label className={styles.checkRow}>
            <input type="checkbox" checked={defIgShareToFeed} onChange={(e) => setDefIgShareToFeed(e.target.checked)} />
            Instagram: also share Reels to feed by default
          </label>
        </div>
        <div className={styles.buttonRow}>
          <button className={styles.primaryButton} disabled={saving} onClick={() => void saveDefaults()}>
            {saving ? "Saving…" : "Save defaults"}
          </button>
        </div>
      </div>
      <div className={styles.card}>
        <h2>Provider configuration</h2>
        <p className={styles.muted}>
          Configuration comes from the server environment — variable NAMES are shown here, never
          values. Register each developer app, enable its official API product, and set the OAuth
          redirect URI to the server's callback for that platform:
        </p>
        <dl className={styles.kvList}>
          <dt>YouTube</dt>
          <dd>&lt;server&gt;/api/publishing/oauth/youtube/callback</dd>
          <dt>Instagram</dt>
          <dd>&lt;server&gt;/api/publishing/oauth/instagram/callback</dd>
          <dt>TikTok</dt>
          <dd>&lt;server&gt;/api/publishing/oauth/tiktok/callback</dd>
        </dl>
        <div className={styles.grid3}>
          {settings.providers.map((p) => {
            const connectedCount = accounts
              ? accounts.filter((a) => a.platform === p.platform && a.status === "CONNECTED").length
              : null;
            return (
            <div key={p.platform} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md)", padding: "var(--space-3)" }}>
              <span className={styles.platformBadge}>{PLATFORM_LABEL[p.platform]}</span>
              <p>
                <span className={styles.statusPill}>{p.configured ? "Configured" : "Not configured"}</span>
              </p>
              <p className={styles.hint}>
                {connectedCount === null
                  ? "Connected accounts: unavailable"
                  : `Connected accounts: ${connectedCount}`}
              </p>
              <p className={styles.hint}>Present: {p.present.join(", ") || "none"}</p>
              <p className={styles.hint}>Missing: {p.missing.join(", ") || "none"}</p>
            </div>
            );
          })}
        </div>
      </div>
      <div className={styles.card}>
        <h2>Token storage</h2>
        <dl className={styles.kvList}>
          <dt>Encryption</dt>
          <dd>
            AES-256-GCM, {settings.tokenEncryption.mode === "env" ? "key from TOKEN_ENCRYPTION_KEY" : "development key file on the server (set TOKEN_ENCRYPTION_KEY in production)"} —{" "}
            {settings.tokenEncryption.ready ? "ready" : "NOT ready"}
          </dd>
          <dt>Public app URL</dt>
          <dd>{settings.publicAppUrl}</dd>
          <dt>Database</dt>
          <dd>{settings.databaseNote}</dd>
        </dl>
        <p className={styles.muted}>
          Access and refresh tokens are encrypted at rest and never sent to the browser or written
          to logs. Publishing uses only official platform APIs — no scraping, no browser
          automation, no unofficial endpoints. A post is only ever reported published after the
          platform itself confirms it. Until a provider's credentials and platform review/audit
          are complete (YouTube API verification, Meta app review, TikTok audit — unaudited
          TikTok apps can post privately only), that platform stays unavailable here.
        </p>
      </div>
    </div>
  );
}

// ===========================================================================
// Publishing Center root
// ===========================================================================

export default function PublishingPage({ variant }: { variant?: "calendar" | "queue" }) {
  const [tab, setTab] = useState<Tab>(variant === "queue" ? "queue" : variant === "calendar" ? "calendar" : "accounts");
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [reuse, setReuse] = useState<ReuseSeed | null>(null);
  const [oauthNotice, setOauthNotice] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);

  useEffect(() => {
    const q = window.location.hash.split("?")[1];
    if (!q) return;
    const params = new URLSearchParams(q);
    const connected = params.get("pub_connected");
    const failed = params.get("pub_error");
    if (connected) {
      setOauthNotice(`${PLATFORM_LABEL[connected as Platform] ?? connected} account connected.`);
      setTab("accounts");
    }
    if (failed) setOauthError(failed);
  }, []);

  const openJob = useCallback((jobId: string) => {
    setEditingJobId(jobId);
    window.scrollTo({ top: 0 });
  }, []);

  const handleReuse = useCallback(
    (job: PublishJob) => {
      setReuse({ accountId: job.accountId, exportOutputId: job.exportOutputId, metadata: job.metadata });
      setTab("publish");
    },
    [],
  );

  const tabs: { id: Tab; label: string }[] = [
    { id: "accounts", label: "Connected Accounts" },
    { id: "publish", label: "Publish Content" },
    { id: "calendar", label: "Publishing Calendar" },
    { id: "queue", label: "Publishing Queue" },
    { id: "history", label: "History" },
    { id: "settings", label: "Platform Settings" },
  ];

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.tabs} role="tablist" aria-label="Publishing sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? styles.tabActive : styles.tab}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {oauthNotice && <p className={styles.noticeBanner}>{oauthNotice}</p>}
      {oauthError && <p className={styles.errorBanner}>Connection failed: {oauthError}</p>}

      {editingJobId && (
        <JobEditor
          jobId={editingJobId}
          onClose={() => setEditingJobId(null)}
          onChanged={() => setRefreshKey((n) => n + 1)}
        />
      )}

      {tab === "accounts" && <AccountsTab onChanged={() => setRefreshKey((n) => n + 1)} />}
      {tab === "publish" && (
        <PublishTab onOpenJob={openJob} reuse={reuse} onReuseConsumed={() => setReuse(null)} />
      )}
      {tab === "calendar" && <CalendarTab onOpen={openJob} />}
      {tab === "queue" && <QueueTab onOpen={openJob} refreshKey={refreshKey} />}
      {tab === "history" && <HistoryTab onOpen={openJob} onReuse={handleReuse} />}
      {tab === "settings" && <SettingsTab />}
    </div>
  );
}
