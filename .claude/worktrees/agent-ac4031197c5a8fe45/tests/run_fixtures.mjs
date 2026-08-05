// Minimal fixture runner: compiles each fixtures/**/main.js with gen0 (node cli.js),
// runs the native binary, compares stdout/exitCode against fixture.json expectations.
// ASMJS_FIXTURE_WASM=1:改编 wasm32-wasi 并经 scripts/wasm_host.mjs 运行(其余判定同一)。
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturesDir = join(root, "tests", "fixtures");
const wasmMode = !!process.env.ASMJS_FIXTURE_WASM;
const wasmHost = join(root, "scripts", "wasm_host.mjs");

function findFixtures(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (!statSync(p).isDirectory()) continue;
        if (existsSync(join(p, "fixture.json")) && existsSync(join(p, "main.js"))) {
            out.push(p);
        } else {
            out.push(...findFixtures(p));
        }
    }
    return out;
}

const only = process.argv[2]; // optional substring filter
const fixtures = findFixtures(fixturesDir).filter(f => !only || f.includes(only));
let pass = 0, fail = 0;
const failures = [];

for (const dir of fixtures) {
    const spec = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"));
    // wasm 模式下若声明 expectWasm 则整体覆盖 expect(用于 native 上崩溃/不适用、
    // 但 wasm 语义正确的用例;native 模式恒忽略 expectWasm,既有 fixture 行为不变)。
    const exp = (wasmMode && spec.expectWasm) ? spec.expectWasm : (spec.expect || {});
    const bin = join("/tmp", "fx_" + Buffer.from(dir).toString("hex").slice(-16) + (wasmMode ? ".wasm" : ""));
    let ok = true, reason = "";
    const compileArgs = [join(root, "cli.js"), join(dir, "main.js"), "-o", bin];
    if (wasmMode) compileArgs.push("--target", "wasm32-wasi");
    try {
        execFileSync("node", compileArgs,
            { stdio: ["ignore", "ignore", "ignore"], timeout: 60000 });
    } catch (e) {
        if (exp.compile === false) { pass++; continue; }
        ok = false; reason = "COMPILE_FAIL";
    }
    if (ok && exp.run !== false) {
        let stdout = "", code = 0;
        // fixture.json 可声明 env,合并进被测二进制的环境(process.env 从 envp 读取;
        // wasm 模式下宿主 shim 把自身 env 写进递交区,同样生效)
        const childEnv = spec.env ? { ...process.env, ...spec.env } : process.env;
        const runCmd = wasmMode ? "node" : bin;
        const runArgs = wasmMode ? [wasmHost, bin] : [];
        try {
            stdout = execFileSync(runCmd, runArgs, { timeout: wasmMode ? 30000 : 10000, encoding: "utf8", env: childEnv });
        } catch (e) {
            code = e.status == null ? 1 : e.status;
            stdout = (e.stdout || "").toString();
        }
        const gotOut = stdout.replace(/\s+$/, "");
        const wantOut = (exp.stdout || "").replace(/\s+$/, "");
        if (exp.stdout != null && gotOut !== wantOut) { ok = false; reason = `stdout: want[${JSON.stringify(wantOut)}] got[${JSON.stringify(gotOut)}]`; }
        else if (exp.exitCode != null && code !== exp.exitCode) { ok = false; reason = `exit: want ${exp.exitCode} got ${code}`; }
    }
    if (ok) pass++;
    else { fail++; failures.push(`${dir.replace(root + "/", "")}: ${reason}`); }
}

console.log(`\nPASS=${pass} FAIL=${fail} TOTAL=${fixtures.length}`);
if (failures.length) { console.log("\n--- FAILURES ---"); for (const f of failures) console.log(f); }
