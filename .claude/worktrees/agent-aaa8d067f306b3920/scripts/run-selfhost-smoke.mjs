#!/usr/bin/env node

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const matrixMode = argv.includes("--matrix") || argv.includes("--strict");
const strictMode = argv.includes("--strict");
const chainMode = argv.includes("--chain");
const chainDepth = 3;
const configuredStepTimeoutMs = Number(process.env.ASMJS_SELFHOST_STEP_TIMEOUT_MS || 0);
const stepTimeoutMs =
    Number.isFinite(configuredStepTimeoutMs) && configuredStepTimeoutMs > 0
        ? Math.floor(configuredStepTimeoutMs)
        : 0;
const traceHarness = process.env.ASMJS_SELFHOST_TRACE === "1";

const selfhostCases = [
    {
        id: "json-global",
        entry: path.join(repoRoot, "tests", "fixtures", "es", "json-global", "main.js"),
        expectedStdout: "object",
        expectedExitCode: 0,
        required: true,
    },
    {
        id: "literal-log",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "literal-log.js"),
        expectedStdout: "method-ok",
        expectedExitCode: 0,
        required: false,
    },
    {
        id: "member-read",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "member-read.js"),
        expectedStdout: "method-ok",
        expectedExitCode: 0,
        required: false,
    },
    {
        id: "via-identifier",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "via-identifier.js"),
        expectedStdout: "method-ok",
        expectedExitCode: 0,
        required: false,
    },
    {
        id: "object-method-call",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "object-method-call.js"),
        expectedStdout: "method-ok",
        expectedExitCode: 0,
        required: false,
    },
    {
        id: "object-method-via-local",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "object-method-via-local.js"),
        expectedStdout: "method-ok",
        expectedExitCode: 0,
        required: false,
    },
    {
        // require(builtin) default-export self-host divergence: only the g1-compiled
        // path regressed (relative module paths missed the "/runtime/node/" prefix in
        // _requireExportKind -> events/util returned as namespace -> new EE() crashed).
        // The normal fixture harness (node cli.js) can't catch it (cli.js is ESM, no
        // require), so this g1-compiled probe is the guard.
        id: "require-builtin-default",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "require-builtin-default.js"),
        expectedStdout: "require-default-ok",
        expectedExitCode: 0,
        required: false,
    },
    // Compiled-only-divergence guards: each probe compiles+runs through the g1
    // self-compiled compiler and prints "<name>-ok" iff behavior matches node. These
    // exercise surfaces the ESM cli.js never uses (require/Buffer/crypto/child_process/
    // Proxy/typed-arrays/for-await/Map-Set/spread/closures), which the standard gate is
    // blind to (require-default and the injector unshift-spread bugs both hid there).
    {
        id: "require-builtin-namespace",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "require-builtin-namespace.js"),
        expectedStdout: "require-namespace-ok",
        expectedExitCode: 0,
        required: false,
    },
    {
        id: "buffer-ops",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "buffer-ops.js"),
        expectedStdout: "buffer-ops-ok",
        expectedExitCode: 0,
        required: false,
    },
    {
        id: "crypto-random",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "crypto-random.js"),
        expectedStdout: "crypto-random-ok",
        expectedExitCode: 0,
        required: false,
    },
    {
        id: "child-process-exec",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "child-process-exec.js"),
        expectedStdout: "child-exec-ok",
        expectedExitCode: 0,
        required: false,
    },
    {
        id: "proxy-traps",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "proxy-traps.js"),
        expectedStdout: "proxy-traps-ok",
        expectedExitCode: 0,
        required: false,
    },
    {
        id: "typed-array-dataview",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "typed-array-dataview.js"),
        expectedStdout: "typed-array-ok",
        expectedExitCode: 0,
        required: false,
    },
    {
        id: "for-await",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "for-await.js"),
        expectedStdout: "for-await-ok",
        expectedExitCode: 0,
        required: false,
    },
    {
        id: "map-set",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "map-set.js"),
        expectedStdout: "map-set-ok",
        expectedExitCode: 0,
        required: false,
    },
    {
        id: "spread-forms",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "spread-forms.js"),
        expectedStdout: "spread-forms-ok",
        expectedExitCode: 0,
        required: false,
    },
    {
        id: "closures-generators",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "closures-generators.js"),
        expectedStdout: "closures-gen-ok",
        expectedExitCode: 0,
        required: false,
    },
    {
        // Non-ASCII string literals must not be double-encoded/truncated by the compiled
        // compiler (你好 -> mojibake). Source read latin1 (raw UTF-8 bytes), \u/\x escapes
        // decoded to UTF-8 bytes in the lexer, emitted verbatim; g1 output == node.
        id: "nonascii-string-literal",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "nonascii-string-literal.js"),
        expectedStdout: "nonascii-ok",
        expectedExitCode: 0,
        required: false,
    },
    {
        // Guards the UTF-8-aware string behaviors (code-point iteration, string/template
        // escape cooking, raw passthrough, normalize identity). Byte-model index/length
        // ops are the documented UTF-16 deep item and not asserted here.
        id: "string-surface",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "string-surface.js"),
        expectedStdout: "string-surface-ok",
        expectedExitCode: 0,
        required: false,
    },
    {
        // Builtin namespace statics (Math.*/Object.*/Date.now) as first-class values:
        // typeof function, call via variable, arr.map(Math.floor), memoized identity.
        id: "builtin-statics-values",
        entry: path.join(repoRoot, "tests", "selfhost", "probes", "builtin-statics-values.js"),
        expectedStdout: "builtin-statics-ok",
        expectedExitCode: 0,
        required: false,
    },
];

