// Replaceable email-service adapter.
//
// Two real adapters exist:
//  - SMTP adapter (nodemailer) — used when SMTP_HOST (and friends) are
//    configured in the server environment.
//  - Outbox adapter (development default) — writes each outgoing email
//    as a JSON file into server/data/outbox/. That directory is
//    server-only and gitignored; tokens inside those files are never
//    included in any API response. This adapter exists so local
//    development and the e2e suite can complete verification/reset
//    flows honestly, without pretending an SMTP delivery happened.
//
// Callers learn which adapter is active from emailConfigured in config.

import fs from "node:fs";
import path from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import { config, emailConfigured, serverDir } from "./config.js";

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const outboxDir = path.join(serverDir, "data", "outbox");

let smtpTransport: Transporter | null = null;
function getSmtpTransport(): Transporter {
  if (!smtpTransport) {
    smtpTransport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user
        ? { user: config.smtp.user, pass: config.smtp.pass }
        : undefined,
    });
  }
  return smtpTransport;
}

export async function sendEmail(email: OutgoingEmail): Promise<void> {
  if (emailConfigured) {
    await getSmtpTransport().sendMail({
      from: config.smtp.from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    return;
  }

  // Outbox (development) adapter.
  fs.mkdirSync(outboxDir, { recursive: true });
  const file = path.join(
    outboxDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${email.to.replace(
      /[^a-z0-9@._-]/gi,
      "_",
    )}.json`,
  );
  fs.writeFileSync(file, JSON.stringify({ ...email, file }, null, 2), "utf8");
  console.log(`[email:outbox] wrote "${email.subject}" for ${email.to} -> ${file}`);
}

// ---- Message builders -------------------------------------------------

export function verificationEmail(to: string, token: string): OutgoingEmail {
  const link = `${config.appBaseUrl}/#/verify-email?token=${encodeURIComponent(token)}`;
  return {
    to,
    subject: "Verify your CLIPFORGE email",
    text: `Welcome to CLIPFORGE.\n\nVerify your email address by opening this link:\n${link}\n\nThis link expires in 24 hours. If you did not create an account, ignore this email.`,
    html: `<p>Welcome to CLIPFORGE.</p><p>Verify your email address:</p><p><a href="${link}">${link}</a></p><p>This link expires in 24 hours. If you did not create an account, ignore this email.</p>`,
  };
}

export function passwordResetEmail(to: string, token: string): OutgoingEmail {
  const link = `${config.appBaseUrl}/#/reset-password?token=${encodeURIComponent(token)}`;
  return {
    to,
    subject: "Reset your CLIPFORGE password",
    text: `A password reset was requested for your CLIPFORGE account.\n\nReset your password by opening this link:\n${link}\n\nThis link expires in 30 minutes and can be used once. If you did not request this, ignore this email — your password will not change.`,
    html: `<p>A password reset was requested for your CLIPFORGE account.</p><p>Reset your password:</p><p><a href="${link}">${link}</a></p><p>This link expires in 30 minutes and can be used once. If you did not request this, ignore this email.</p>`,
  };
}
