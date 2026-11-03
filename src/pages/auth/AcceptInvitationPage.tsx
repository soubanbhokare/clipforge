import { useMemo, useState } from "react";
import { useAuth } from "../../features/auth/AuthContext";
import { navigateTo, parseHash } from "../../features/auth/routing";
import { accountApi, type Workspace } from "../../services/account";
import { AuthApiError } from "../../services/auth";
import { AuthLayout } from "./AuthLayout";
import styles from "./AuthPages.module.css";

/**
 * Accept Invitation — the landing point for workspace invitation
 * links (#/accept-invitation?token=…). The token arrives in the hash
 * query, exactly like the password-reset token; the server stores
 * only a hash of it. Accepting requires a real session (the invite
 * is bound to the invited email address), so a signed-out visitor is
 * asked to sign in or register first and then open this link again —
 * nothing is accepted silently or on someone else's behalf.
 */
export default function AcceptInvitationPage() {
  const token = useMemo(() => parseHash().params.get("token") ?? "", []);
  const { status, user, refresh } = useAuth();
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<Workspace | null>(null);

  const onAccept = async () => {
    setAccepting(true);
    setError(null);
    try {
      const result = await accountApi.acceptInvitation(token);
      // Membership changed server-side; re-mirror the session state
      // (active/default workspace may have moved) before reporting.
      await refresh();
      setJoined(result.workspace);
    } catch (err) {
      setError(
        err instanceof AuthApiError ? err.message : "Something went wrong. Please try again.",
      );
    } finally {
      setAccepting(false);
    }
  };

  return (
    <AuthLayout
      headline="Workspace invitation"
      description="You have been invited to join a CLIPFORGE workspace."
      footer={
        <>
          <a href="#/login">Back to Sign In</a>
        </>
      }
    >
      <div className={styles.form}>
        {!token ? (
          <p className={styles.errorBox} role="alert">
            This invitation link is incomplete — it does not carry an
            invitation token. Ask the person who invited you to send a
            fresh link.
          </p>
        ) : joined ? (
          <>
            <p className={styles.successBox} role="status">
              You have joined the workspace &ldquo;{joined.name}&rdquo;.
              It is now part of your workspace list, with the role the
              inviter chose for you.
            </p>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => navigateTo("app/studio")}
            >
              Open the workspace
            </button>
          </>
        ) : status === "loading" ? (
          <p className={styles.hint} role="status">
            Checking your session…
          </p>
        ) : status !== "authenticated" ? (
          <>
            <p className={styles.noteBox} role="status">
              To accept this invitation, sign in — or create an account
              — with the email address the invitation was sent to. Then
              open this invitation link again and it will complete
              here.
            </p>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => navigateTo("login")}
            >
              Sign in
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => navigateTo("signup")}
            >
              Create an account
            </button>
          </>
        ) : (
          <>
            <p className={styles.noteBox} role="status">
              Signed in as {user?.email}. Accepting adds you to the
              inviting workspace with the role chosen by the person who
              invited you.
            </p>
            {error ? (
              <>
                <p className={styles.errorBox} role="alert">
                  {error}
                </p>
                <p className={styles.hint}>
                  Invitation links expire and work once. If this one
                  has expired or was already used, ask the inviter for
                  a fresh invitation.
                </p>
              </>
            ) : null}
            <button
              type="button"
              className={styles.primaryButton}
              onClick={onAccept}
              disabled={accepting}
            >
              {accepting ? "Accepting…" : "Accept invitation"}
            </button>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
