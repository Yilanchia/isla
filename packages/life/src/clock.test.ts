import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HOUR, nextLocalHour } from "./clock.js";

describe("nextLocalHour", () => {
  it("finds the next local hour in a zone without daylight saving", () => {
    const after = Date.parse("2026-11-01T05:30:00+08:00");
    assert.equal(nextLocalHour(after, 7, "Asia/Shanghai"), Date.parse("2026-11-01T07:00:00+08:00"));
    assert.equal(nextLocalHour(after, 3, "Asia/Shanghai"), Date.parse("2026-11-02T03:00:00+08:00"));
  });

  it("always moves forward across daylight-saving changes", () => {
    for (const zone of ["America/New_York", "Europe/Berlin", "Australia/Sydney"]) {
      let at = Date.parse("2026-01-01T00:00:00Z");
      const end = Date.parse("2027-01-01T00:00:00Z");
      while (at < end) {
        for (const hour of [0, 2, 3, 6, 12, 18]) {
          const next = nextLocalHour(at, hour, zone);
          assert.ok(next > at, `${zone} ${hour}:00 after ${new Date(at).toISOString()}`);
          assert.ok(next - at <= 26 * HOUR, `${zone} ${hour}:00 is within a day`);
        }
        at += 5 * HOUR + 17 * 60 * 1000;
      }
    }
  });
});
