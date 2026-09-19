const assert = require("node:assert/strict");
const test = require("node:test");
const { DAYS, normaliseSchedule, scheduleRanges } = require("../app/playlist-schedule");

const weekdays = { days: DAYS.slice(0, 5), start: "09:00", end: "21:00" };

test("omitted and empty schedules preserve regular playlists", () => {
    assert.deepEqual(normaliseSchedule(), []);
    assert.deepEqual(scheduleRanges([]), []);
});

test("weekday windows include the start and exclude the end on each selected day", () => {
    const ranges = scheduleRanges([weekdays]);
    assert.deepEqual(ranges, [0, 1, 2, 3, 4].map((day) => ({ start: day * 1440 + 540, end: day * 1440 + 1260 })));
    const active = (minute) => ranges.some((range) => minute >= range.start && minute < range.end);
    for (let day = 0; day < 7; day += 1) {
        for (const [minute, expected] of [[539, false], [540, day < 5], [1259, day < 5], [1260, false]]) {
            assert.equal(active(day * 1440 + minute), expected, `${DAYS[day]} at minute ${minute}`);
        }
    }
});

test("days without times cover the full selected days without changing the input", () => {
    const schedule = [{ days: ["friday", "sunday"] }];
    const before = structuredClone(schedule);
    assert.deepEqual(normaliseSchedule(schedule), [{ days: ["friday", "sunday"], start: "00:00", end: "24:00" }]);
    assert.deepEqual(scheduleRanges(schedule), [{ start: 5760, end: 7200 }, { start: 8640, end: 10080 }]);
    assert.deepEqual(schedule, before);
    assert.deepEqual(scheduleRanges([{ days: DAYS }]), [{ start: 0, end: 10080 }]);
    assert.deepEqual(scheduleRanges([{ days: ["monday"] }, { days: ["friday"], start: "12:00", end: "13:00" }]), [
        { start: 0, end: 1440 }, { start: 6480, end: 6540 },
    ]);
});

test("consecutive Friday playlists change eligibility at 13:00 and stop at midnight", () => {
    const first = scheduleRanges([{ days: ["friday"], start: "12:00", end: "13:00" }]);
    const second = scheduleRanges([{ days: ["friday"], start: "13:00", end: "24:00" }]);
    const active = (ranges, minute) => ranges.some((range) => minute >= range.start && minute < range.end);
    for (const [minute, firstActive, secondActive] of [
        [6479, false, false], [6480, true, false], [6539, true, false],
        [6540, false, true], [7199, false, true], [7200, false, false],
    ]) {
        assert.equal(active(first, minute), firstActive, `First playlist at ${minute}`);
        assert.equal(active(second, minute), secondActive, `Second playlist at ${minute}`);
    }
});

test("one day, multiple disjoint days and separate weekend hours are supported", () => {
    assert.deepEqual(scheduleRanges([{ days: ["friday"], start: "09:00", end: "21:00" }]), [{ start: 6300, end: 7020 }]);
    const ranges = scheduleRanges([
        { days: ["monday", "wednesday"], start: "09:00", end: "12:00" },
        { days: ["saturday", "sunday"], start: "15:00", end: "18:00" },
    ]);
    assert.deepEqual(ranges, [
        { start: 540, end: 720 }, { start: 3420, end: 3600 },
        { start: 8100, end: 8280 }, { start: 9540, end: 9720 },
    ]);
});

test("overnight windows extend from the named day, including Sunday into Monday", () => {
    assert.deepEqual(scheduleRanges([{ days: ["friday"], start: "22:00", end: "02:00" }]), [{ start: 7080, end: 7320 }]);
    assert.deepEqual(scheduleRanges([{ days: ["sunday"], start: "22:00", end: "02:00" }]), [
        { start: 0, end: 120 }, { start: 9960, end: 10080 },
    ]);
    assert.deepEqual(scheduleRanges([{ days: ["sunday"], start: "22:00", end: "00:00" }]), [{ start: 9960, end: 10080 }]);
});

test("full days, overlapping windows and adjacent windows are merged without mutating config", () => {
    const windows = [
        { days: ["monday"], start: "09:00", end: "12:00" },
        { days: ["monday"], start: "11:00", end: "14:00" },
        { days: ["monday"], start: "14:00", end: "16:00" },
    ];
    const before = structuredClone(windows);
    assert.deepEqual(scheduleRanges(windows), [{ start: 540, end: 960 }]);
    assert.deepEqual(windows, before);
    assert.deepEqual(scheduleRanges([{ days: DAYS, start: "00:00", end: "24:00" }]), [{ start: 0, end: 10080 }]);
    const normalised = normaliseSchedule(windows);
    normalised[0].days.push("friday");
    assert.deepEqual(windows, before);
});

for (const [description, value, message] of [
    ["null", null, /JSON array/],
    ["object instead of array", {}, /JSON array/],
    ["null window", [null], /JSON object/],
    ["array window", [[]], /JSON object/],
    ["unknown field", [{ ...weekdays, timezone: "UTC" }], /Unknown.*timezone/],
    ["missing days", [{ start: "09:00", end: "21:00" }], /non-empty array/],
    ["empty days", [{ ...weekdays, days: [] }], /non-empty array/],
    ["range string", [{ ...weekdays, days: "monday-friday" }], /non-empty array/],
    ["unknown day", [{ ...weekdays, days: ["monday", "frday"] }], /only: monday/],
    ["capitalised day", [{ ...weekdays, days: ["Monday"] }], /only: monday/],
    ["numeric day", [{ ...weekdays, days: [1] }], /only: monday/],
    ["duplicate day", [{ ...weekdays, days: ["monday", "monday"] }], /duplicate/],
    ["missing start", [{ days: ["monday"], end: "21:00" }], /both start and end/],
    ["missing end", [{ days: ["monday"], start: "09:00" }], /both start and end/],
    ["null times", [{ days: ["monday"], start: null, end: null }], /start.*HH:MM/],
    ["empty times", [{ days: ["monday"], start: "", end: "" }], /start.*HH:MM/],
    ["short hour", [{ ...weekdays, start: "9:00" }], /HH:MM/],
    ["seconds", [{ ...weekdays, start: "09:00:00" }], /HH:MM/],
    ["numeric time", [{ ...weekdays, start: 900 }], /HH:MM/],
    ["invalid minutes", [{ ...weekdays, end: "21:60" }], /HH:MM/],
    ["invalid hour", [{ ...weekdays, end: "25:00" }], /HH:MM/],
    ["24:00 start", [{ ...weekdays, start: "24:00" }], /HH:MM/],
    ["invalid end of day", [{ ...weekdays, end: "24:01" }], /HH:MM/],
    ["identical times", [{ ...weekdays, end: "09:00" }], /must differ/],
]) {
    test(`rejects invalid schedule: ${description}`, () => {
        assert.throws(() => scheduleRanges(value, "playlists[1].schedule"), message);
    });
}
