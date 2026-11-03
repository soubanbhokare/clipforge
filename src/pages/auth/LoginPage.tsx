import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../../features/auth/AuthContext";
import { navigateTo, returnTarget } from "../../features/auth/routing";
import { authApi, AuthApiError, type AuthConfig } from "../../services/auth";
import { AuthLayout, PasswordField, TextField } from "./AuthLayout";
import { isValidEmail } from "./validation";
import styles from "./AuthPages.module.css";

/**
 * Sign In — real authentication against the CLIPFORGE server.
 * No fake success states: the workspace opens only after the server
 * confirms the session. No Google OAuth sign-in flow exists (no
 * credentials are configured), so the Google control stays ENABLED
 * and explains exactly that in an in-page notice when clicked —
 * never a disabled, silent button.
 */
export default function LoginPage() {
  const { login, completeLogin, enterGuest, status } = useAuth();
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [googleNotice, setGoogleNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Phase 12 MFA: after the password step the server may answer with
  // a short-lived challenge instead of a session.
  const [mfaChallenge, setMfaChallenge] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");

  useEffect(() => {
    authApi.getConfig().then(setConfig).catch(() => setConfig(null));
  }, []);

  useEffect(() => {
    if (status === "authenticated") {
      navigateTo(returnTarget());
    }
  }, [status]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!isValidEmail(email)) {
      setEmailError("Enter a valid email address.");
      return;
    }
    setEmailError(null);
    if (!password) {
      setPasswordError("Password is required.");
      return;
    }
    setPasswordError(null);
    setSubmitting(true);
    try {
      const result = await login(email.trim(), password, rememberMe);
      if (result.kind === "mfa") {
        setMfaChallenge(result.challengeToken);
        setPassword("");
        return;
      }
      navigateTo(returnTarget());
    } catch (err) {
      if (err instanceof AuthApiError) {
        // 401 reads "Invalid email or password." from the server —
        // deliberately generic, shown as-is.
        setFormError(err.message);
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onMfaSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!mfaChallenge) return;
    setFormError(null);
    setSubmitting(true);
    try {
      const user = await authApi.loginMfa(mfaChallenge, mfaCode.trim());
      completeLogin(user);
      navigateTo(returnTarget());
    } catch (err) {
      setFormError(
        err instanceof AuthApiError ? err.message : "Something went wrong. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const onExploreDemo = () => {
    enterGuest();
    navigateTo("studio");
  };

  return (
    <AuthLayout
      headline="Welcome back"
      description="Sign in to your CLIPFORGE workspace to turn long videos into shorts and reels."
      footer={
        <>
          New to CLIPFORGE? <a href="#/signup">Create an account</a>
        </>
      }
    >
      {mfaChallenge ? (
        <form className={styles.form} onSubmit={onMfaSubmit} noValidate>
          {formError ? (
            <p className={styles.errorBox} role="alert">
              {formError}
            </p>
          ) : null}
          <p className={styles.hint}>
            Two-factor authentication is on for this account. Enter the
            6-digit code from your authenticator app, or one of your
            recovery codes. The challenge expires in about 5 minutes.
          </p>
          <TextField
            id="login-mfa-code"
            label="Authentication code"
            type="text"
            value={mfaCode}
            onChange={setMfaCode}
            autoComplete="one-time-code"
          />
          <button type="submit" className={styles.primaryButton} disabled={submitting || !mfaCode.trim()}>
            {submitting ? "Verifying…" : "Verify and sign in"}
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => {
              setMfaChallenge(null);
              setMfaCode("");
              setFormError(null);
            }}
          >
            Back to sign in
          </button>
        </form>
      ) : (
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {formError ? (
          <p className={styles.errorBox} role="alert">
            {formError}
          </p>
        ) : null}

        <TextField
          id="login-email"
          label="Email address"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          error={emailError}
        />
        <PasswordField
          id="login-password"
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          error={passwordError}
        />

        <div className={styles.rowBetween}>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
            />
            Remember me (30-day session)
          </label>
          <a className={styles.link} href="#/forgot-password">
            Forgot password?
          </a>
        </div>

        <button type="submit" className={styles.primaryButton} disabled={submitting}>
          {submitting ? "Signing in…" : "Sign In"}
        </button>

        <div className={styles.divider} aria-hidden="true">
          or
        </div>

        {/* No Google OAuth flow exists in this app. The control
            stays ENABLED and explains the situation in an in-page
            notice on click — a disabled, silent button would leave
            the user guessing (standing product rule). */}
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() =>
            setGoogleNotice(
              config?.googleConfigured
                ? "The server reports Google sign-in as configured, but the Google OAuth flow is not available in this app yet — no sign-in was started. Please use your email and password."
                : "Google sign-in is not configured on this server — no Google OAuth credentials are set up, so it cannot sign you in. Please use your email and password instead.",
            )
          }
        >
          {config?.googleConfigured ? "Continue with Google" : "Google sign-in is not configured"}
        </button>
        {googleNotice ? (
          <p className={styles.noteBox} role="status">
            {googleNotice}
          </p>
        ) : null}

        <button type="button" className={styles.secondaryButton} onClick={onExploreDemo}>
          Explore Demo — no account needed
        </button>
        <p className={styles.hint}>
          Demo mode is a clearly labelled sample workspace. Nothing is
          saved and no real processing runs there.
        </p>
      </form>
      )}
    </AuthLayout>
  );
}
