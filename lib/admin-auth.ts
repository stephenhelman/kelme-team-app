// Trivial shared-password gate for the prototype's admin portal — not real
// auth. The cookie just holds the shared password itself; middleware (which
// runs on the Edge runtime) compares it straight against ADMIN_PASSWORD.

const COOKIE_NAME = "admin_session";

export function adminCookieName(): string {
  return COOKIE_NAME;
}

export function isValidAdminToken(token: string | undefined): boolean {
  const password = process.env.ADMIN_PASSWORD ?? "";
  return Boolean(token) && Boolean(password) && token === password;
}

export function checkAdminPassword(password: string): boolean {
  return password === (process.env.ADMIN_PASSWORD ?? "");
}
