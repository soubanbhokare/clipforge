import { useMemo, useState, type FormEvent } from "react";
import { parseHash } from "../../features/auth/routing";
import { authApi, AuthApiError } from "../../services/auth";
import { AuthLayout, PasswordField } from "./AuthLayout";
import { checkPassword } from "./validation";
import styles from "./AuthPages.module.css";

/**
 * Reset Password — the one-time token arrives in the hash query
 * (#/reset-password?token=…). The server stores only a hash of it;
 * it expires after 30 minutes and a successful reset revokes every
 * existing session for the account.
 */
export default function ResetPasswordPage() {
  const token = useMemo(() => parseHash().params.get("token") ?? "", []);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const next: Record<string, string | null> = {};
    const pw = checkPassword(password);
    if (!pw.ok) next.password = pw.message;
    if (password !== confirmPassword) next.confirm = "Passwords do not match.";
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;

    setSubmitting(true);
    try {
      await authApi.resetPassword(token, password, confirmPassword);
      setDone(true);
    } catch (err) {
      setFormError(
        err instanceof AuthApiError ? err.message : "Something went wrong. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout
      headline="Choose a new password"
      description="Reset links work once and expire after 30 minutes. Resetting also signs out every other session on your account."
      footer={
        <>
          <a href="#/login">Back to Sign In</a>
        </>
      }
    >
      {done ? (
        <div className={styles.form}>
          <p className={styles.successBox} role="status">
            Your password has been reset. You can now sign in with the
            new password.
          </p>
          <a className={styles.primaryButton} href="#/login" style={{ textAlign: "center", textDecoration: "none" }}>
            Go to Sign In
          </a>
        </div>
      ) : !token ? (
        <p className={styles.errorBox} role="alert">
          This page needs a reset link. Request one from the{" "}
          <a className={styles.link} href="#/forgot-password">
            forgot password
          </a>{" "}
          page.
        </p>
      ) : (
        <form className={styles.form} onSubmit={onSubmit} noValidate>
          {formError ? (
            <p className={styles.errorBox} role="alert">
              {formError}
            </p>
          ) : null}
          <PasswordField
            id="reset-password"
            label="New password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            error={errors.password}
            hint="At least 10 characters, with an uppercase letter, a lowercase letter and a number."
          />
          <PasswordField
            id="reset-confirm"
            label="Confirm new password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
            error={errors.confirm}
          />
          <button type="submit" className={styles.primaryButton} disabled={submitting}>
            {submitting ? "Resetting…" : "Reset password"}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
