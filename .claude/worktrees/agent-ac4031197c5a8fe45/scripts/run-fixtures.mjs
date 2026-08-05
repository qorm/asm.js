#!/usr/bin/env node

import { readFileSync, readdirSync, existsSync, mkdirSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const fixturesRoot = path.join(repoRoot, "tests", "fixtures");

function parseArgs(argv) {
    const options = {
        suites: [],
        fixtureFilter: "",
        verbose: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--suite") {
            i++;
            if (!argv[i]) {
                throw new Error("--suite requires a value");
            }
            options.suites.push(argv[i]);
        } else if (arg === "--fixture") {
            i++;
            if (!argv[i]) {
                throw new Error("--fixture requires a value");
            }
            options.fixtureFilter = argv[i];
        } else if (arg === "--verbose") {
            options.verbose = true;
        } else if (arg === "-h" || arg === "--help") {
            printHelp();
            process.exit(0);
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }

    return options;
}

function printHelp() {
    console.log(`asm.js fixture runner

Usage:
  node --no-warnings scripts/run-fixtures.mjs [options]

Options:
  --suite <name>      Only run one suite (modules, es, node). Repeatable.
  --fixture <text>    Only run fixtures whose relative path includes <text>.
  --verbose           Show compiler output and per-fixture details.
  -h, --help          Show this help
`);
}

function detectHostTarget() {
    const osMap = {
        darwin: "macos",
        linux: "linux",
        win32: "windows",
    };
    const archMap = {
        arm64: "arm64",
        x64: "x64",
    };

    const hostOs = osMap[process.platform];
    const hostArch = archMap[process.arch];

    if (!hostOs || !hostArch) {
        throw new Error(`Unsupported host platform for fixture runner: ${process.platform}-${process.arch}`);
    }

    return `${hostOs}-${hostArch}`;
}

function normalizeText(value) {
    return String(value ?? "").replace(/\r\n/g, "\n").trimEnd();
}

async function withQuietConsole(verbose, fn) {
    if (verbose) {
        return await fn();
    }

    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = () => {};

    try {
        return await fn();
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
}

function discoverFixtures(rootDir) {
    const fixtures = [];

    function walk(currentDir) {
        const entries = readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
                continue;
            }

            if (entry.isFile() && entry.name === "fixture.json") {
                const fixtureDir = path.dirname(fullPath);
                const relativeDir = path.relative(rootDir, fixtureDir).split(path.sep).join("/");
                const manifest = JSON.parse(readFileSync(fullPath, "utf8"));
                const suite = relativeDir.split("/")[0] || "misc";
                fixtures.push({
                    dir: fixtureDir,
                    manifestPath: fullPath,
                    relativeDir,
                    suite,
                    manifest,
                });
            }
        }
    }

    walk(rootDir);
    fixtures.sort((a, b) => a.relativeDir.localeCompare(b.relativeDir));
    return fixtures;
}

function normalizeExpectation(manifest) {
    const expect = manifest.expect || {};
    const parseExpected = Object.prototype.hasOwnProperty.call(expect, "parse") ? expect.parse : true;
    const compileExpected = Object.prototype.hasOwnProperty.call(expect, "compile") ? expect.compile : parseExpected;
    const runExpected = Object.prototype.hasOwnProperty.call(expect, "run") ? expect.run : compileExpected;

    return {
        parse: parseExpected,
        compile: compileExpected,
        run: runExpected,
        stdout: Object.prototype.hasOwnProperty.call(expect, "stdout") ? normalizeText(expect.stdout) : undefined,
        stderr: Object.prototype.hasOwnProperty.call(expect, "stderr") ? normalizeText(expect.stderr) : undefined,
        exitCode: Object.prototype.hasOwnProperty.call(expect, "exitCode")
            ? expect.exitCode
            : (runExpected ? 0 : undefined),
        timeoutMs: manifest.timeoutMs || 5000,
    };
}

function normalizeFixtureEnv(env) {
    if (!env || typeof env !== "object") {
        return undefined;
    }

    const normalized = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || value === null) {
            continue;
        }
        normalized[key] = String(value);
    }

    return normalized;
}

function shouldAttemptRuntime(expected) {
    return expected.run === true ||
        expected.stdout !== undefined ||
        expected.stderr !== undefined ||
        expected.exitCode !== undefined;
}

