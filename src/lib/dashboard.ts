/**
 * The dashboard has no authentication yet (#20), and server actions are
 * public endpoints, so dashboard pages and actions are off in production.
 */
export function isDashboardEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}
