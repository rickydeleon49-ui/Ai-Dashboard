/**
 * Release 2D.1 calendar — date arithmetic and strict query parsing.
 *
 * Month/week ranges, leap years, month/year boundaries, DST start/end in
 * several IANA zones, date-only round trips, the stored-value → calendar-day
 * rule, and strict rejection of invalid dates, ranges, zones and repeated
 * parameters. The grid arithmetic is also proven identical when the Node
 * process itself runs in different time zones.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import {
  addDays,
  addMonths,
  calendarDayOf,
  daysInMonth,
  diffDays,
  isDateOnly,
  isLeapYear,
  isValidTimeZone,
  isoWeekday,
  MAX_DATE,
  MIN_DATE,
  monthRange,
  shiftPeriod,
  todayInTimeZone,
  validateRange,
  weekRange,
} from "../../src/core/calendar/dates";
import {
  CalendarQueryError,
  decodeUnscheduledCursor,
  encodeFilterSearchCursor,
  encodeUnscheduledCursor,
  likePattern,
  parseCalendarRangeQuery,
  parseFilterSearchQuery,
  parseUnscheduledQuery,
} from "../../src/core/calendar/query";

const q = (s: string) => new URLSearchParams(s);

describe("calendar date-only values", () => {
  it("accepts only real YYYY-MM-DD days", () => {
    for (const ok of ["2026-01-01", "2028-02-29", "2000-02-29", "2026-12-31", "1900-01-01", "9999-12-31"]) {
      assert.equal(isDateOnly(ok), true, ok);
    }
    for (const bad of [
      "2026-02-29", "1900-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "2026-1-1", "26-01-01",
      "2026/01/01", "01/02/2026", "2026-01-01T00:00:00Z", " 2026-01-01", "1899-12-31", "10000-01-01", "", "abc",
    ]) {
      assert.equal(isDateOnly(bad), false, bad);
    }
    assert.equal(isDateOnly(20260101), false);
  });

  it("leap years follow the Gregorian rule", () => {
    assert.deepEqual([1900, 2000, 2024, 2026, 2028, 2100].map(isLeapYear), [false, true, true, false, true, false]);
    assert.equal(daysInMonth(2028, 2), 29);
    assert.equal(daysInMonth(2026, 2), 28);
    assert.equal(addDays("2028-02-28", 1), "2028-02-29");
    assert.equal(addDays("2028-02-29", 1), "2028-03-01");
    assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  });

  it("crosses month and year boundaries in both directions", () => {
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2027-01-01", -1), "2026-12-31");
    assert.equal(addDays("2026-01-31", 1), "2026-02-01");
    assert.equal(diffDays("2026-12-25", "2027-01-05"), 11);
    assert.equal(addMonths("2026-12-01", 1), "2027-01-01");
    assert.equal(addMonths("2026-01-15", -1), "2025-12-01");
    assert.equal(addMonths("2026-03-31", -13), "2025-02-01");
  });

  it("week ranges are Monday–Sunday and span year ends", () => {
    const w = weekRange("2027-01-01"); // a Friday
    assert.equal(w.from, "2026-12-28");
    assert.equal(w.to, "2027-01-03");
    assert.equal(w.days.length, 7);
    assert.equal(isoWeekday(w.from), 0);
    assert.deepEqual(weekRange("2026-09-20").days.slice(0, 1), ["2026-09-14"], "Sunday belongs to the week before");
  });

  it("month ranges cover whole ISO weeks (4–6 weeks)", () => {
    const feb2027 = monthRange("2027-02-10"); // Feb 1 2027 is a Monday, 28 days
    assert.equal(feb2027.from, "2027-02-01");
    assert.equal(feb2027.to, "2027-02-28");
    assert.equal(feb2027.days.length, 28);

    const aug2026 = monthRange("2026-08-31"); // starts Saturday → six weeks
    assert.equal(aug2026.from, "2026-07-27");
    assert.equal(aug2026.to, "2026-09-06");
    assert.equal(aug2026.days.length, 42);

    const feb2028 = monthRange("2028-02-29");
    assert.ok(feb2028.days.includes("2028-02-29"));
    assert.equal(feb2028.days.length % 7, 0);
    for (const r of [feb2027, aug2026, feb2028]) {
      assert.equal(new Set(r.days).size, r.days.length, "no duplicated day");
      for (let i = 1; i < r.days.length; i++) assert.equal(diffDays(r.days[i - 1]!, r.days[i]!), 1, "no skipped day");
    }
  });

  it("DST start and end never duplicate, skip or shift a day in the grid", () => {
    // US: 2026-03-08 / 2026-11-01. EU: 2026-03-29 / 2026-10-25. Southern: Sydney 2026-04-05 / 2026-10-04.
    for (const anchor of ["2026-03-08", "2026-11-01", "2026-03-29", "2026-10-25", "2026-04-05", "2026-10-04"]) {
      const week = weekRange(anchor);
      assert.equal(week.days.length, 7);
      assert.ok(week.days.includes(anchor));
      assert.equal(new Set(week.days).size, 7);
    }
  });

  it("today is computed in the given IANA zone, including across DST changes", () => {
    const instant = new Date("2026-03-08T07:30:00.000Z"); // 02:30 EST was skipped; NY is 03:30 EDT
    assert.equal(todayInTimeZone("America/New_York", instant), "2026-03-08");
    assert.equal(todayInTimeZone("Pacific/Auckland", instant), "2026-03-08");
    assert.equal(todayInTimeZone("America/Los_Angeles", instant), "2026-03-07");
    const lateUtc = new Date("2026-11-01T06:30:00.000Z"); // the repeated hour in New York
    assert.equal(todayInTimeZone("America/New_York", lateUtc), "2026-11-01");
    assert.equal(todayInTimeZone("Asia/Kolkata", new Date("2026-12-31T18:45:00.000Z")), "2027-01-01");
    assert.equal(todayInTimeZone("Pacific/Kiritimati", new Date("2026-12-31T10:30:00.000Z")), "2027-01-01");
    assert.equal(todayInTimeZone("Pacific/Pago_Pago", new Date("2027-01-01T10:30:00.000Z")), "2026-12-31");
  });

  it("time-zone names are validated strictly", () => {
    for (const ok of ["UTC", "America/New_York", "Europe/London", "Asia/Kolkata", "Etc/GMT+5"]) {
      assert.equal(isValidTimeZone(ok), true, ok);
    }
    for (const bad of ["", "Mars/Olympus", "America/New York", "../etc/passwd", "x".repeat(65), "<script>"]) {
      assert.equal(isValidTimeZone(bad), false, bad);
    }
  });
});

describe("supported calendar boundaries (1900-01-01 … 9999-12-31)", () => {
  const isContiguous = (days: string[]) =>
    days.every((d, i) => i === 0 || diffDays(days[i - 1]!, d) === 1) && new Set(days).size === days.length;

  it("the December 9999 month grid ends on 9999-12-31 instead of vanishing", () => {
    const dec = monthRange("9999-12-15");
    assert.equal(dec.from, "9999-11-29");
    assert.equal(dec.to, MAX_DATE);
    assert.equal(dec.days.length, 33, "Mon 29 Nov … Fri 31 Dec");
    assert.equal(dec.days.at(-1), "9999-12-31");
    assert.ok(dec.days.every(isDateOnly), "no year-10000 day");
    assert.ok(isContiguous(dec.days));
  });

  it("the last week is clamped to five days; the first week and January 1900 are whole", () => {
    const last = weekRange("9999-12-31");
    assert.deepEqual(last.days, ["9999-12-27", "9999-12-28", "9999-12-29", "9999-12-30", "9999-12-31"]);
    const first = weekRange("1900-01-03");
    assert.equal(first.from, MIN_DATE, "1900-01-01 is a Monday");
    assert.equal(first.days.length, 7);
    const jan1900 = monthRange("1900-01-20");
    assert.equal(jan1900.from, "1900-01-01");
    assert.equal(jan1900.to, "1900-02-04");
    assert.ok(jan1900.days.every(isDateOnly) && isContiguous(jan1900.days));
  });

  it("navigation stops at both ends and never produces an unsupported anchor", () => {
    assert.equal(shiftPeriod("month", "9999-12-10", 1), null);
    assert.equal(shiftPeriod("month", "9999-12-10", -1), "9999-11-01");
    assert.equal(shiftPeriod("month", "9999-11-30", 1), "9999-12-01");
    assert.equal(shiftPeriod("month", "1900-01-15", -1), null);
    assert.equal(shiftPeriod("month", "1900-01-15", 1), "1900-02-01");
    assert.equal(shiftPeriod("week", "9999-12-31", 1), null);
    assert.equal(shiftPeriod("week", "9999-12-20", 1), "9999-12-27");
    assert.equal(shiftPeriod("week", "1900-01-03", -1), null);
    assert.equal(shiftPeriod("week", "1900-01-10", -1), "1900-01-07");
    assert.equal(addMonths("9999-12-01", 1), null);
    assert.equal(addMonths("1900-01-01", -1), null);
    assert.equal(addMonths("1900-01-01", 12 * 8099 + 11), "9999-12-01");
  });

  it("ranges touching both ends validate; one day beyond either end is rejected", () => {
    assert.deepEqual(validateRange("9999-11-29", "9999-12-31"), { from: "9999-11-29", to: "9999-12-31" });
    assert.deepEqual(validateRange("1900-01-01", "1900-02-04"), { from: "1900-01-01", to: "1900-02-04" });
    assert.throws(() => validateRange("9999-12-31", "10000-01-01"));
    assert.throws(() => validateRange("1899-12-31", "1900-01-01"));
    assert.doesNotThrow(() => parseCalendarRangeQuery(q("from=9999-11-29&to=9999-12-31")));
    assert.throws(() => parseCalendarRangeQuery(q("from=9999-12-01&to=10000-01-01")), CalendarQueryError);
  });
});

describe("stored due date → calendar day (UTC date rule)", () => {
  it("date-only values round-trip unchanged, whatever the storage", () => {
    for (const day of ["2026-10-01", "2028-02-29", "2026-12-31", "2027-01-01"]) {
      assert.equal(calendarDayOf(day), day, "SQLite text");
      assert.equal(calendarDayOf(new Date(day)), day, "PostgreSQL UTC midnight as a Date");
      assert.equal(calendarDayOf(new Date(day).toISOString()), day, "API ISO output");
    }
  });

  it("legacy timestamps use their UTC date; empty and garbage are unscheduled", () => {
    assert.equal(calendarDayOf("2026-10-01T23:30:00-05:00"), "2026-10-02");
    assert.equal(calendarDayOf("2026-10-02T01:00:00+05:00"), "2026-10-01");
    assert.equal(calendarDayOf("2026-10-01T12:00:00.000Z"), "2026-10-01");
    assert.equal(calendarDayOf(null), null);
    assert.equal(calendarDayOf(""), null);
    assert.equal(calendarDayOf("not a date"), null);
  });

  it("the grid, labels and day rule are identical when the process runs in other time zones", () => {
    const script = `
      const d = require(${JSON.stringify(path.resolve("src/core/calendar/dates.ts"))});
      const out = {
        month: d.monthRange("2026-03-15").days.join(","),
        week: d.weekRange("2026-11-01").days.join(","),
        day: d.calendarDayOf(new Date("2026-10-01")),
        label: d.formatDayLabel("2026-10-01", { month: "short", day: "numeric", year: "numeric" }),
      };
      process.stdout.write(JSON.stringify(out));
    `;
    const results = ["UTC", "America/Los_Angeles", "Pacific/Auckland", "Asia/Kolkata", "Europe/London"].map((tz) => {
      const run = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
        env: { ...process.env, TZ: tz, LANG: "en_US.UTF-8" },
        encoding: "utf8",
      });
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(run.stdout) as Record<string, string>;
    });
    for (const r of results) assert.deepEqual(r, results[0]);
    assert.equal(results[0]!.day, "2026-10-01");
    assert.match(results[0]!.label ?? "", /Oct 1, 2026|1 Oct 2026/);
  });
});

describe("strict calendar query parsing", () => {
  it("accepts a valid range with filters", () => {
    assert.deepEqual(
      parseCalendarRangeQuery(q("from=2026-09-28&to=2026-11-08&projectId=prj_1&assignee=me&status=open&kind=tasks&tz=Europe%2FLondon")),
      { from: "2026-09-28", to: "2026-11-08", projectId: "prj_1", assignee: "me", status: "open", kind: "tasks", tz: "Europe/London" },
    );
    assert.equal(parseCalendarRangeQuery(q("from=2026-10-01&to=2026-10-01")).kind, "all");
  });

  it("rejects invalid dates, ranges, zones, values and repeated or unknown parameters", () => {
    const bad = [
      "",
      "from=2026-10-01",
      "from=2026-10-10&to=2026-10-01",
      "from=2026-02-29&to=2026-03-10",
      "from=2026-10-01&to=2026-11-12", // 43 days
      "from=10/01/2026&to=10/31/2026",
      "from=2026-10-01T00:00:00Z&to=2026-10-31",
      "from=2026-10-01&to=2026-10-31&from=2026-09-01",
      "from=2026-10-01&to=2026-10-31&tz=Mars%2FBase",
      "from=2026-10-01&to=2026-10-31&tz=UTC&tz=UTC",
      "from=2026-10-01&to=2026-10-31&status=blocked",
      "from=2026-10-01&to=2026-10-31&kind=notes",
      "from=2026-10-01&to=2026-10-31&projectId=%27%20or%201%3D1",
      "from=2026-10-01&to=2026-10-31&assignee=a%20b",
      "from=2026-10-01&to=2026-10-31&workspaceId=ws_other",
    ];
    for (const s of bad) assert.throws(() => parseCalendarRangeQuery(q(s)), CalendarQueryError, s);
    assert.doesNotThrow(() => parseCalendarRangeQuery(q("from=2026-10-01&to=2026-11-11")), "exactly 42 days is allowed");
  });

  it("unscheduled paging: strict limit and cursor", () => {
    assert.equal(parseUnscheduledQuery(q("")).limit, 25);
    assert.equal(parseUnscheduledQuery(q("limit=50")).limit, 50);
    for (const s of ["limit=0", "limit=51", "limit=1.5", "limit=01", "kind=tasks", "cursor=abc", "limit=5&limit=6"]) {
      assert.throws(() => parseUnscheduledQuery(q(s)), CalendarQueryError, s);
    }
    const cursor = encodeUnscheduledCursor({ createdAt: "2026-09-01T12:00:00.000Z", id: "tsk_abc" });
    assert.deepEqual(decodeUnscheduledCursor(cursor), { createdAt: "2026-09-01T12:00:00.000Z", id: "tsk_abc" });
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    for (const bad of [
      enc({ createdAt: "2026-09-01T12:00:00.000Z" }),
      enc({ createdAt: "yesterday", id: "tsk_abc" }),
      enc({ createdAt: "2026-09-01T12:00:00.000Z", id: "x' or 1=1" }),
      enc({ createdAt: "2026-09-01T12:00:00.000Z", id: "tsk", extra: 1 }),
      "a".repeat(600),
    ]) {
      assert.throws(() => decodeUnscheduledCursor(bad), CalendarQueryError);
    }
    assert.throws(() => validateRange("2026-10-01", "2026-09-30"));
  });
});

describe("filter-option search query", () => {
  it("accepts a bounded name search with an optional strict cursor", () => {
    assert.deepEqual(parseFilterSearchQuery(q("type=projects&q=%20Zeta%20")), { type: "projects", q: "Zeta", limit: 25 });
    assert.deepEqual(parseFilterSearchQuery(q("type=members&limit=50")), { type: "members", q: "", limit: 50 });
    const cursor = encodeFilterSearchCursor({ k: "zeta project 0001", id: "prj_1" });
    assert.deepEqual(parseFilterSearchQuery(q(`type=projects&q=z&cursor=${cursor}`)).cursor, { k: "zeta project 0001", id: "prj_1" });
  });

  it("rejects unknown types, oversize or control-character text, bad limits, bad cursors, repeats and extras", () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    for (const s of [
      "",
      "type=users",
      "type=projects&q=" + "a".repeat(101),
      "type=projects&q=a%00b",
      "type=projects&q=a%0Ab",
      "type=projects&limit=0",
      "type=projects&limit=51",
      "type=projects&limit=5.5",
      "type=projects&q=a&q=b",
      "type=projects&type=members",
      "type=projects&workspaceId=ws_other",
      "type=members&status=suspended",
      "type=projects&cursor=bogus",
      `type=projects&cursor=${enc({ k: "a" })}`,
      `type=projects&cursor=${enc({ k: "a", id: "x' or 1=1" })}`,
      `type=projects&cursor=${enc({ k: "a".repeat(401), id: "prj_1" })}`,
      `type=projects&cursor=${enc({ k: "a", id: "prj_1", extra: true })}`,
    ]) {
      assert.throws(() => parseFilterSearchQuery(q(s)), CalendarQueryError, s);
    }
  });

  it("matches LIKE wildcards literally", () => {
    assert.equal(likePattern("Zeta"), "%zeta%");
    assert.equal(likePattern("50%_off\\"), "%50\\%\\_off\\\\%");
  });
});
