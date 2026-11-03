// Client-side validation mirroring the server rules in
// server/src/app.ts (zod schemas). Client checks are for fast,
// friendly feedback only — the server re-validates everything and
// its response is what the UI ultimately trusts.

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export interface PasswordCheck {
  ok: boolean;
  message: string;
}

export function checkPassword(password: string): PasswordCheck {
  if (password.length < 10) {
    return { ok: false, message: "Password must be at least 10 characters long." };
  }
  if (!/[a-z]/.test(password)) {
    return { ok: false, message: "Password must contain a lowercase letter." };
  }
  if (!/[A-Z]/.test(password)) {
    return { ok: false, message: "Password must contain an uppercase letter." };
  }
  if (!/[0-9]/.test(password)) {
    return { ok: false, message: "Password must contain a number." };
  }
  return { ok: true, message: "Password meets the requirements." };
}

/** Simple 0–3 strength hint for display next to the password field. */
export function passwordStrength(password: string): { score: number; label: string } {
  let score = 0;
  if (password.length >= 10) score += 1;
  if (password.length >= 14) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  const capped = Math.min(score, 3);
  return { score: capped, label: ["Weak", "Okay", "Good", "Strong"][capped] ?? "Weak" };
}
