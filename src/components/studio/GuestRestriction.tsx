import styles from "../../features/studio/Studio.module.css";

/** Shown instead of any account-backed workflow in guest demo mode. */
export default function GuestRestriction({ action }: { action: string }) {
  return (
    <div className={`${styles.banner} ${styles.bannerLime}`} role="note">
      <strong>Demo Mode — {action} needs a free account.</strong>
      <p>
        You are exploring a demonstration workspace. Guest mode never saves projects, uploads or
        personal data. Create an account to {action.charAt(0).toLowerCase() + action.slice(1)} for
        real.
      </p>
      <p>
        <a href="#/signup">Create a free account</a> · <a href="#/login">Sign in</a>
      </p>
    </div>
  );
}
