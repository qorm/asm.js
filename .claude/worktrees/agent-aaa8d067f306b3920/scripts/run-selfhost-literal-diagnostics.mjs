#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const hostCli = path.join(repoRoot, "cli.js");

const cases = [
    {
        id: "console-number-0",
        code: "console.log(0);\n",
        expectedStdout: "0",
        expectedString: null,
    },
    {
        id: "console-number-1",
        code: "console.log(1);\n",
        expectedStdout: "1",
        expectedString: null,
    },
    {
        id: "console-null",
        code: "console.log(null);\n",
        expectedStdout: "null",
        expectedString: null,
    },
    {
        id: "console-true",
        code: "console.log(true);\n",
        expectedStdout: "true",
        expectedString: null,
    },
    {
        id: "console-string",
        code: "console.log(\"method-ok\");\n",
        expectedStdout: "method-ok",
        expectedString: "method-ok",
    },
    {
        id: "member-read",
        code: "const obj = { value: \"method-ok\" }; console.log(obj.value);\n",
        expectedStdout: "method-ok",
        expectedString: "method-ok",
    },
    {
        id: "via-identifier",
        code: "const obj = { value: \"method-ok\" }; const value = obj.value; console.log(value);\n",
        expectedStdout: "method-ok",
        expectedString: "method-ok",
    },
    {
        id: "object-method-call",
        code: "const obj = { value: \"method-ok\", get() { return this.value; } }; console.log(obj.get());\n",
        expectedStdout: "method-ok",
        expectedString: "method-ok",
    },
];

function normalizeText(value) {
    return String(value ?? "").replace(/\r\n/g, "\n").trimEnd();
}

function run(command, args, options = {}) {
    return spawnSync(command, args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: process.env,
        maxBuffer: 64 * 1024 * 1024,
        ...options,
    });
}

function toHex(text) {
    const bytes = Buffer.from(String(text ?? ""), "utf8");
    return bytes.toString("hex");
}

const workDir = mkdtempSync(path.join(os.tmpdir(), "asmjs-selfhost-literal-diag-"));
let success = false;

try {
    const gen1Path = path.join(workDir, "asmjs-gen1");
    const build = run(process.execPath, [hostCli, hostCli, "-o", gen1Path]);
    if (build.status !== 0 || !existsSync(gen1Path)) {
        console.error("FAIL build-gen1");
        if (build.signal) console.error(`signal=${build.signal}`);
        if (build.stderr) console.error(build.stderr.trimEnd());
        if (build.stdout) console.error(build.stdout.trimEnd());
        process.exit(1);
    }

    const rows = [];
    for (const item of cases) {
        const src = path.join(workDir, `${item.id}.js`);
        const bin = path.join(workDir, `${item.id}-bin`);
        writeFileSync(src, item.code, "utf8");

        const compile = run(gen1Path, [src, "-o", bin]);
        if (compile.status !== 0 || !existsSync(bin)) {
            rows.push({
                id: item.id,
                compile: "fail",
                run: "skipped",
                stdout: "",
                stdoutHex: "",
                expectedStdout: item.expectedStdout,
                binaryHasExpectedString: false,
            });
            continue;
        }

        const runtime = run(bin, [], { cwd: workDir });
        const stdout = normalizeText(runtime.stdout);
        const compileOk = compile.status === 0;
        const runOk = runtime.status === 0;

        let binaryHasExpectedString = false;
        if (item.expectedString) {
            const strings = run("strings", ["-a", bin]);
            if (strings.status === 0) {
                binaryHasExpectedString = strings.stdout.includes(item.expectedString);
            }
        } else {
            binaryHasExpectedString = true;
        }

        rows.push({
            id: item.id,
            compile: compileOk ? "ok" : "fail",
            run: runOk ? "ok" : `exit=${runtime.status}`,
            stdout,
            stdoutHex: toHex(runtime.stdout || ""),
            expectedStdout: item.expectedStdout,
            binaryHasExpectedString,
        });
    }

    console.log(`workspace: ${workDir}`);
    console.log("");
    console.log("case,compile,run,stdout,expectedStdout,stdoutHex,binaryHasExpectedString");
    for (const row of rows) {
        const escapedStdout = JSON.stringify(row.stdout);
        const escapedExpected = JSON.stringify(row.expectedStdout);
        console.log(
            `${row.id},${row.compile},${row.run},${escapedStdout},${escapedExpected},${row.stdoutHex},${row.binaryHasExpectedString}`
        );
    }

    success = true;
} finally {
    if (success) {
        rmSync(workDir, { recursive: true, force: true });
    } else {
        console.error(`artifacts: ${workDir}`);
    }
}
