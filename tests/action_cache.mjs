import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionCache, computeCompilerBuildId } from "../compiler/cache/action-cache.js";

const root = mkdtempSync(join(tmpdir(), "asmjs-action-cache-test-"));

try {
    mkdirSync(join(root, "compiler"), { recursive: true });
    writeFileSync(join(root, "compiler", "tool.js"), "export const version = 1;\n");
    writeFileSync(join(root, "cli.js"), "/* test compiler */\n");
    writeFileSync(join(root, "package.json"), "{}\n");

    const input = join(root, "input.js");
    const dependency = join(root, "dependency.js");
    const output = join(root, "out");
    const cacheDirectory = join(root, "cache");
    writeFileSync(input, "print(1);\n");
    writeFileSync(dependency, "export const value = 1;\n");

    let compiles = 0;
    const run = (overrides = {}) => {
        const cache = new ActionCache({
            repositoryRoot: root,
            cacheDirectory,
            environment: overrides.environment || {},
            disabled: overrides.disabled,
        });
        return cache.run({
            inputFile: overrides.inputFile || input,
            inputIdentity: overrides.inputIdentity,
            outputIdentity: overrides.outputIdentity,
            outputFiles: [output],
            target: "macos-arm64",
            outputType: "executable",
            compilerOptions: {},
            exports: [],
            compile: () => {
                compiles++;
                writeFileSync(output, "binary-" + compiles);
                chmodSync(output, 0o755);
                return { output };
            },
            getInputs: () => overrides.inputs || [{ path: dependency }],
        });
    };

    const cold = run();
    assert.equal(cold.hit, false);
    rmSync(output, { force: true });
    const warm = run();
    assert.equal(warm.hit, true);
    assert.equal(readFileSync(output, "utf8"), "binary-1");

    writeFileSync(dependency, "export const value = 2;\n");
    assert.equal(run().hit, false, "dependency content must invalidate action");

    writeFileSync(input, "print(2);\n");
    assert.equal(run().hit, false, "entry content must invalidate action");

    const envCold = run({ environment: { GC_DIAG: "1" } });
    assert.equal(envCold.hit, false, "codegen environment must be part of action ID");

    assert.equal(run({ disabled: true }).hit, false, "disabled cache must compile");

    const virtualCache = join(root, "virtual-cache");
    const movedInput = join(root, "other", "input.js");
    mkdirSync(join(root, "other"), { recursive: true });
    writeFileSync(movedInput, readFileSync(input));
    const virtualRun = (file) => {
        const cache = new ActionCache({
            repositoryRoot: root,
            cacheDirectory: virtualCache,
            environment: {},
        });
        return cache.run({
            inputFile: file,
            inputIdentity: "test262/example.js#sloppy",
            outputIdentity: "test262:test262/example.js#sloppy",
            outputFiles: [output],
            target: "macos-arm64",
            outputType: "executable",
            compile: () => {
                compiles++;
                writeFileSync(output, "virtual-" + compiles);
                chmodSync(output, 0o755);
                return { output };
            },
            getInputs: () => [{ path: file }],
        });
    };
    assert.equal(virtualRun(input).hit, false);
    rmSync(output, { force: true });
    assert.equal(virtualRun(movedInput).hit, true,
        "virtual identity must survive a different temporary physical path");

    const corruptCache = join(root, "corrupt-cache");
    const corrupt = new ActionCache({
        repositoryRoot: root,
        cacheDirectory: corruptCache,
        environment: {},
    });
    const corruptOptions = {
        inputFile: input,
        outputFiles: [output],
        target: "macos-arm64",
        outputType: "executable",
        compile: () => {
            compiles++;
            writeFileSync(output, "repaired-" + compiles);
            chmodSync(output, 0o755);
            return { output };
        },
        getInputs: () => [],
    };
    const published = corrupt.run(corruptOptions);
    const action = JSON.parse(readFileSync(
        join(corruptCache, "actions", published.requestKey + ".json"), "utf8"));
    writeFileSync(join(corruptCache, "entries", action.key, action.artifacts[0].file), "corrupt");
    assert.equal(corrupt.run(corruptOptions).hit, false,
        "corrupt artifact must be rejected and rebuilt");
    rmSync(output, { force: true });
    assert.equal(corrupt.run(corruptOptions).hit, true,
        "repaired artifact must be reusable on the next action");

    const build1 = computeCompilerBuildId(root);
    writeFileSync(join(root, "compiler", "tool.js"), "export const version = 2;\n");
    const build2 = computeCompilerBuildId(root);
    assert.notEqual(build1, build2, "uncommitted compiler source must change build ID");

    console.log("action cache tests passed");
} finally {
    rmSync(root, { recursive: true, force: true });
}
