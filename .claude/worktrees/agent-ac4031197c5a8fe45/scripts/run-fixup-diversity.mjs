#!/usr/bin/env node

import { chmodSync, existsSync, mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const fixtureArg = process.argv[2] || "tests/fixtures/es/json-global/main.js";
const fixturePath = path.isAbsolute(fixtureArg) ? fixtureArg : path.join(repoRoot, fixtureArg);

const BRANCH_RE = /\b(?:b|bl|b\.[a-z]+|cbz|cbnz)\s+0x([0-9a-f]+)/i;
const ADRP_RE = /\badrp\s+x([0-9]+),/i;
const ADRP_ADD_RE = /\badd\s+x([0-9]+),\s*x([0-9]+),\s+#0x([0-9a-f]+)/i;
const CHAIN_TIMEOUT_MS = Number(process.env.ASMJS_FIXUP_CHAIN_TIMEOUT_MS || 120000);

function runStep(command, args, options = {}) {
    return spawnSync(command, args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: process.env,
        maxBuffer: 64 * 1024 * 1024,
        ...options,
    });
}

function ensureExecutable(filePath) {
    try {
        chmodSync(filePath, 0o755);
    } catch {}
}

function formatFailure(label, result) {
    const lines = [`${label} failed`];
    if (typeof result.status === "number") lines.push(`exit=${result.status}`);
    if (result.signal) lines.push(`signal=${result.signal}`);
    if (result.error) lines.push(`error=${result.error.message}`);
    if (result.stderr) lines.push(`stderr:\n${result.stderr.trimEnd()}`);
    if (result.stdout) lines.push(`stdout:\n${result.stdout.trimEnd()}`);
    return lines.join("\n");
}

function runWithTimeout(command, args, timeoutMs, options = {}) {
    const started = Date.now();
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: process.env,
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        ...options,
    });
    const elapsedMs = Date.now() - started;
    const timedOut = !!result.error && result.error.code === "ETIMEDOUT";
    return { ...result, timedOut, elapsedMs };
}

function parseBranchStats(disasm) {
    const targetCounts = Object.create(null);
    const targets = [];
    let branchCount = 0;

    const lines = String(disasm || "").split("\n");
    for (const line of lines) {
        const match = line.match(BRANCH_RE);
        if (!match) continue;
        branchCount += 1;
        const target = "0x" + match[1].toLowerCase();
        if (targetCounts[target] === undefined) {
            targetCounts[target] = 1;
            targets.push(target);
        } else {
            targetCounts[target] += 1;
        }
    }

    let topTarget = "";
    let topCount = 0;
    for (const target of targets) {
        const count = targetCounts[target];
        if (count > topCount) {
            topCount = count;
            topTarget = target;
        }
    }

    const uniqueTargetCount = targets.length;
    const topShare = branchCount > 0 ? topCount / branchCount : 0;
    return {
        branchCount,
        uniqueTargetCount,
        topTarget,
        topCount,
        topShare,
    };
}

function printStats(label, stats) {
    console.log(
        `${label}: branches=${stats.branchCount} uniqueTargets=${stats.uniqueTargetCount} ` +
        `topTarget=${stats.topTarget || "-"} topCount=${stats.topCount} topShare=${stats.topShare.toFixed(4)}`
    );
}

