function formatHelpRows(rows) {
    const width = Math.max(32, ...rows.map(([command]) => command.length));
    return rows.map(([command, description]) => `  ${command.padEnd(width)}  ${description}`).join("\n");
}

module.exports = { formatHelpRows };