const chainConsistencyFixtureDirs = [
    path.join(repoRoot, "tests", "fixtures", "es", "json-global"),
    path.join(repoRoot, "tests", "fixtures", "modules", "simple-local-import"),
    path.join(repoRoot, "tests", "fixtures", "node", "cjs", "require-local-function-export"),
    path.join(repoRoot, "tests", "fixtures", "node", "builtin-node-scheme-process"),
];

const selectedCases = matrixMode ? selfhostCases : selfhostCases.filter((item) => item.required);

function normalizeText(value) {
    return String(value ?? "").replace(/\r\n/g, "\n").trimEnd();
}

function fixtureCaseFromDir(fixtureDir) {
    const manifestPath = path.join(fixtureDir, "fixture.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const expect = manifest.expect || {};
    const entry = path.join(fixtureDir, manifest.entry || "main.js");
    const relativeId = path
        .relative(path.join(repoRoot, "tests", "fixtures"), fixtureDir)
        .split(path.sep)
        .join("/");

    return {
        id: relativeId,
        entry,
        expectedStdout: Object.prototype.hasOwnProperty.call(expect, "stdout")
            ? normalizeText(expect.stdout)
            : undefined,
        expectedExitCode: Object.prototype.hasOwnProperty.call(expect, "exitCode")
            ? expect.exitCode
            : 0,
    };
}

function tail(text, lines = 40) {
    return normalizeText(text)
        .split("\n")
        .slice(-lines)
        .join("\n");
}

function runStep(command, args, options = {}) {
    const { env: providedEnv, ...spawnOptions } = options;
    const timeoutOptions = stepTimeoutMs > 0
        ? { timeout: stepTimeoutMs, killSignal: "SIGKILL" }
        : {};
    let childEnv = providedEnv || process.env;
    if (traceHarness && childEnv.ASMJS_TRACE_COMPILE !== "1") {
        childEnv = { ...childEnv, ASMJS_TRACE_COMPILE: "1" };
    }
    if (traceHarness) {
        console.log(`TRACE selfhost-runner: spawn ${command} ${args.join(" ")}`);
    }
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: childEnv,
        maxBuffer: 64 * 1024 * 1024,
        ...timeoutOptions,
        ...spawnOptions,
    });
    if (traceHarness) {
        const status = typeof result.status === "number" ? String(result.status) : "null";
        console.log(`TRACE selfhost-runner: done status=${status} signal=${result.signal || ""}`);
    }
    return result;
}

function formatFailure(label, result) {
    const parts = [`${label} failed`];

    if (typeof result.status === "number") {
        parts.push(`exit=${result.status}`);
    }

    if (result.signal) {
        parts.push(`signal=${result.signal}`);
    }

    if (result.error) {
        parts.push(`error=${result.error.message}`);
    }

    const stderr = tail(result.stderr);
    if (stderr) {
        parts.push(`stderr:\n${stderr}`);
    }

    const stdout = tail(result.stdout);
    if (stdout) {
        parts.push(`stdout:\n${stdout}`);
    }

    return parts.join("\n");
}