function formatStatus(status) {
    switch (status) {
        case "pass":
            return "PASS";
        case "fail":
            return "FAIL";
        case "xfail":
            return "XFAIL";
        case "xpass":
            return "XPASS";
        default:
            return status.toUpperCase();
    }
}

function describeOutcome(actual) {
    const parts = [];
    parts.push(`parse=${actual.parseSuccess ? "ok" : "fail"}`);
    parts.push(`compile=${actual.compileSuccess ? "ok" : "fail"}`);
    if (actual.runCompleted) {
        parts.push(`run=ok(exit=${actual.exitCode})`);
    } else if (actual.runTimedOut) {
        parts.push("run=timeout");
    } else {
        parts.push("run=skipped");
    }
    return parts.join(", ");
}

function formatDetailBlock(title, text) {
    if (!text) return "";
    return `${title}:\n${text}\n`;
}

function evaluateFixture(actual, expected, manifest) {
    const mismatches = [];

    if (actual.parseSuccess !== expected.parse) {
        mismatches.push(`expected parse=${expected.parse}, got ${actual.parseSuccess}`);
    }

    if (actual.compileSuccess !== expected.compile) {
        mismatches.push(`expected compile=${expected.compile}, got ${actual.compileSuccess}`);
    }

    if (expected.run === true) {
        if (!actual.runCompleted || actual.runTimedOut) {
            mismatches.push("expected runtime execution to complete");
        }
    } else if (expected.run === false && actual.runCompleted) {
        mismatches.push("did not expect runtime execution");
    }

    if (expected.stdout !== undefined) {
        if (normalizeText(actual.stdout) !== expected.stdout) {
            mismatches.push("stdout mismatch");
        }
    }

    if (expected.stderr !== undefined) {
        if (normalizeText(actual.stderr) !== expected.stderr) {
            mismatches.push("stderr mismatch");
        }
    }

    if (expected.exitCode !== undefined) {
        if (actual.exitCode !== expected.exitCode) {
            mismatches.push(`expected exitCode=${expected.exitCode}, got ${actual.exitCode}`);
        }
    }

    const matched = mismatches.length === 0;
    const knownFailure = Boolean(manifest.knownFailure);

    if (knownFailure) {
        return {
            status: matched ? "xpass" : "xfail",
            mismatches,
        };
    }

    return {
        status: matched ? "pass" : "fail",
        mismatches,
    };
}

async function loadCompiler(verbose) {
    return await withQuietConsole(verbose, async () => {
        const moduleUrl = pathToFileURL(path.join(repoRoot, "compiler", "index.js")).href;
        const compilerModule = await import(moduleUrl);
        return compilerModule.Compiler;
    });
}

async function runFixture(Compiler, target, fixture, runRoot, verbose) {
    const expected = normalizeExpectation(fixture.manifest);
    const entryFile = fixture.manifest.entry || "main.js";
    const entryPath = path.join(fixture.dir, entryFile);
    const buildDir = path.join(runRoot, fixture.relativeDir);
    const outputPath = path.join(buildDir, "fixture-bin");

    const actual = {
        parseSuccess: false,
        compileSuccess: false,
        runCompleted: false,
        runTimedOut: false,
        parseError: "",
        compileError: "",
        stdout: "",
        stderr: "",
        exitCode: null,
    };

    if (!existsSync(entryPath)) {
        actual.parseError = `Missing entry file: ${entryPath}`;
        return {
            ...evaluateFixture(actual, expected, fixture.manifest),
            expected,
            actual,
        };
    }

    mkdirSync(buildDir, { recursive: true });

    const source = readFileSync(entryPath, "utf8");

    try {
        await withQuietConsole(verbose, async () => {
            const compiler = new Compiler(target);
            compiler.setSourcePath(entryPath);
            compiler.parse(source);
        });
        actual.parseSuccess = true;
    } catch (error) {
        actual.parseError = error instanceof Error ? error.message : String(error);
    }

    if (actual.parseSuccess) {
        try {
            await withQuietConsole(verbose, async () => {
                const compiler = new Compiler(target);
                compiler.setSourcePath(entryPath);
                compiler.compileFile(entryPath, outputPath);
            });
            actual.compileSuccess = true;
        } catch (error) {
            actual.compileError = error instanceof Error ? error.message : String(error);
        }
    }

    if (actual.compileSuccess && shouldAttemptRuntime(expected)) {
        const fixtureEnv = normalizeFixtureEnv(fixture.manifest.env);
        const runtime = spawnSync(outputPath, [], {
            cwd: fixture.dir,
            encoding: "utf8",
            timeout: expected.timeoutMs,
            env: fixtureEnv ? { ...process.env, ...fixtureEnv } : process.env,
        });

        if (runtime.error && runtime.error.code === "ETIMEDOUT") {
            actual.runTimedOut = true;
            actual.stderr = runtime.stderr || "";
        } else {
            actual.runCompleted = true;
            actual.stdout = runtime.stdout || "";
            actual.stderr = runtime.stderr || "";
            actual.exitCode = runtime.status;
        }
    }

    return {
        ...evaluateFixture(actual, expected, fixture.manifest),
        expected,
        actual,
    };
}

