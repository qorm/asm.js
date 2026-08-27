// Node 驱动下的 Compiler.compileFile action-cache 适配层。
// tests/test262/compile-job.mjs 会可选加载此模块；导入即安装一次包装，不要求 runner
// 知道缓存实现细节。核心存储实现保持在 cache/action-cache.js。
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { Compiler, TARGETS } from "./index.js";
import { ActionCache } from "./cache/action-cache.js";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let mostRecentCacheHit = null;

function outputFilesFor(compiler, outputFile) {
    const files = [outputFile];
    if ((compiler.outputType === "shared" || compiler.outputType === "static") &&
        !compiler.options.noJslib) {
        let libName = path.basename(outputFile);
        if (libName.startsWith("lib")) libName = libName.substring(3);
        const dot = libName.lastIndexOf(".");
        if (dot !== -1) libName = libName.substring(0, dot);
        files.push(path.join(path.dirname(outputFile), libName + ".jslib"));
    }
    return files;
}

export function installCompilerActionCache() {
    if (Compiler.prototype._asmjsActionCacheWrapped) return;
    const compileFileUncached = Compiler.prototype.compileFile;

    Compiler.prototype.compileFile = function (inputFile, outputFile) {
        const resolvedOutput = outputFile || (path.basename(inputFile, ".js") +
            TARGETS[this.target].ext);
        const outputs = outputFilesFor(this, resolvedOutput);
        const cache = new ActionCache({ repositoryRoot });
        const cacheResult = cache.run({
            inputFile,
            outputFiles: outputs,
            target: this.target,
            outputType: this.outputType,
            // test262 的源码文件位于带 PID 的临时目录；逻辑测试路径才是稳定 action
            // identity。普通 CLI 不设置此选项，仍按真实路径跟踪相对导入/CJS 语义。
            inputIdentity: this.options.actionCacheInputIdentity,
            outputIdentity: this.options.actionCacheInputIdentity
                ? "test262:" + this.options.actionCacheInputIdentity
                : undefined,
            compilerOptions: {
                options: {
                    ...this.options,
                    // identity 已作为独立 key 字段编码，避免重复但保持其余选项稳定。
                    actionCacheInputIdentity: undefined,
                },
                libraries: this.libraries,
                libraryPaths: this.libraryPaths,
            },
            exports: this.exports,
            compile: () => compileFileUncached.call(this, inputFile, outputFile),
            getInputs: () => (typeof this.getCacheInputs === "function"
                ? this.getCacheInputs()
                : []),
        });
        mostRecentCacheHit = cacheResult.hit;
        const compileResult = cacheResult.result;
        const base = compileResult && typeof compileResult === "object" ? compileResult : {};
        return {
            ...base,
            output: base.output || resolvedOutput,
            size: base.size === undefined ? fs.statSync(resolvedOutput).size : base.size,
            cacheHit: cacheResult.hit,
            cache: {
                hit: cacheResult.hit,
                key: cacheResult.key,
                buildId: cacheResult.buildId,
            },
        };
    };
    Object.defineProperty(Compiler.prototype, "_asmjsActionCacheWrapped", {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false,
    });
}

export function lastCacheHit() {
    return mostRecentCacheHit;
}

export const getLastCacheHit = lastCacheHit;
export const peekCacheHit = lastCacheHit;

installCompilerActionCache();
