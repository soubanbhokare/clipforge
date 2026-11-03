import { useState, type FormEvent } from "react";
import { authApi, AuthApiError } from "../../services/auth";
import { AuthLayout, TextField } from "./AuthLayout";
import { isValidEmail } from "./validation";
import styles from "./AuthPages.module.css";

/**
 * Forgot Password — the server always answers with the same generic
 * message, whether or not the account exists, and this screen shows
 * exactly that message. It never claims an email was sent: when the
 * server reports email is not configured, that is stated plainly.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<{ message: string; emailConfigured: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!isValidEmail(email)) {
      setEmailError("Enter a valid email address.");
      return;
    }
    setEmailError(null);
    setSubmitting(true);
    try {
      const res = await authApi.forgotPassword(email.trim());
      setResult(res);
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
      headline="Reset your password"
      description="Enter the email you used for CLIPFORGE and we will handle the rest — without revealing whether an account exists."
      footer={
        <>
          Remembered it? <a href="#/login">Back to Sign In</a>
        </>
      }
    >
      {result ? (
        <div className={styles.form}>
          <p className={styles.successBox} role="status">
            {result.message}
          </p>
          {!result.emailConfigured ? (
            <p className={styles.noteBox}>
              Email delivery is not configured on this server, so a reset
              email cannot actually be delivered right now. In this
              development setup, reset messages are written to the server
              outbox (server/data/outbox) instead — the newest file there
              holds the reset link for an existing account.
            </p>
          ) : null}
          <a className={styles.link} href="#/login">
            Back to Sign In
          </a>
        </div>
      ) : (
        <form className={styles.form} onSubmit={onSubmit} noValidate>
          {formError ? (
            <p className={styles.errorBox} role="alert">
              {formError}
            </p>
          ) : null}
          <TextField
            id="forgot-email"
            label="Email address"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
            error={emailError}
          />
          <button type="submit" className={styles.primaryButton} disabled={submitting}>
            {submitting ? "Sending…" : "Send reset instructions"}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
