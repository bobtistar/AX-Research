import { describe, expect, it } from "vitest";
import {
  SEARCH_COOLDOWN_MS,
  commitCooldown,
  enforceSearchCooldown,
  evaluateCooldown,
  requestAddress,
  type CooldownStore,
} from "./rateLimit";

describe("search cooldown", () => {
  const keys = ["guest:a", "addr:1.2.3.4"];

  it("allows the first call and blocks an immediate repeat", () => {
    const store: CooldownStore = new Map();
    expect(evaluateCooldown(store, keys, 0, SEARCH_COOLDOWN_MS)).toEqual({
      allowed: true,
    });
    commitCooldown(store, keys, 0, SEARCH_COOLDOWN_MS);
    expect(evaluateCooldown(store, keys, 1_000, SEARCH_COOLDOWN_MS)).toEqual({
      allowed: false,
      retryAfterSeconds: 59,
    });
  });

  it("allows the call again once the window has passed", () => {
    const store: CooldownStore = new Map();
    commitCooldown(store, keys, 0, SEARCH_COOLDOWN_MS);
    expect(
      evaluateCooldown(store, keys, SEARCH_COOLDOWN_MS, SEARCH_COOLDOWN_MS)
    ).toEqual({
      allowed: true,
    });
  });

  it("blocks a rotated guest key that reuses one address", () => {
    const store: CooldownStore = new Map();
    commitCooldown(store, ["guest:a", "addr:1.2.3.4"], 0, SEARCH_COOLDOWN_MS);
    // A client-generated guest key is free to rotate; the address is what actually limits.
    const rotated = evaluateCooldown(
      store,
      ["guest:b", "addr:1.2.3.4"],
      5_000,
      SEARCH_COOLDOWN_MS
    );
    expect(rotated).toEqual({ allowed: false, retryAfterSeconds: 55 });
  });

  it("does not let one caller block a different address", () => {
    const store: CooldownStore = new Map();
    commitCooldown(store, ["guest:a", "addr:1.2.3.4"], 0, SEARCH_COOLDOWN_MS);
    expect(
      evaluateCooldown(
        store,
        ["guest:b", "addr:5.6.7.8"],
        1_000,
        SEARCH_COOLDOWN_MS
      )
    ).toEqual({ allowed: true });
  });

  it("drops entries that can no longer block, so the store does not grow forever", () => {
    const store: CooldownStore = new Map();
    commitCooldown(store, ["guest:old", "addr:old"], 0, SEARCH_COOLDOWN_MS);
    commitCooldown(
      store,
      ["guest:new"],
      SEARCH_COOLDOWN_MS + 1,
      SEARCH_COOLDOWN_MS
    );
    expect(Array.from(store.keys())).toEqual(["guest:new"]);
  });

  it("reports the wait in the thrown message", () => {
    const store: CooldownStore = new Map();
    enforceSearchCooldown("a", "1.2.3.4", 0, store);
    expect(() => enforceSearchCooldown("a", "1.2.3.4", 10_000, store)).toThrow(
      /50초 후/
    );
  });
});

describe("caller address", () => {
  it("prefers the first proxy hop", () => {
    expect(
      requestAddress({
        headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
        ip: "10.0.0.1",
      })
    ).toBe("203.0.113.9");
  });

  it("falls back to the socket address when no header or ip is present", () => {
    expect(requestAddress({ socket: { remoteAddress: "198.51.100.7" } })).toBe(
      "198.51.100.7"
    );
    expect(requestAddress({})).toBe("unknown");
  });
});
