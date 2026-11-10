import { describe, expect, it } from "vitest";
import { outcomeOf } from "./ingestion-health";
import type { UsageEvent } from "./schema";

const event = (pricingStatus: "priced" | "unpriced") =>
  ({ pricingStatus }) as UsageEvent;

describe("outcomeOf", () => {
  it.each([
    [{ ok: true, event: event("priced"), replayed: false }, "stored"],
    [{ ok: true, event: event("unpriced"), replayed: false }, "unpriced"],
    [{ ok: true, event: event("priced"), replayed: true }, "replayed"],
    [{ ok: true, event: event("unpriced"), replayed: true }, "replayed"],
    [{ ok: false, error: "request_id_conflict" }, "conflict"],
    [{ ok: false, error: "project_not_found" }, null],
  ] as const)("counts %j as %s", (result, outcome) => {
    expect(outcomeOf(result)).toBe(outcome);
  });
});
