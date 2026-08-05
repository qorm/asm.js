#!/usr/bin/env node
// asm.js 命令行编译工具

import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, unlinkSync } from "fs";
import { dirname, basename, join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

import { Compiler } from "./compiler/index.js";
import { detectPlatform, resolveTarget, listTargets } from "./compiler/core/platform.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 版本号：公开仓库重新初始化后自 0.1 起算（能力基线 = 原 v1.5.52,非功能回退）
const VERSION = "0.2.2";

function printUsage() {
    console.log(`
asm.js Compiler - JavaScript to Native

Usage:
  asm.js <input.js> [options]

Options:
  -o, --output <file>   Output file path (default: input basename + target)
  --os <os>             Target OS: linux, macos, windows
  --arch <arch>         Target architecture: arm64, x64
  --target <target>     Target platform (e.g., macos-arm64, linux-x64)
  --shared              Build shared library (.dylib/.so/.dll)
  --static              Build static library (.a/.lib)
  --no-jslib            Don't generate .jslib declaration file
  --export <name>       Export symbol (can be used multiple times)
  --lib <name>          Link with library
  --lib-path <path>     Add library search path
  --list-targets        List all supported targets
  --debug               Enable debug output
  -v, --version         Show version number
  -h, --help            Show this help

  asm.js run <input.js> [args...]  Compile for the host silently, then execute it

Examples:
  asm.js hello.js                              # Compile for current platform
  asm.js hello.js -o hello                     # Custom output name
  asm.js hello.js --os linux --arch x64        # Cross-compile to Linux x64
  asm.js hello.js --target macos-arm64         # Cross-compile to macOS ARM64
  asm.js mylib.js --shared -o libmy.dylib      # Build shared library
  asm.js mylib.js --static -o libmy.a          # Build static library
  asm.js app.js --lib mylib --lib-path ./libs  # Link with library
  asm.js run app.js foo bar                    # Run app.js (compiles under the hood)
`);
}

// `asm.js run <input.js> [program args...]`：把「运行」当执行而非编译——静默编译到
// 临时二进制、继承 stdio 直接执行、透传退出码、跑完删临时文件。用户看到的只有程序
// 自身的输出,没有编译日志、不留产物。（注:native 二进制里 child_process 是桩,故真正
// 执行只在 `node cli.js run` / gen0 下发生;编译到 native 仅保证源码可编译、不动自举。)
function runSubcommand(args) {
    // `asm.js run --wasm <input.js> [args...]`:编 wasm32-wasi 到临时 .wasm,
    // 经 scripts/wasm_host.mjs 在 node 下执行(仅 gen0/node 驱动下可用,同上注)。
    let wasm = false;
    if (args[0] === "--wasm") {
        wasm = true;
        args = args.slice(1);
    }
    if (args.length === 0) {
        console.error("Usage: asm.js run [--wasm] <input.js> [program args...]");
        process.exit(1);
    }
    if (args[0] === "-h" || args[0] === "--help") {
        console.log("Usage: asm.js run [--wasm] <input.js> [program args...]");
        console.log("Compiles <input.js> for the host platform (or wasm32-wasi with --wasm) to a temp file, executes it, then removes it.");
        process.exit(0);
    }

    const inputFile = resolve(process.cwd(), args[0]);
    const progArgs = args.slice(1);

    if (!existsSync(inputFile)) {
        console.error(`Error: Input file not found: ${inputFile}`);
        process.exit(1);
    }

    const target = wasm ? "wasm32-wasi" : detectPlatform();
    const tmpDir = process.env.TMPDIR || "/tmp";
    const tmpOut = join(tmpDir, `asmjs-run-${basename(inputFile, ".js")}-${process.pid}${wasm ? ".wasm" : ""}`);

    // 静默编译（无 Compiling.../Successfully 提示）
    try {
        const compiler = new Compiler(target);
        compiler.setSourcePath(inputFile);
        compiler.compileFile(inputFile, tmpOut);
    } catch (e) {
        console.error(`Compilation error: ${e.message}`);
        if (process.env.DEBUG) console.error(e.stack);
        process.exit(1);
    }

    // 执行：继承 stdio,程序输出直达终端;透传退出码。
    // 末行展示运行时间(仅执行耗时,不含编译;走 stderr 不污染程序 stdout 管道)。
    // 注:native 二进制下 spawnSync 是 execve 就地替换,不返回 → 计时天然不生效。
    const t0 = Date.now();
    const res = wasm
        ? spawnSync(process.execPath, [join(__dirname, "scripts", "wasm_host.mjs"), tmpOut, ...progArgs], { stdio: "inherit" })
        : spawnSync(tmpOut, progArgs, { stdio: "inherit" });
    const elapsed = (Date.now() - t0) / 1000;
    try { unlinkSync(tmpOut); } catch (e) { /* 忽略清理失败 */ }

    if (res.error) {
        console.error(`Failed to execute: ${res.error.message}`);
        process.exit(1);
    }
    console.error(`[asm.js run] ${elapsed.toFixed(3)}s`);
    process.exit(res.status === null ? 1 : res.status);
}

function parseArgs(args) {
    const result = {
        input: null,
        output: null,
        os: null,
        arch: null,
        target: null,
        help: false,
        version: false,
        listTargets: false,
        debug: false,
        shared: false,
        static: false,
        noJslib: false,
        exports: [],
        libs: [],
        libPaths: [],
    };

    let i = 0;
    while (i < args.length) {
        const arg = args[i];

        if (arg === "-h" || arg === "--help") {
            result.help = true;
        } else if (arg === "-v" || arg === "--version") {
            result.version = true;
        } else if (arg === "--list-targets") {
            result.listTargets = true;
        } else if (arg === "--debug") {
            result.debug = true;
        } else if (arg === "--shared") {
            result.shared = true;
        } else if (arg === "--static") {
            result.static = true;
        } else if (arg === "--no-jslib") {
            result.noJslib = true;
        } else if (arg === "-o" || arg === "--output") {
            i++;
            result.output = args[i];
        } else if (arg === "--os") {
            i++;
            result.os = args[i];
        } else if (arg === "--arch") {
            i++;
            result.arch = args[i];
        } else if (arg === "-t" || arg === "--target") {
            i++;
            result.target = args[i];
        } else if (arg === "--export") {
            i++;
            result.exports.push(args[i]);
        } else if (arg === "--lib" || arg === "-l") {
            i++;
            result.libs.push(args[i]);
        } else if (arg === "--lib-path" || arg === "-L") {
            i++;
            result.libPaths.push(args[i]);
        } else if (!arg.startsWith("-")) {
            result.input = arg;
        } else {
            console.error(`Unknown option: ${arg}`);
            process.exit(1);
        }
        i++;
    }

    return result;
}

function main() {
    const args = process.argv.slice(2);

    // `run` 子命令:执行而非编译（静默编译临时二进制后直接跑）
    if (args[0] === "run") {
        runSubcommand(args.slice(1));
        return;
    }

    const opts = parseArgs(args);

    if (opts.help) {
        printUsage();
        process.exit(0);
    }

    if (opts.version) {
        console.log(`asm.js ${VERSION}`);
        process.exit(0);
    }

    if (opts.listTargets) {
        console.log("Supported targets:");
        for (const target of listTargets()) {
            console.log(`  ${target}`);
        }
        process.exit(0);
    }

    if (!opts.input) {
        console.error("Error: No input file specified");
        printUsage();
        process.exit(1);
    }

    // 解析输入文件路径（支持相对路径）
    const inputFile = resolve(process.cwd(), opts.input);

    if (!existsSync(inputFile)) {
        console.error(`Error: Input file not found: ${inputFile}`);
        process.exit(1);
    }

    // 确定目标平台
    let target;
    if (opts.target) {
        target = opts.target;
    } else if (opts.os && opts.arch) {
        target = `${opts.os}-${opts.arch}`;
    } else if (opts.os || opts.arch) {
        const detected = detectPlatform();
        const [detectedOs, detectedArch] = detected.split("-");
        target = `${opts.os || detectedOs}-${opts.arch || detectedArch}`;
    } else {
        target = detectPlatform();
    }

    // 验证目标
    try {
        resolveTarget(target);
    } catch (e) {
        console.error(`Error: ${e.message}`);
        console.log("Use --list-targets to see supported targets");
        process.exit(1);
    }

    // 确定输出文件名
    let output = opts.output;
    if (!output) {
        // 默认输出文件名：去掉 .js 后缀，使用输入文件的目录
        const inputDir = dirname(inputFile);
        const inputBase = basename(inputFile, ".js");

        // 根据输出类型添加适当的后缀
        if (opts.shared) {
            const ext = target.startsWith("macos") ? ".dylib" : target.startsWith("windows") ? ".dll" : ".so";
            output = join(inputDir, `lib${inputBase}${ext}`);
        } else if (opts.static) {
            const ext = target.startsWith("windows") ? ".lib" : ".a";
            output = join(inputDir, `lib${inputBase}${ext}`);
        } else {
            output = join(inputDir, `${inputBase}-${target}`);
        }
    } else {
        // 解析输出路径
        output = resolve(process.cwd(), output);
    }

    // 添加 Windows 的 .exe 后缀（仅可执行文件）
    if (!opts.shared && !opts.static && target.includes("windows") && !output.endsWith(".exe")) {
        output += ".exe";
    }

    // 确定输出类型描述
    let outputTypeDesc = "executable";
    if (opts.shared) outputTypeDesc = "shared library";
    if (opts.static) outputTypeDesc = "static library";

    console.log(`Compiling ${inputFile} -> ${output} (${target}, ${outputTypeDesc})`);

    try {
        const compiler = new Compiler(target);

        // 设置源文件路径（用于解析相对路径的 jslib）
        compiler.setSourcePath(inputFile);

        // 设置编译选项
        if (opts.shared) {
            compiler.setOutputType("shared");
        } else if (opts.static) {
            compiler.setOutputType("static");
        }

        // 设置 jslib 生成选项
        if (opts.noJslib) {
            compiler.setOption("noJslib", true);
        }

        // 添加导出符号
        for (const exp of opts.exports) {
            compiler.addExport(exp);
        }

        // 添加库链接
        for (const lib of opts.libs) {
            compiler.addLibrary(lib);
        }

        // 添加库搜索路径
        for (const libPath of opts.libPaths) {
            compiler.addLibraryPath(libPath);
        }

        compiler.compileFile(inputFile, output);
        console.log(`Successfully compiled: ${output}`);
    } catch (e) {
        console.error(`Compilation error: ${e.message}`);
        if (opts.debug || process.env.DEBUG) {
            console.error(e.stack);
        }
        process.exit(1);
    }
}

main();