function parseAdrpAddStats(disasm) {
    const offsetCounts = Object.create(null);
    const offsets = [];
    let pairCount = 0;
    let pendingReg = "";
    let pendingWindow = 0;

    const lines = String(disasm || "").split("\n");
    for (const line of lines) {
        const adrpMatch = line.match(ADRP_RE);
        if (adrpMatch) {
            pendingReg = adrpMatch[1];
            pendingWindow = 2;
            continue;
        }

        if (pendingWindow > 0 && pendingReg !== "") {
            const addMatch = line.match(ADRP_ADD_RE);
            if (addMatch && addMatch[1] === pendingReg && addMatch[2] === pendingReg) {
                pairCount += 1;
                const offset = "0x" + addMatch[3].toLowerCase();
                if (offsetCounts[offset] === undefined) {
                    offsetCounts[offset] = 1;
                    offsets.push(offset);
                } else {
                    offsetCounts[offset] += 1;
                }
                pendingReg = "";
                pendingWindow = 0;
                continue;
            }

            pendingWindow -= 1;
            if (pendingWindow < 1) {
                pendingReg = "";
            }
        }
    }

    let topOffset = "";
    let topCount = 0;
    for (const offset of offsets) {
        const count = offsetCounts[offset];
        if (count > topCount) {
            topCount = count;
            topOffset = offset;
        }
    }

    const uniqueOffsetCount = offsets.length;
    const topShare = pairCount > 0 ? topCount / pairCount : 0;
    return {
        pairCount,
        uniqueOffsetCount,
        topOffset,
        topCount,
        topShare,
        offsetCounts,
    };
}

function printAdrpAddStats(label, stats) {
    console.log(
        `${label}: pairs=${stats.pairCount} uniqueOffsets=${stats.uniqueOffsetCount} ` +
        `topOffset=${stats.topOffset || "-"} topCount=${stats.topCount} topShare=${stats.topShare.toFixed(4)}`
    );
}

function isCollapsed(hostStats, gen1Stats) {
    if (hostStats.branchCount < 1 || gen1Stats.branchCount < 1) return false;
    const uniqueRatio = hostStats.uniqueTargetCount > 0
        ? gen1Stats.uniqueTargetCount / hostStats.uniqueTargetCount
        : 1;
    if (hostStats.uniqueTargetCount >= 64 && gen1Stats.uniqueTargetCount <= 8) {
        return true;
    }
    if (uniqueRatio < 0.2 && gen1Stats.topShare > 0.08) {
        return true;
    }
    if (gen1Stats.topShare > 0.2 && gen1Stats.branchCount > 200) {
        return true;
    }
    return false;
}

function isAdrpAddCollapsed(hostStats, gen1Stats) {
    if (hostStats.pairCount < 1 || gen1Stats.pairCount < 1) return false;
    const uniqueRatio = hostStats.uniqueOffsetCount > 0
        ? gen1Stats.uniqueOffsetCount / hostStats.uniqueOffsetCount
        : 1;

    const hostCollapsedOffsetCount = hostStats.offsetCounts["0x6fe"] || 0;
    if (
        gen1Stats.topOffset === "0x6fe" &&
        gen1Stats.topCount >= 16 &&
        gen1Stats.topShare > 0.06 &&
        hostCollapsedOffsetCount < 2
    ) {
        return true;
    }

    if (hostStats.uniqueOffsetCount >= 64 && gen1Stats.uniqueOffsetCount <= 12) {
        return true;
    }
    if (uniqueRatio < 0.4 && gen1Stats.topShare > 0.12) {
        return true;
    }
    if (gen1Stats.topShare > 0.25 && gen1Stats.pairCount > 120) {
        return true;
    }
    return false;
}

const workDir = mkdtempSync(path.join(os.tmpdir(), "asmjs-fixup-diversity-"));
let success = false;

