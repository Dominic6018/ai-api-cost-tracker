import { z } from "zod";
import { MAX_PASSWORD_LENGTH } from "./passwords";

const loginSchema = z.object({
  // Trim before validating, so a pasted address with stray spaces still works.
  email: z.string().trim().max(254).pipe(z.email()),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export interface LoginFormState {
  error?: string;
  email: string;
}

export type ParseLoginResult =
  | { ok: true; email: string; password: string }
  | { ok: false; state: LoginFormState };

export function parseLoginForm(formData: FormData): ParseLoginResult {
  const email = formData.get("email");
  const password = formData.get("password");
  const result = loginSchema.safeParse({ email, password });
  if (result.success) return { ok: true, ...result.data };
  return {
    ok: false,
    state: {
      email: typeof email === "string" ? email : "",
      error: "Enter your email address and password",
    },
  };
}
