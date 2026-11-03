import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../features/auth/AuthContext";
import { accountApi, type AppNotification } from "../services/account";
import Button from "./Button";
import EmptyState from "./EmptyState";
import styles from "./NotificationPanel.module.css";

// Phase 12: the panel reads the real in-app notification centre.
// Notifications exist only because real events created them (job
// completions/failures, publishing outcomes, security events).
export default function NotificationPanel() {
  const { status } = useAuth();
  const signedIn = status === "authenticated";
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [failed, setFailed] = useState(false);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [markError, setMarkError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!signedIn) {
      setItems([]);
      return;
    }
    try {
      const r = await accountApi.listNotifications(20);
      setItems(r.notifications);
      setUnread(r.unreadCount);
      setFailed(false);
    } catch {
      setFailed(true);
      setItems([]);
    }
  }, [signedIn]);

  useEffect(() => {
    void load();
  }, [load]);

  const markAll = async () => {
    setMarkError(null);
    try {
      await accountApi.markAllNotificationsRead();
      await load();
    } catch {
      setMarkError("Notifications could not be marked read. They are still unread — please try again.");
    }
  };

  const markOne = async (notification: AppNotification) => {
    if (notification.readAt || markingId) return;
    setMarkingId(notification.id);
    setMarkError(null);
    try {
      await accountApi.markNotificationRead(notification.id);
      const readAt = new Date().toISOString();
      setItems((current) =>
        current?.map((item) => (item.id === notification.id ? { ...item, readAt } : item)) ?? current,
      );
      setUnread((current) => Math.max(0, current - 1));
    } catch {
      setMarkError("That notification could not be marked read. It is still unread — please try again.");
    } finally {
      setMarkingId(null);
    }
  };

  return (
    <div className={styles.panel}>
      <h3 className={styles.heading}>
        Notifications{unread > 0 ? ` (${unread} unread)` : ""}
      </h3>
      {markError ? (
        <p className={styles.heading} role="alert">{markError}</p>
      ) : null}
      {failed ? (
        <p className={styles.heading} role="alert">
          Could not load notifications — the server did not answer. Your notifications are kept
          server-side and will reappear when it responds.
        </p>
      ) : items === null ? (
        <p className={styles.heading}>Loading…</p>
      ) : items.length === 0 ? (
        <EmptyState
          title="No notifications yet"
          description={
            signedIn
              ? "Finished or failed jobs, publishing results and account security events will appear here. Nothing has happened yet."
              : "Sign in to see your notifications. Demo mode has no account, so there is nothing to notify about."
          }
        />
      ) : (
        <>
          {unread > 0 ? (
            <Button variant="ghost" onClick={() => void markAll()}>
              Mark all read
            </Button>
          ) : null}
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            {items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => void markOne(n)}
                  disabled={Boolean(n.readAt) || Boolean(markingId)}
                  aria-label={n.readAt ? `${n.title} (already read)` : `Mark “${n.title}” as read`}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: 0,
                    border: 0,
                    background: "transparent",
                    color: "inherit",
                    font: "inherit",
                    textAlign: "left",
                    cursor: n.readAt ? "default" : "pointer",
                  }}
                >
                  <strong>{n.title}</strong>
                  {n.readAt ? null : " · new"}
                  {n.body ? <span style={{ display: "block" }}>{n.body}</span> : null}
                  <span style={{ display: "block", opacity: 0.7, fontSize: 12 }}>
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                </button>
                {n.link ? <a href={n.link}>Open</a> : null}
              </li>
            ))}
          </ul>
          <a href="#/settings">Notification settings</a>
        </>
      )}
    </div>
  );
}
