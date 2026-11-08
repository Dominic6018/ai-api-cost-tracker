/** Sends plain-text email over SMTP, for budget notifications. */

import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

const TIMEOUT_MS = 10_000;

export interface EmailConfig {
  smtpUrl: string;
  from: string;
  to: string[];
}

export interface EmailContent {
  subject: string;
  text: string;
}

/** Resolves with any recipients refused while others were accepted. */
export type SendEmail = (
  config: EmailConfig,
  content: EmailContent,
) => Promise<{ rejected: string[] }>;

/**
 * `smtps://` is TLS from the start. `smtp://` upgrades with STARTTLS, and
 * refuses to continue without it when there's a password to protect.
 * Throws for a URL that can't be used.
 */
export function transportOptions(smtpUrl: string): SMTPTransport.Options {
  const url = new URL(smtpUrl);
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
    throw new Error("Not an SMTP URL");
  }
  if (!url.hostname) throw new Error("The SMTP URL has no host");
  const secure = url.protocol === "smtps:";
  const user = decodeURIComponent(url.username);
  return {
    host: url.hostname,
    ...(url.port && { port: Number(url.port) }),
    secure,
    requireTLS: !secure && user !== "",
    ...(user && { auth: { user, pass: decodeURIComponent(url.password) } }),
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  };
}

export const sendEmail: SendEmail = async (config, content) => {
  const transport = nodemailer.createTransport(
    transportOptions(config.smtpUrl),
  );
  try {
    const info = await transport.sendMail({
      from: config.from,
      to: config.to,
      subject: content.subject,
      text: content.text,
    });
    return { rejected: info.rejected };
  } finally {
    transport.close();
  }
};
