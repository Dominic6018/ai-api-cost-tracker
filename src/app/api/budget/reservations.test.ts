import { describe, expect, it, vi } from "vitest";
import type { AuthenticateResult } from "@/db/api-keys";
import type { ReserveResult } from "@/db/budget-reservations";
import type { BudgetReservation } from "@/db/schema";
import { decideBudgetCheck } from "@/lib/budget-check";
import { createReleaseHandler, createReserveHandler } from "./reservations";

const now = new Date("2026-11-10T12:00:00Z");
const projectId = "4f0c6c5e-2f7a-4b8e-9d1a-3c5e7f9a1b2c";
const apiKey = "act_" + "a".repeat(43);

const reservation: BudgetReservation = {
  id: "0d7e3c1a-5b2f-4e6d-8a9c-1b3d5f7e9a0c",
  projectId,
  reservationKey: "step-1",
  runId: "run_42",
  amountUsd: "0.250000",
  status: "held",
  expiresAt: new Date("2026-11-10T12:10:00Z"),
  createdAt: now,
  endedAt: null,
};

const decision = decideBudgetCheck(
  { estimateMicros: 250_000n, runId: "run_42" },
  {
    monthlyBudgetUsd: "10.00",
    runBudgetUsd: "1.00",
    monthSpentUsd: "4.000000",
    runSpentUsd: "0.500000",
  },
  now,
);

function setup({
  reserved = { ok: true, decision, reservation, replayed: false },
  released = reservation as BudgetReservation | undefined,
  scope = "ingest" as "ingest" | "read",
}: {
  reserved?: ReserveResult;
  released?: BudgetReservation | undefined;
  scope?: "ingest" | "read";
} = {}) {
  const deps = {
    authenticate: vi.fn().mockResolvedValue({
      ok: true,
      projectId,
      apiKeyId: "key-1",
      scope,
    } as AuthenticateResult),
    recordAuthFailure: vi.fn(),
    reserve: vi.fn().mockResolvedValue(reserved),
    release: vi.fn().mockResolvedValue(released),
    now: () => now,
  };
  return {
    deps,
    reserve: createReserveHandler(deps),
    release: createReleaseHandler(deps),
  };
}

const post = (path: string, body: unknown) =>
  new Request(`http://localhost/api/budget/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("POST /api/budget/reserve", () => {
  it("holds the estimate and returns the reservation", async () => {
    const { deps, reserve } = setup();
    const response = await reserve(
      post("reserve", {
        reservationId: "step-1",
        estimatedCostUsd: "0.25",
        runId: "run_42",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(deps.reserve).toHaveBeenCalledWith(
      projectId,
      {
        reservationId: "step-1",
        estimateMicros: 250_000n,
        runId: "run_42",
        ttlSeconds: 600,
      },
      now,
    );
    expect(await response.json()).toMatchObject({
      allowed: true,
      reservation: {
        reservationId: "step-1",
        amountUsd: "0.250000",
        runId: "run_42",
        status: "held",
        expiresAt: "2026-11-10T12:10:00.000Z",
      },
      replayed: false,
    });
  });

  it("answers a denial with no reservation", async () => {
    const { reserve } = setup({
      reserved: {
        ok: true,
        decision: { ...decision, allowed: false, reasons: ["run_budget"] },
        reservation: null,
        replayed: false,
      },
    });
    const response = await reserve(
      post("reserve", { reservationId: "s", estimatedCostUsd: 5 }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      allowed: false,
      reasons: ["run_budget"],
      reservation: null,
    });
  });

  it.each([
    [{ estimatedCostUsd: "0.25" }, "reservationId"],
    [{ reservationId: "s" }, "estimatedCostUsd"],
    [
      { reservationId: "s", estimatedCostUsd: "1", ttlSeconds: 0 },
      "ttlSeconds",
    ],
    [
      { reservationId: "s", estimatedCostUsd: "1", ttlSeconds: 86_401 },
      "ttlSeconds",
    ],
    [{ reservationId: "s", estimatedCostUsd: "1", extra: 1 }, null],
  ])("rejects %j", async (body, field) => {
    const { deps, reserve } = setup();
    const response = await reserve(post("reserve", body));
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.code).toBe("invalid_payload");
    if (field) expect(json.error.fieldErrors).toHaveProperty(field);
    expect(deps.reserve).not.toHaveBeenCalled();
  });

  it.each([
    ["project_not_found", 404],
    ["reservation_conflict", 409],
  ] as const)("maps %s to HTTP %d", async (error, status) => {
    const { reserve } = setup({ reserved: { ok: false, error } });
    const response = await reserve(
      post("reserve", { reservationId: "s", estimatedCostUsd: "1" }),
    );
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(error);
  });

  it("needs an ingest key", async () => {
    const { deps, reserve } = setup({ scope: "read" });
    const response = await reserve(
      post("reserve", { reservationId: "s", estimatedCostUsd: "1" }),
    );
    expect(response.status).toBe(403);
    expect(deps.reserve).not.toHaveBeenCalled();
  });

  it("refuses a body that isn't JSON", async () => {
    const { reserve } = setup();
    expect((await reserve(post("reserve", "{"))).status).toBe(400);
  });
});

describe("POST /api/budget/release", () => {
  it("returns the reservation as it now is", async () => {
    const { deps, release } = setup({
      released: { ...reservation, status: "released", endedAt: now },
    });
    const response = await release(
      post("release", { reservationId: "step-1" }),
    );
    expect(response.status).toBe(200);
    expect(deps.release).toHaveBeenCalledWith(projectId, "step-1", now);
    expect((await response.json()).reservation).toMatchObject({
      status: "released",
    });
  });

  it("reports a lapsed hold as expired", async () => {
    const { release } = setup({
      released: { ...reservation, expiresAt: new Date(now.getTime() - 1) },
    });
    const response = await release(
      post("release", { reservationId: "step-1" }),
    );
    expect((await response.json()).reservation.status).toBe("expired");
  });

  it("is a 404 for an unknown reservation", async () => {
    const { deps, release } = setup();
    deps.release.mockResolvedValue(undefined);
    const response = await release(post("release", { reservationId: "nope" }));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("reservation_not_found");
  });
});