function ensureExecutable(filePath) {
    try {
        chmodSync(filePath, 0o755);
    } catch {}
}

function fileSize(filePath) {
    try {
        return statSync(filePath).size;
    } catch {
        return -1;
    }
}

function formatArtifact(label, filePath) {
    const size = fileSize(filePath);
    if (size < 0) {
        return `${label}: ${filePath} (missing)`;
    }
    return `${label}: ${filePath} (${size} bytes)`;
}

function validateGeneratedCompiler(compilerPath, generationId, sourceLabel) {
    const validationCase = selfhostCases[0];
    const result = runCompilerCase(
        compilerPath,
        validationCase,
        `${generationId}/chain-validate/${validationCase.id}`
    );
    if (!result.ok) {
        return {
            ok: false,
            detail: [
                `Generated compiler validation (${generationId}, source=${sourceLabel}) failed`,
                formatArtifact("generated compiler", compilerPath),
                result.detail,
            ].join("\n"),
        };
    }

    return { ok: true };
}

function toSafeSegment(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "chain";
}

const workDir = mkdtempSync(path.join(os.tmpdir(), "asmjs-selfhost-"));
let success = false;

class SelfhostFailure extends Error {
    constructor(message) {
        super(message);
        this.name = "SelfhostFailure";
    }
}

function failNow(message) {
    throw new SelfhostFailure(message);
}

function buildCompilerChain(sourceEntry, sourceLabel, generationDepth, logBuildSteps) {
    const slug = toSafeSegment(sourceLabel);
    const hostCli = path.join(repoRoot, "cli.js");
    const compilers = [];
    const gen1Compiler = path.join(workDir, `asmjs-gen1-${slug}`);

    const hostCompile = runStep(process.execPath, [hostCli, sourceEntry, "-o", gen1Compiler]);
    if (hostCompile.status !== 0 || !existsSync(gen1Compiler)) {
        return {
            ok: false,
            detail: [
                formatFailure(
                    `Host compiler -> gen1 compiler (source=${sourceLabel})`,
                    hostCompile
                ),
                formatArtifact("expected output", gen1Compiler),
            ].join("\n"),
        };
    }
    ensureExecutable(gen1Compiler);
    const gen1Validation = validateGeneratedCompiler(gen1Compiler, "gen1", sourceLabel);
    if (!gen1Validation.ok) {
        return gen1Validation;
    }
    compilers.push({ id: "gen1", path: gen1Compiler });
    if (logBuildSteps) {
        console.log(`PASS selfhost-chain-build gen1 source=${sourceLabel} size=${fileSize(gen1Compiler)}`);
    }

    let previousCompiler = gen1Compiler;
    for (let generation = 2; generation <= generationDepth; generation++) {
        const outputCompiler = path.join(workDir, `asmjs-gen${generation}-${slug}`);
        const compileResult = runStep(previousCompiler, [sourceEntry, "-o", outputCompiler]);
        if (compileResult.status !== 0 || !existsSync(outputCompiler)) {
            return {
                ok: false,
                detail: [
                    formatFailure(
                        `Gen${generation - 1} compiler -> gen${generation} compiler (source=${sourceLabel})`,
                        compileResult
                    ),
                    formatArtifact("input compiler", previousCompiler),
                    formatArtifact("expected output", outputCompiler),
                ].join("\n"),
            };
        }
        ensureExecutable(outputCompiler);
        const validation = validateGeneratedCompiler(outputCompiler, `gen${generation}`, sourceLabel);
        if (!validation.ok) {
            return validation;
        }
        if (logBuildSteps) {
            console.log(`PASS selfhost-chain-build gen${generation} source=${sourceLabel} size=${fileSize(outputCompiler)}`);
        }
        compilers.push({ id: `gen${generation}`, path: outputCompiler });
        previousCompiler = outputCompiler;
    }

    return {
        ok: true,
        compilers,
    };
}

