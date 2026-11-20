import { z } from "zod";
import { USER_ROLES, type UserRole } from "@/db/schema";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./passwords";
import {
  absoluteUrl,
  generateLinkToken,
  hashLinkToken,
  isWellFormedLinkToken,
} from "./links";

/** How long an invitation link works. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const generateInvitationToken = generateLinkToken;
export const hashInvitationToken = hashLinkToken;
export const isWellFormedInvitationToken = isWellFormedLinkToken;

export const invitationPath = (token: string) => `/invite/${token}`;

/** The link's full address, from the request's own scheme and host. */
export const invitationUrl = (
  token: string,
  request: { host: string | null; proto: string | null },
) => absoluteUrl(invitationPath(token), request);

// --- The admin's invite form -------------------------------------------

export interface InviteFormState {
  values: { email: string; role: string };
  fieldErrors: Partial<Record<"email" | "role", string>>;
  formError?: string;
  /** The new link: shown once, in the response to the form. */
  created?: { email: string; role: UserRole; url: string; expiresAt: string };
}

export const EMPTY_INVITE_FORM: InviteFormState = {
  values: { email: "", role: "member" },
  fieldErrors: {},
};

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

const emailSchema = z.string().trim().max(254).pipe(z.email());

export function parseInviteForm(
  formData: FormData,
):
  | { ok: true; values: { email: string; role: UserRole } }
  | { ok: false; state: InviteFormState } {
  const raw = { email: text(formData, "email"), role: text(formData, "role") };
  const email = emailSchema.safeParse(raw.email);
  const roleValid = (USER_ROLES as readonly string[]).includes(raw.role);
  if (email.success && roleValid) {
    return {
      ok: true,
      values: { email: email.data.toLowerCase(), role: raw.role as UserRole },
    };
  }
  return {
    ok: false,
    state: {
      values: raw,
      fieldErrors: {
        ...(!email.success && { email: "Enter an email address" }),
        ...(!roleValid && { role: "Choose admin, member or viewer" }),
      },
    },
  };
}

// --- The invitee's accept form -----------------------------------------

export interface AcceptFormState {
  error?: string;
}

export function parseAcceptForm(
  formData: FormData,
): { ok: true; password: string } | { ok: false; state: AcceptFormState } {
  const password = text(formData, "password");
  const confirm = text(formData, "confirmPassword");
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      state: {
        error: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters`,
      },
    };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return {
      ok: false,
      state: {
        error: `Passwords can be at most ${MAX_PASSWORD_LENGTH} characters`,
      },
    };
  }
  if (password !== confirm) {
    return { ok: false, state: { error: "The two passwords don't match" } };
  }
  return { ok: true, password };
}

/** One message for every unusable link, so none reveals more than another. */
export const INVALID_INVITATION_MESSAGE =
  "This invitation link can't be used. It may have expired, been used already, or been revoked. Ask an admin for a new one.";
