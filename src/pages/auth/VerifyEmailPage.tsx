import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../features/auth/AuthContext";
import { parseHash } from "../../features/auth/routing";
import { authApi, AuthApiError } from "../../services/auth";
import { AuthLayout } from "./AuthLayout";
import styles from "./AuthPages.module.css";

/**
 * Verify Email — the one-time token arrives in the hash query
 * (#/verify-email?token=…). The result shown is the server's real
 * answer: success only when the server accepted the token.
 */
export default function VerifyEmailPage() {
  const { status, refresh, resendVerification, user } = useAuth();
  const token = useMemo(() => parseHash().params.get("token") ?? "", []);
  const [state, setState] = useState<"working" | "success" | "error" | "missing">(
    token ? "working" : "missing",
  );
  const [message, setMessage] = useState<string | null>(null);
  const [resendNote, setResendNote] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const ranRef = useRef(false);

  useEffect(() => {
    if (!token || ranRef.current) return;
    ranRef.current = true;
    (async () => {
      try {
        await authApi.verifyEmail(token);
        setState("success");
        await refresh();
      } catch (err) {
        setState("error");
        setMessage(
          err instanceof AuthApiError
            ? err.message
            : "Verification failed. Please request a new link.",
        );
      }
    })();
  }, [token, refresh]);

  const onResend = async () => {
    setResending(true);
    setResendNote(null);
    try {
      const result = await resendVerification();
      setResendNote(
        result.emailConfigured
          ? "A new verification email has been sent."
          : "A new verification email has been prepared. Email delivery is not configured on this server, so it was written to the server outbox (server/data/outbox) instead of being delivered.",
      );
    } catch (err) {
      setResendNote(
        err instanceof AuthApiError ? err.message : "Could not resend right now. Please try again later.",
      );
    } finally {
      setResending(false);
    }
  };

  return (
    <AuthLayout
      headline="Verify your email"
      description="Verification confirms the email on your CLIPFORGE account is really yours."
      footer={
        <>
          <a href="#/login">Go to Sign In</a>
        </>
      }
    >
      <div className={styles.form}>
        {state === "working" ? (
          <p className={styles.noteBox} role="status">
            Checking your verification link…
          </p>
        ) : null}
        {state === "success" ? (
          <p className={styles.successBox} role="status">
            Your email is verified.{" "}
            {user ? `Signed in as ${user.displayName}.` : "You can sign in now."}
          </p>
        ) : null}
        {state === "error" ? (
          <p className={styles.errorBox} role="alert">
            {message ?? "This verification link is invalid or has expired."}
          </p>
        ) : null}
        {state === "missing" ? (
          <p className={styles.errorBox} role="alert">
            This page needs a verification link from your email.
          </p>
        ) : null}

        {state === "success" ? (
          <a
            className={styles.primaryButton}
            href="#/app/studio"
            style={{ textAlign: "center", textDecoration: "none" }}
          >
            Continue to Studio
          </a>
        ) : null}

        {(state === "error" || state === "missing") && status === "authenticated" ? (
          <>
            <button type="button" className={styles.secondaryButton} onClick={onResend} disabled={resending}>
              {resending ? "Resending…" : "Resend verification email"}
            </button>
            {resendNote ? (
              <p className={styles.noteBox} role="status">
                {resendNote}
              </p>
            ) : null}
          </>
        ) : null}
        {(state === "error" || state === "missing") && status !== "authenticated" ? (
          <p className={styles.hint}>
            Sign in first, then use the resend option in the workspace
            banner to get a fresh link.
          </p>
        ) : null}
      </div>
    </AuthLayout>
  );
}
