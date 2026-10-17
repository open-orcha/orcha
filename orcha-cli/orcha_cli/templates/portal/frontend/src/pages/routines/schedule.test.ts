import { describe, expect, it } from "vitest";
import { DEFAULT_FORM, describeSchedule, fromCron, relFuture, toCron, zoneLabel, type ScheduleForm } from "./schedule";

const f = (p: Partial<ScheduleForm>): ScheduleForm => ({ ...DEFAULT_FORM, ...p });

describe("routine schedule presets", () => {
  it("builds cron from presets", () => {
    expect(toCron(f({ preset: "hourly", minute: 15 }))).toBe("15 * * * *");
    expect(toCron(f({ preset: "daily", time: "07:30" }))).toBe("30 7 * * *");
    expect(toCron(f({ preset: "weekdays", time: "09:00" }))).toBe("0 9 * * 1-5");
    expect(toCron(f({ preset: "weekly", time: "16:00", weekday: 5 }))).toBe("0 16 * * 5");
    expect(toCron(f({ preset: "monthly", time: "08:00", monthDay: 1 }))).toBe("0 8 1 * *");
    expect(toCron(f({ preset: "advanced", cron: "  0  8,17 * * *" }))).toBe("0 8,17 * * *");
  });

  it("round-trips presets and falls back to advanced", () => {
    for (const c of ["15 * * * *", "30 7 * * *", "0 9 * * 1-5", "0 16 * * 5", "0 8 1 * *"]) {
      expect(toCron(fromCron(c))).toBe(c);
    }
    expect(fromCron("0 9 * * 1-5").preset).toBe("weekdays");
    expect(fromCron("0 12 * * 7").weekday).toBe(0);
    expect(fromCron("0 8,17 * * *").preset).toBe("advanced");
    expect(fromCron("0 8 31 * *").preset).toBe("advanced");
  });

  it("describes schedules in plain English like the server", () => {
    expect(describeSchedule("0 9 * * 1-5", "Africa/Nairobi")).toBe("Every weekday at 09:00 Nairobi time");
    expect(describeSchedule("30 7 * * *", "UTC")).toBe("Every day at 07:30 UTC");
    expect(describeSchedule("15 * * * *", "UTC")).toBe("Every hour at :15");
    expect(describeSchedule("0 16 * * 5", "America/New_York")).toBe("Every Friday at 16:00 New York time");
    expect(describeSchedule("0 8 1 * *", "Europe/Berlin")).toBe("On the 1st of every month at 08:00 Berlin time");
    expect(describeSchedule("0 8,17 * * *", "UTC")).toBe("Custom schedule (0 8,17 * * *) UTC");
    expect(zoneLabel("America/Argentina/Buenos_Aires")).toBe("Buenos Aires time");
  });

  it("formats upcoming times relatively", () => {
    const now = Date.parse("2026-09-29T06:00:00Z");
    expect(relFuture("2026-09-29T06:30:00Z", now)).toBe("in 30m");
    expect(relFuture("2026-09-29T09:00:00Z", now)).toBe("in 3h");
    expect(relFuture("2026-10-02T06:00:00Z", now)).toBe("in 3d");
    expect(relFuture("2026-09-29T05:00:00Z", now)).toBe("overdue");
    expect(relFuture(null, now)).toBe("—");
  });
});