function runCompilerCase(compilerPath, testCase, label) {
    const outputName = label.replace(/[^\w.-]+/g, "-");
    const compiledOutput = path.join(workDir, `${outputName}-bin`);
    const fixtureCwd = path.dirname(testCase.entry);

    const compileResult = runStep(compilerPath, [testCase.entry, "-o", compiledOutput]);
    if (compileResult.status !== 0 || !existsSync(compiledOutput)) {
        return {
            ok: false,
            stage: "compile",
            detail: [
                formatFailure(`Compile (${label})`, compileResult),
                formatArtifact("compiler", compilerPath),
                formatArtifact("expected output", compiledOutput),
            ].join("\n"),
        };
    }
    ensureExecutable(compiledOutput);

    const runtimeResult = spawnSync(compiledOutput, [], {
        cwd: fixtureCwd,
        encoding: "utf8",
        env: process.env,
        maxBuffer: 4 * 1024 * 1024,
    });

    const actualExitCode = typeof runtimeResult.status === "number" ? runtimeResult.status : -1;
    if (testCase.expectedExitCode !== undefined && actualExitCode !== testCase.expectedExitCode) {
        return {
            ok: false,
            stage: "run",
            detail: [
                `Fixture runtime exit mismatch (${label})`,
                `expected: ${testCase.expectedExitCode}`,
                `actual:   ${actualExitCode}`,
                formatFailure(`Fixture runtime (${label})`, runtimeResult),
            ].join("\n"),
        };
    }

    const actualStdout = normalizeText(runtimeResult.stdout);
    if (testCase.expectedStdout !== undefined && actualStdout !== testCase.expectedStdout) {
        return {
            ok: false,
            stage: "stdout",
            detail: [
                `Fixture runtime stdout mismatch (${label})`,
                `expected: ${JSON.stringify(testCase.expectedStdout)}`,
                `actual:   ${JSON.stringify(actualStdout)}`,
            ].join("\n"),
        };
    }

    return {
        ok: true,
        stdout: actualStdout,
        exitCode: actualExitCode,
    };
}

function runSelfhostCasesForCompiler(compiler, failures) {
    let passed = 0;
    const outputs = new Map();

    for (const testCase of selectedCases) {
        const caseLabel = `${compiler.id}/${testCase.id}`;
        const result = runCompilerCase(compiler.path, testCase, caseLabel);
        if (result.ok) {
            passed += 1;
            outputs.set(testCase.id, {
                stdout: result.stdout,
                exitCode: result.exitCode,
            });
            console.log(`PASS selfhost-case ${caseLabel}`);
            continue;
        }

        failures.push({
            id: testCase.id,
            generation: compiler.id,
            required: testCase.required,
            stage: result.stage,
            detail: result.detail,
        });
        console.log(`FAIL selfhost-case ${caseLabel} stage=${result.stage}`);
    }

    return { passed, outputs };
}

function runChainConsistency(compilers) {
    const consistencyCases = chainConsistencyFixtureDirs.map((fixtureDir) => fixtureCaseFromDir(fixtureDir));
    const failures = [];
    let passed = 0;
    const outputsByCase = new Map();

    for (const compiler of compilers) {
        for (const testCase of consistencyCases) {
            const caseLabel = `${compiler.id}/fixture/${testCase.id}`;
            const result = runCompilerCase(compiler.path, testCase, caseLabel);
            if (!result.ok) {
                failures.push({
                    id: testCase.id,
                    generation: compiler.id,
                    stage: result.stage,
                    detail: result.detail,
                });
                console.log(`FAIL selfhost-chain-fixture ${caseLabel} stage=${result.stage}`);
                continue;
            }

            passed += 1;
            console.log(`PASS selfhost-chain-fixture ${caseLabel}`);

            if (!outputsByCase.has(testCase.id)) {
                outputsByCase.set(testCase.id, new Map());
            }
            outputsByCase.get(testCase.id).set(compiler.id, {
                stdout: result.stdout,
                exitCode: result.exitCode,
            });
        }
    }

    let mismatchCount = 0;
    for (const testCase of consistencyCases) {
        const records = outputsByCase.get(testCase.id);
        if (!records) {
            continue;
        }

        const baseline = records.get(compilers[0].id);
        if (!baseline) {
            continue;
        }

        for (let i = 1; i < compilers.length; i++) {
            const generation = compilers[i].id;
            const current = records.get(generation);
            if (!current) {
                continue;
            }

            if (current.exitCode !== baseline.exitCode || current.stdout !== baseline.stdout) {
                mismatchCount += 1;
                failures.push({
                    id: testCase.id,
                    generation,
                    stage: "consistency",
                    detail: [
                        `Cross-generation mismatch (${testCase.id})`,
                        `baseline(${compilers[0].id}) exit=${baseline.exitCode} stdout=${JSON.stringify(baseline.stdout)}`,
                        `current(${generation}) exit=${current.exitCode} stdout=${JSON.stringify(current.stdout)}`,
                    ].join("\n"),
                });
                console.log(`FAIL selfhost-chain-consistency ${generation}/fixture/${testCase.id}`);
            } else {
                console.log(`PASS selfhost-chain-consistency ${generation}/fixture/${testCase.id}`);
            }
        }
    }

    return {
        failures,
        passed,
        mismatchCount,
        total: consistencyCases.length * compilers.length,
    };
}

