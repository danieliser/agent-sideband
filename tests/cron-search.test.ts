import { describe, expect, it, vi } from "vitest";
import {
  nextSlotAfter,
  nextCronMatch,
  normalizeTrigger,
  parseCron,
} from "../src/scheduling/triggers.js";

describe("cron calendar search", () => {
  it("rejects impossible dates without formatting millions of timezone minutes", () => {
    const formats = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    try {
      expect(() =>
        normalizeTrigger(
          { type: "cron", expression: "0 9 31 FEB *", timezone: "America/New_York" },
          Date.parse("2026-01-01T00:00:00Z"),
        ),
      ).toThrow("no matching time");
      expect(formats.mock.calls.length).toBeLessThan(100);
    } finally {
      formats.mockRestore();
    }
  });

  it.each([
    ["America/New_York", "0 9 29 FEB TUE", "2028-02-29T14:00:00.000Z"],
    ["Pacific/Kiritimati", "0 0 1 JAN *", "2026-12-31T10:00:00.000Z"],
    ["Asia/Kathmandu", "15 0 1 JAN *", "2026-12-31T18:30:00.000Z"],
    ["Pacific/Pago_Pago", "0 23 1 JAN *", "2027-01-02T10:00:00.000Z"],
  ])("preserves distant matches and offset boundaries for %s", (timezone, expression, expected) => {
    const result = nextCronMatch(
      parseCron(expression),
      timezone,
      Date.parse("2026-03-01T00:00:00Z"),
    );
    expect(new Date(result!).toISOString()).toBe(expected);
  });
});

it("rejects overflowing interval steps and safely exhausts existing cursors", () => {
  const startAt = "2026-11-10T00:00:00.000Z";
  expect(() =>
    normalizeTrigger(
      { type: "interval", everySeconds: Number.MAX_SAFE_INTEGER, startAt },
      Date.parse(startAt),
    ),
  ).toThrow("everySeconds");
  expect(
    nextSlotAfter(
      { type: "interval", everySeconds: Number.MAX_SAFE_INTEGER, startAt },
      Date.parse(startAt),
    ),
  ).toBeNull();
  expect(nextSlotAfter({ type: "interval", everySeconds: 1, startAt }, 8.64e15)).toBeNull();
});
