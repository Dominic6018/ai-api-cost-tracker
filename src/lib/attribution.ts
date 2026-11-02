/**
 * Who and what a usage event is for, beyond its project: the customer, the
 * end user in your app, the feature and the agent run. Each is an optional
 * free-form ID chosen by the caller.
 */
export const ATTRIBUTION_FIELDS = [
  { key: "customerId", param: "customer", label: "Customer" },
  { key: "userId", param: "user", label: "User" },
  { key: "feature", param: "feature", label: "Feature" },
  { key: "runId", param: "run", label: "Run" },
] as const;

export type AttributionKey = (typeof ATTRIBUTION_FIELDS)[number]["key"];
export type Attribution = Partial<Record<AttributionKey, string>>;

/** Longest accepted attribution value. */
export const MAX_ATTRIBUTION_LENGTH = 200;