try {
    console.log(`Self-host smoke workspace: ${workDir}`);

    const cliEntry = path.join(repoRoot, "cli.js");
    const fallbackChainEntry = path.join(repoRoot, "tests", "selfhost", "chain", "mini-cli.js");
    let compilers = [];
    let chainSourceLabel = "cli.js";
    let chainUsedFallback = false;

    if (chainMode) {
        const primaryBuild = buildCompilerChain(cliEntry, "cli.js", chainDepth, true);
        if (primaryBuild.ok) {
            compilers = primaryBuild.compilers;
        } else {
            if (strictMode) {
                failNow(primaryBuild.detail);
            }

            console.error(primaryBuild.detail);
            console.error("Retrying chain build with fallback source: tests/selfhost/chain/mini-cli.js");
            const fallbackBuild = buildCompilerChain(
                fallbackChainEntry,
                "tests/selfhost/chain/mini-cli.js",
                chainDepth,
                true
            );
            if (!fallbackBuild.ok) {
                failNow(`Fallback chain build failed\n${fallbackBuild.detail}`);
            }

            chainUsedFallback = true;
            chainSourceLabel = "tests/selfhost/chain/mini-cli.js";
            compilers = fallbackBuild.compilers;
        }
    } else {
        const baseBuild = buildCompilerChain(cliEntry, "cli.js", 1, false);
        if (!baseBuild.ok) {
            failNow(baseBuild.detail);
        }
        compilers = baseBuild.compilers;
    }

    const failedCases = [];
    let passedCount = 0;
    for (const compiler of compilers) {
        const { passed } = runSelfhostCasesForCompiler(compiler, failedCases);
        passedCount += passed;
    }

    if (matrixMode || chainMode) {
        console.log(
            `Self-host matrix summary: total=${selectedCases.length * compilers.length} pass=${passedCount} fail=${failedCases.length} strict=${strictMode ? "true" : "false"} chain=${chainMode ? "true" : "false"}`
        );
    }

    let chainResult = null;
    if (chainMode) {
        chainResult = runChainConsistency(compilers);
        console.log(
            `Self-host chain fixture summary: total=${chainResult.total} pass=${chainResult.passed} fail=${chainResult.failures.length} mismatch=${chainResult.mismatchCount} source=${chainSourceLabel} fallback=${chainUsedFallback ? "true" : "false"}`
        );
    }

    if (failedCases.length > 0) {
        for (const failure of failedCases) {
            console.error(`\n[${failure.generation}/${failure.id}] ${failure.stage} failure`);
            console.error(failure.detail);
        }
    }

    if (chainResult && chainResult.failures.length > 0) {
        for (const failure of chainResult.failures) {
            console.error(`\n[${failure.generation}/fixture/${failure.id}] ${failure.stage} failure`);
            console.error(failure.detail);
        }
    }

    const blockingFailures = failedCases.filter((failure) => strictMode || failure.required);
    const chainBlockingFailures = chainResult ? chainResult.failures : [];
    if (blockingFailures.length > 0 || chainBlockingFailures.length > 0) {
        failNow("Self-host checks failed");
    }

    success = true;
    if (chainMode) {
        console.log("PASS selfhost-smoke (chain)");
    } else if (!matrixMode) {
        console.log("PASS selfhost-smoke");
    } else {
        console.log("PASS selfhost-smoke (required cases)");
    }
} catch (error) {
    if (error instanceof SelfhostFailure) {
        console.error(error.message);
        process.exitCode = 1;
    } else {
        throw error;
    }
} finally {
    if (success) {
        rmSync(workDir, { recursive: true, force: true });
    } else {
        console.error(`Self-host smoke artifacts kept at: ${workDir}`);
    }
}