try {
    const hostCli = path.join(repoRoot, "cli.js");
    const gen1Compiler = path.join(workDir, "asmjs-gen1");
    const hostBin = path.join(workDir, "host-fixture-bin");
    const gen1Bin = path.join(workDir, "gen1-fixture-bin");

    const hostBuild = runStep(process.execPath, [hostCli, hostCli, "-o", gen1Compiler]);
    if (hostBuild.status !== 0 || !existsSync(gen1Compiler)) {
        throw new Error(formatFailure("host->gen1 build", hostBuild));
    }
    ensureExecutable(gen1Compiler);
    console.log("PASS build host->gen1");

    const hostCompile = runStep(process.execPath, [hostCli, fixturePath, "-o", hostBin]);
    if (hostCompile.status !== 0 || !existsSync(hostBin)) {
        throw new Error(formatFailure("host compile fixture", hostCompile));
    }
    ensureExecutable(hostBin);
    console.log("PASS compile fixture with host");

    const gen1Compile = runWithTimeout(gen1Compiler, [fixturePath, "-o", gen1Bin], CHAIN_TIMEOUT_MS);
    if (gen1Compile.timedOut) {
        throw new Error(
            `gen1 compile fixture timed out (${CHAIN_TIMEOUT_MS}ms)\n` +
            formatFailure("gen1 compile fixture", gen1Compile)
        );
    }
    if (gen1Compile.status !== 0 || !existsSync(gen1Bin)) {
        throw new Error(formatFailure("gen1 compile fixture", gen1Compile));
    }
    ensureExecutable(gen1Bin);
    console.log(`PASS compile fixture with gen1 (${gen1Compile.elapsedMs}ms)`);

    const hostDisasm = runStep("otool", ["-tvV", hostBin]);
    if (hostDisasm.status !== 0) {
        throw new Error(formatFailure("otool host", hostDisasm));
    }
    const gen1Disasm = runStep("otool", ["-tvV", gen1Bin]);
    if (gen1Disasm.status !== 0) {
        throw new Error(formatFailure("otool gen1", gen1Disasm));
    }

    const hostStats = parseBranchStats(hostDisasm.stdout);
    const gen1Stats = parseBranchStats(gen1Disasm.stdout);
    printStats("host", hostStats);
    printStats("gen1", gen1Stats);

    const uniqueRatio = hostStats.uniqueTargetCount > 0
        ? gen1Stats.uniqueTargetCount / hostStats.uniqueTargetCount
        : 1;
    console.log(`uniqueRatio(gen1/host)=${uniqueRatio.toFixed(4)}`);

    const hostAdrpAddStats = parseAdrpAddStats(hostDisasm.stdout);
    const gen1AdrpAddStats = parseAdrpAddStats(gen1Disasm.stdout);
    printAdrpAddStats("host_adrp_add", hostAdrpAddStats);
    printAdrpAddStats("gen1_adrp_add", gen1AdrpAddStats);
    const adrpAddUniqueRatio = hostAdrpAddStats.uniqueOffsetCount > 0
        ? gen1AdrpAddStats.uniqueOffsetCount / hostAdrpAddStats.uniqueOffsetCount
        : 1;
    console.log(`adrpAddUniqueRatio(gen1/host)=${adrpAddUniqueRatio.toFixed(4)}`);

    if (isCollapsed(hostStats, gen1Stats)) {
        throw new Error(
            "FAIL branch-target diversity collapsed in gen1 output " +
            `(host unique=${hostStats.uniqueTargetCount}, gen1 unique=${gen1Stats.uniqueTargetCount}, ` +
            `gen1 topShare=${gen1Stats.topShare.toFixed(4)})`
        );
    }

    if (isAdrpAddCollapsed(hostAdrpAddStats, gen1AdrpAddStats)) {
        throw new Error(
            "FAIL adrp/add data-target diversity collapsed in gen1 output " +
            `(host unique=${hostAdrpAddStats.uniqueOffsetCount}, gen1 unique=${gen1AdrpAddStats.uniqueOffsetCount}, ` +
            `gen1 topOffset=${gen1AdrpAddStats.topOffset || "-"}, gen1 topShare=${gen1AdrpAddStats.topShare.toFixed(4)})`
        );
    }

    success = true;
    console.log("PASS fixup-diversity gate");
} catch (error) {
    console.error(String(error && error.message ? error.message : error));
    process.exitCode = 1;
} finally {
    if (success) {
        rmSync(workDir, { recursive: true, force: true });
    } else {
        console.error(`Artifacts kept at: ${workDir}`);
    }
}
