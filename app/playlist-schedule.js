const { assertKnownKeys } = require("./config-validation");

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

function parseTime(value, label, allowEndOfDay = false) {
    if (allowEndOfDay && value === "24:00") return MINUTES_PER_DAY;
    if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        throw new Error(`${label} must use HH:MM (00:00-23:59${allowEndOfDay ? ", or 24:00 for the end of a day" : ""}).`);
    }
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
}

function normaliseSchedule(value, label = "schedule") {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array.`);
    return value.map((window, index) => {
        const entryLabel = `${label}[${index}]`;
        if (window === null || typeof window !== "object" || Array.isArray(window)) {
            throw new Error(`${entryLabel} must be a JSON object.`);
        }
        assertKnownKeys(window, ["days", "start", "end"], entryLabel);
        if (!Array.isArray(window.days) || window.days.length === 0) {
            throw new Error(`${entryLabel}.days must be a non-empty array of weekday names.`);
        }
        for (const day of window.days) {
            if (!DAYS.includes(day)) {
                throw new Error(`${entryLabel}.days must contain only: ${DAYS.join(", ")}.`);
            }
        }
        if (new Set(window.days).size !== window.days.length) {
            throw new Error(`${entryLabel}.days must not contain duplicate days.`);
        }
        const hasStart = window.start !== undefined;
        const hasEnd = window.end !== undefined;
        if (hasStart !== hasEnd) {
            throw new Error(`${entryLabel} must specify both start and end, or omit both for a full day.`);
        }
        const startTime = hasStart ? window.start : "00:00";
        const endTime = hasEnd ? window.end : "24:00";
        const start = parseTime(startTime, `${entryLabel}.start`);
        const end = parseTime(endTime, `${entryLabel}.end`, true);
        if (start === end) {
            throw new Error(`${entryLabel}.start and end must differ; use 00:00-24:00 for a full day.`);
        }
        return { days: [...window.days], start: startTime, end: endTime };
    });
}

// Half-open weekly ranges, Monday 00:00 = 0. Split Sunday overnight at the week boundary.
function scheduleRanges(value, label = "schedule") {
    const ranges = [];
    for (const window of normaliseSchedule(value, label)) {
        const start = parseTime(window.start, `${label}.start`);
        let end = parseTime(window.end, `${label}.end`, true);
        if (end < start) end += MINUTES_PER_DAY;
        for (const day of window.days) {
            const offset = DAYS.indexOf(day) * MINUTES_PER_DAY;
            ranges.push({ start: offset + start, end: Math.min(offset + end, MINUTES_PER_WEEK) });
            if (offset + end > MINUTES_PER_WEEK) {
                ranges.push({ start: 0, end: offset + end - MINUTES_PER_WEEK });
            }
        }
    }
    ranges.sort((left, right) => left.start - right.start);
    const merged = [];
    for (const range of ranges) {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
        else merged.push({ ...range });
    }
    return merged;
}

module.exports = { DAYS, normaliseSchedule, scheduleRanges };
