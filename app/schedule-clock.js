const { DAYS } = require("./playlist-schedule");

function scheduleMinute(timezone, date = new Date()) {
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    return DAYS.indexOf(parts.weekday.toLowerCase()) * 1440 + Number(parts.hour) * 60 + Number(parts.minute);
}

// Liquidsoap uses this clock on Windows for named schedule timezones
if (require.main === module) {
    try {
        if (!process.argv[2]) throw new Error("A schedule timezone is required.");
        process.stdout.write(`${scheduleMinute(process.argv[2])}\n`);
    } catch (error) {
        console.error(`Schedule clock error: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { scheduleMinute };
