const assert = require("node:assert/strict");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { scheduleMinute } = require("../app/schedule-clock");

test("named schedule clocks follow weekdays, fractional offsets and daylight-saving transitions", () => {
    const cases = [
        ["UTC", "2024-01-07T23:30:00Z", 10050],
        ["UTC", "2024-01-08T00:30:00Z", 30],
        ["Europe/Bucharest", "2024-01-07T23:30:00Z", 90],
        ["Europe/Bucharest", "2024-07-01T00:30:00Z", 210],
        ["Europe/Bucharest", "2024-03-31T00:59:00Z", 8819],
        ["Europe/Bucharest", "2024-03-31T01:00:00Z", 8880],
        ["Europe/Bucharest", "2024-10-27T00:59:00Z", 8879],
        ["Europe/Bucharest", "2024-10-27T01:00:00Z", 8820],
        ["America/New_York", "2024-01-08T00:30:00Z", 9810],
        ["Asia/Kathmandu", "2024-01-08T00:00:00Z", 345],
    ];
    for (const [timezone, date, expected] of cases) {
        assert.equal(scheduleMinute(timezone, new Date(date)), expected, `${timezone}: ${date}`);
    }
});

test("the schedule clock CLI prints only a valid minute and rejects invalid timezones", () => {
    const script = path.join(__dirname, "../app/schedule-clock.js");
    for (const args of [["Europe/Bucharest"], ["Invalid/Timezone"], []]) {
        const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true, timeout: 5000 });
        assert.ifError(result.error);
        if (args[0] === "Europe/Bucharest") {
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /^\d+\n$/);
            assert.ok(Number(result.stdout) >= 0 && Number(result.stdout) < 10080);
            assert.equal(result.stderr, "");
        } else {
            assert.equal(result.status, 1);
            assert.equal(result.stdout, "");
            assert.match(result.stderr, /^Schedule clock error:/);
            assert.doesNotMatch(result.stderr, /\n\s+at /);
        }
    }
});
