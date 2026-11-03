import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../../features/auth/AuthContext";
import { navigateTo, returnTarget } from "../../features/auth/routing";
import { authApi, AuthApiError, type AuthConfig } from "../../services/auth";
import { AuthLayout, PasswordField, TextField } from "./AuthLayout";
import { checkPassword, isValidEmail, passwordStrength } from "./validation";
import styles from "./AuthPages.module.css";

/**
 * Create Account — registers against the real backend. The account is
 * created UNVERIFIED; this screen shows the actual verification state
 * from the server response and offers a working resend (rate-limited
 * by the server). Only minimal data is collected: name, email,
 * password. No phone, no date of birth.
 */
export default function SignupPage() {
  const { register, resendVerification, status } = useAuth();
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);

  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [googleNotice, setGoogleNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ emailConfigured: boolean; emailVerificationRequired: boolean } | null>(null);
  const [resendState, setResendState] = useState<string | null>(null);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    authApi.getConfig().then(setConfig).catch(() => setConfig(null));
  }, []);

  useEffect(() => {
    // Already signed in and just browsing to /signup — go to workspace.
    if (status === "authenticated" && !done) {
      navigateTo(returnTarget());
    }
  }, [status, done]);

  const strength = passwordStrength(password);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const next: Record<string, string | null> = {};
    if (!displayName.trim()) next.displayName = "Display name is required.";
    if (!isValidEmail(email)) next.email = "Enter a valid email address.";
    const pw = checkPassword(password);
    if (!pw.ok) next.password = pw.message;
    if (password !== confirmPassword) next.confirm = "Passwords do not match.";
    if (!termsAccepted) next.terms = "You must accept the terms to create an account.";
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;

    setSubmitting(true);
    try {
      const result = await register({
        displayName: displayName.trim(),
        email: email.trim(),
        password,
        confirmPassword,
        termsAccepted,
      });
      setDone({
        emailConfigured: result.emailConfigured,
        emailVerificationRequired: result.emailVerificationRequired,
      });
    } catch (err) {
      if (err instanceof AuthApiError) {
        setFormError(err.message);
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onResend = async () => {
    setResending(true);
    setResendState(null);
    try {
      const result = await resendVerification();
      setResendState(
        result.emailConfigured
          ? "A new verification email has been sent."
          : "A new verification email has been prepared. Email delivery is not configured on this server, so in this development setup it is written to the server outbox instead of being delivered.",
      );
    } catch (err) {
      setResendState(
        err instanceof AuthApiError ? err.message : "Could not resend right now. Please try again later.",
      );
    } finally {
      setResending(false);
    }
  };

  if (done) {
    return (
      <AuthLayout
        headline="Account created"
        description={
          done.emailVerificationRequired
            ? "Your CLIPFORGE account exists. One step remains before it counts as verified."
            : "Your CLIPFORGE account exists and is ready to use."
        }
        footer={
          <>
            Wrong email? <a href="#/login">Sign in with a different account</a>
          </>
        }
      >
        <div className={styles.form}>
          {done.emailVerificationRequired ? (
            <>
              <p className={styles.noteBox} role="status">
                <strong>Email verification: pending.</strong>{" "}
                {done.emailConfigured
                  ? "We sent a verification link to your email address. Open it to verify your account."
                  : "Email delivery is not configured on this server, so no email could be delivered. In this development setup the verification message is written to the server outbox (server/data/outbox) — open the newest file there and follow its link."}
              </p>
              <button type="button" className={styles.secondaryButton} onClick={onResend} disabled={resending}>
                {resending ? "Resending…" : "Resend verification email"}
              </button>
              {resendState ? (
                <p className={styles.noteBox} role="status">
                  {resendState}
                </p>
              ) : null}
            </>
          ) : (
            <p className={styles.noteBox} role="status">
              This server does not require email verification, so there
              is no verification link to wait for — your account is
              ready to use.
            </p>
          )}
          <button type="button" className={styles.primaryButton} onClick={() => navigateTo(returnTarget())}>
            Continue to Studio
          </button>
          {done.emailVerificationRequired ? (
            <p className={styles.hint}>
              You can keep exploring now; your verification state stays
              visible in the workspace until the link is used.
            </p>
          ) : null}
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      headline="Create your account"
      description="One account for your CLIPFORGE workspace. We only ask for a name, an email and a password."
      footer={
        <>
          Already have an account? <a href="#/login">Sign in</a>
        </>
      }
    >
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {formError ? (
          <p className={styles.errorBox} role="alert">
            {formError}
          </p>
        ) : null}

        <TextField
          id="signup-name"
          label="Display name"
          value={displayName}
          onChange={setDisplayName}
          autoComplete="name"
          error={errors.displayName}
        />
        <TextField
          id="signup-email"
          label="Email address"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          error={errors.email}
        />
        <div>
          <PasswordField
            id="signup-password"
            label="Password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            error={errors.password}
            hint="At least 10 characters, with an uppercase letter, a lowercase letter and a number."
          />
          {password ? (
            <div className={styles.strengthRow} aria-hidden="true">
              <span className={styles.strengthTrack}>
                <span
                  className={styles.strengthFill}
                  data-score={strength.score}
                  style={{ width: `${((strength.score + 1) / 4) * 100}%` }}
                />
              </span>
              <span>{strength.label}</span>
            </div>
          ) : null}
        </div>
        <PasswordField
          id="signup-confirm"
          label="Confirm password"
          value={confirmPassword}
          onChange={setConfirmPassword}
          autoComplete="new-password"
          error={errors.confirm}
        />

        <label className={styles.checkRow} htmlFor="signup-terms">
          <input
            id="signup-terms"
            type="checkbox"
            checked={termsAccepted}
            onChange={(e) => setTermsAccepted(e.target.checked)}
            aria-invalid={errors.terms ? true : undefined}
            aria-describedby={errors.terms ? "signup-terms-error" : undefined}
          />
          I agree to the CLIPFORGE terms of use and understand my clips
          remain my own content.
        </label>
        {errors.terms ? (
          <p className={styles.fieldError} id="signup-terms-error" role="alert">
            {errors.terms}
          </p>
        ) : null}

        <button type="submit" className={styles.primaryButton} disabled={submitting}>
          {submitting ? "Creating account…" : "Create Account"}
        </button>

        <div className={styles.divider} aria-hidden="true">
          or
        </div>

        {/* Same treatment as the sign-in page: no Google OAuth flow
            exists, so the ENABLED control explains that in an
            in-page notice on click instead of sitting silent. */}
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() =>
            setGoogleNotice(
              config?.googleConfigured
                ? "The server reports Google sign-in as configured, but the Google OAuth flow is not available in this app yet — no sign-in was started. Please create your account with email and a password."
                : "Google sign-in is not configured on this server — no Google OAuth credentials are set up, so it cannot create your account. Please sign up with email and a password instead.",
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
      </form>
    </AuthLayout>
  );
}
