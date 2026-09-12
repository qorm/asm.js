#!/usr/bin/env node
// P0.7 gate: toolchain sources must not contain real regex literals.
//
// Why: isToolchainSourcePath skips __regexp_shim injection. A real /re/.test
// or /re/.exec in compiler/lang/asm/backend/vm/binary therefore compiles to
// an unresolved __RE_* free identifier. gen1 (self-hosted) then throws
// ReferenceError on every compile — including trivial programs.
//
// Scanner is conservative: skips strings/templates/comments; flags `/…/flags`
// that looks like a regex start (not division, not // or /*).
// Run: node tests/toolchain_no_regex.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOTS = ["compiler", "lang", "asm", "backend", "vm", "binary", "engine"];
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__"]);

function walk(dir, out) {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
        if (SKIP_DIRS.has(name)) continue;
        const p = join(dir, name);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p, out);
        else if (name.endsWith(".js") || name.endsWith(".mjs")) out.push(p);
    }
}

function isIdentPart(c) {
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) || c === 95 || c === 36;
}

// Find candidate regex literals. Returns [{line, snippet}].
function findRegexLiterals(src, fileLabel) {
    const hits = [];
    const n = src.length;
    let i = 0;
    let line = 1;
    let prevSignificant = -1; // charCode of last non-ws code char, or -1

    // shebang: #!/usr/bin/... is not a regex
    if (n >= 2 && src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) {
        while (i < n && src.charCodeAt(i) !== 10) i++;
    }

    const pushHit = (start, end) => {
        const text = src.slice(start, Math.min(end, start + 80));
        hits.push({ file: fileLabel, line, snippet: text.replace(/\n/g, " ") });
    };

    while (i < n) {
        const c = src.charCodeAt(i);
        if (c === 10) { line++; i++; continue; }
        if (c === 32 || c === 9 || c === 13) { i++; continue; }

        // comments
        if (c === 47 && i + 1 < n) {
            const c2 = src.charCodeAt(i + 1);
            if (c2 === 47) {
                while (i < n && src.charCodeAt(i) !== 10) i++;
                continue;
            }
            if (c2 === 42) {
                i += 2;
                while (i + 1 < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) {
                    if (src.charCodeAt(i) === 10) line++;
                    i++;
                }
                i += 2;
                continue;
            }
        }
        // strings
        if (c === 39 || c === 34 || c === 96) {
            const q = c;
            i++;
            while (i < n) {
                const d = src.charCodeAt(i);
                if (d === 92) { i += 2; continue; }
                if (d === q) break;
                if (q !== 96 && d === 10) break;
                if (d === 10) line++;
                i++;
            }
            i++;
            prevSignificant = q;
            continue;
        }
        // potential regex
        if (c === 47) {
            const afterIdent = prevSignificant >= 0 && isIdentPart(prevSignificant);
            const afterClose = prevSignificant === 41 || prevSignificant === 93 || prevSignificant === 125;
            // identifiers/) ] } after → division; operators/`(`/`,`/`=`/start → regex candidate
            if (!afterIdent && !afterClose) {
                // skip empty //
                if (i + 1 < n && src.charCodeAt(i + 1) === 47) { /* handled above */ }
                else {
                    let j = i + 1;
                    let inClass = false;
                    let body = false;
                    let ok = false;
                    while (j < n) {
                        const d = src.charCodeAt(j);
                        if (d === 10) break;
                        if (d === 92) { j += 2; body = true; continue; }
                        if (d === 91) inClass = true;
                        else if (d === 93) inClass = false;
                        else if (d === 47 && !inClass) { ok = body; break; }
                        body = true;
                        j++;
                    }
                    if (ok) {
                        let k = j + 1;
                        while (k < n) {
                            const f = src.charCodeAt(k);
                            if ((f >= 97 && f <= 122) || (f >= 65 && f <= 90)) k++;
                            else break;
                        }
                        pushHit(i, k);
                        i = k;
                        prevSignificant = 47;
                        continue;
                    }
                }
            }
            prevSignificant = 47;
            i++;
            continue;
        }
        prevSignificant = c;
        i++;
    }
    return hits;
}

const files = [];
for (const r of ROOTS) walk(join(repoRoot, r), files);
files.push(join(repoRoot, "cli.js"));

const all = [];
for (const f of files) {
    const src = readFileSync(f, "utf16le"); // will re-read as utf8
}
// re-read properly
all.length = 0;
for (const f of files) {
    const src = readFileSync(f, "utf8");
    const rel = f.slice(repoRoot.length + 1);
    for (const h of findRegexLiterals(src, rel)) all.push(h);
}

if (all.length === 0) {
    console.log("toolchain_no_regex: OK (" + files.length + " files, 0 regex literals)");
    process.exit(0);
}
console.error("toolchain_no_regex: FOUND " + all.length + " regex literal(s) in toolchain sources:");
for (const h of all) {
    console.error("  " + h.file + ":" + h.line + ": " + h.snippet);
}
console.error("Replace with hand-written scanners; toolchain paths skip __regexp_shim injection.");
process.exit(1);