function printFixtureResult(fixture, result, verbose) {
    const statusLabel = formatStatus(result.status);
    console.log(`${statusLabel} ${fixture.relativeDir}  ${describeOutcome(result.actual)}`);

    if (result.status === "pass" && !verbose) {
        return;
    }

    if (result.status === "xfail" && !verbose) {
        if (fixture.manifest.knownFailure) {
            console.log(`  ${fixture.manifest.knownFailure}`);
        }
        return;
    }

    if (fixture.manifest.description) {
        console.log(`  ${fixture.manifest.description}`);
    }

    if (fixture.manifest.knownFailure) {
        console.log(`  known failure: ${fixture.manifest.knownFailure}`);
    }

    if (result.mismatches.length > 0) {
        for (const mismatch of result.mismatches) {
            console.log(`  - ${mismatch}`);
        }
    }

    if (result.actual.parseError) {
        console.log(formatDetailBlock("  parse error", result.actual.parseError).trimEnd());
    }
    if (result.actual.compileError) {
        console.log(formatDetailBlock("  compile error", result.actual.compileError).trimEnd());
    }

    if (result.expected.stdout !== undefined || verbose) {
        console.log(`  expected stdout: ${JSON.stringify(result.expected.stdout ?? "")}`);
        console.log(`  actual stdout:   ${JSON.stringify(normalizeText(result.actual.stdout))}`);
    }
    if (result.expected.stderr !== undefined || verbose) {
        console.log(`  expected stderr: ${JSON.stringify(result.expected.stderr ?? "")}`);
        console.log(`  actual stderr:   ${JSON.stringify(normalizeText(result.actual.stderr))}`);
    }
    if (result.expected.exitCode !== undefined || verbose) {
        console.log(`  expected exit:   ${String(result.expected.exitCode)}`);
        console.log(`  actual exit:     ${String(result.actual.exitCode)}`);
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const Compiler = await loadCompiler(options.verbose);
    const target = detectHostTarget();
    const runRoot = path.join(os.tmpdir(), `asmjs-fixtures-${process.pid}`);

    rmSync(runRoot, { recursive: true, force: true });
    mkdirSync(runRoot, { recursive: true });

    const fixtures = discoverFixtures(fixturesRoot).filter((fixture) => {
        if (options.suites.length > 0 && !options.suites.includes(fixture.suite)) {
            return false;
        }
        if (options.fixtureFilter && !fixture.relativeDir.includes(options.fixtureFilter)) {
            return false;
        }
        return true;
    });

    if (fixtures.length === 0) {
        console.error("No fixtures matched the requested filters.");
        process.exit(1);
    }

    console.log(`Running ${fixtures.length} fixture(s) on ${target}`);

    const counts = {
        pass: 0,
        fail: 0,
        xfail: 0,
        xpass: 0,
    };

    for (const fixture of fixtures) {
        const result = await runFixture(Compiler, target, fixture, runRoot, options.verbose);
        counts[result.status]++;
        printFixtureResult(fixture, result, options.verbose);
    }

    console.log("");
    console.log(`Summary: PASS=${counts.pass} FAIL=${counts.fail} XFAIL=${counts.xfail} XPASS=${counts.xpass}`);

    if (counts.fail > 0 || counts.xpass > 0) {
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
