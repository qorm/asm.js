// asm.js Runtime - Node.js console
// Provides console object for asm.js compiled binaries

import { syscallWrite } from "./_string.js";
import { getSyscall } from "./constants.js";

function formatValue(val) {
    if (val === undefined) return "undefined";
    if (val === null) return "null";
    if (typeof val === "function") {
        const name = val.name || "anonymous";
        return `[Function: ${name}]`;
    }
    if (typeof val === "object") {
        try {
            return JSON.stringify(val);
        } catch (e) {
            if (Array.isArray(val)) {
                return `[Array(${val.length})]`;
            }
            return "[Object]";
        }
    }
    return String(val);
}

function consoleLog(...args) {
    const str = args.map(formatValue).join(" ") + "\n";
    syscallWrite(1, str, getSyscall);
}

function consoleError(...args) {
    const str = "[ERROR] " + args.map(formatValue).join(" ") + "\n";
    syscallWrite(2, str, getSyscall);
}

function consoleWarn(...args) {
    const str = "[WARN] " + args.map(formatValue).join(" ") + "\n";
    syscallWrite(2, str, getSyscall);
}

function consoleInfo(...args) { consoleLog(...args); }
function consoleDebug(...args) { consoleLog(...args); }

function consoleTrace(...args) {
    const str = "Trace: " + args.map(formatValue).join(" ") + "\n";
    syscallWrite(2, str, getSyscall);
}

function consoleTime(label) {}
function consoleTimeEnd(label) {}
function consoleTimeLog(label, ...args) {
    const str = label + ": " + args.map(formatValue).join(" ") + "\n";
    syscallWrite(1, str, getSyscall);
}

function consoleAssert(condition, ...args) {
    if (!condition) {
        const str = "AssertionError: " + args.map(formatValue).join(" ") + "\n";
        syscallWrite(2, str, getSyscall);
    }
}

function consoleClear() {}
function consoleCount(label) { return 0; }
function consoleCountReset(label) {}
function consoleGroup(...label) {}
function consoleGroupEnd() {}
function consoleGroupIndent() {}

const console = {
    log: consoleLog,
    error: consoleError,
    warn: consoleWarn,
    info: consoleInfo,
    debug: consoleDebug,
    trace: consoleTrace,
    time: consoleTime,
    timeEnd: consoleTimeEnd,
    timeLog: consoleTimeLog,
    assert: consoleAssert,
    clear: consoleClear,
    count: consoleCount,
    countReset: consoleCountReset,
    group: consoleGroup,
    groupEnd: consoleGroupEnd,
    groupIndent: consoleGroupIndent,
    dir: (obj) => consoleLog(JSON.stringify(obj)),
    dirxml: (obj) => consoleLog(JSON.stringify(obj)),
    table: (data) => consoleLog(JSON.stringify(data)),
    profile: () => {},
    profileEnd: () => {},
    timeBegin: consoleTime,
    memory: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 })
};

export { console };
export default console;
