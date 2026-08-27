import { dirname, basename, join, resolve } from "path";
import { Compiler } from "../index.js";
import { ActionCache } from "../cache/action-cache.js";

const astCache = new Map();

if (!Compiler.prototype._asmjsAstCacheWrapped) {
    const parse = Compiler.prototype.parse;
    Compiler.prototype.parse = function (source, options) {
        if (process.env.ASMJS_AST_CACHE === "0") return parse.call(this, source, options);
        const key = (options && options.allowSuper ? "S" : "") +
            (options && options.allowNewTarget ? "N" : "") + "\0" + source;
        const cached = astCache.get(key);
        if (cached) return structuredClone(cached);
        const ast = parse.call(this, source, options);
        if (astCache.size >= 512) astCache.delete(astCache.keys().next().value);
        astCache.set(key, structuredClone(ast));
        return ast;
    };
    Object.defineProperty(Compiler.prototype, "_asmjsAstCacheWrapped", { value: true });
}

export function outputFilesForJob(job) {
    const files = [job.outputFile];
    if ((job.outputType === "shared" || job.outputType === "static") && !job.noJslib) {
        let libName = basename(job.outputFile);
        if (libName.startsWith("lib")) libName = libName.substring(3);
        const dot = libName.lastIndexOf(".");
        if (dot !== -1) libName = libName.substring(0, dot);
        files.push(join(dirname(job.outputFile), libName + ".jslib"));
    }
    return files;
}

export function compileBuildJob(job) {
    const compiler = new Compiler(job.target);
    compiler.setSourcePath(job.inputFile);
    compiler.setOutputType(job.outputType || "executable");
    if (job.noJslib) compiler.setOption("noJslib", true);
    if (job.inputIdentity) compiler.setOption("actionCacheInputIdentity", job.inputIdentity);
    for (const name of job.exports || []) compiler.addExport(name);
    const outputs = outputFilesForJob(job);
    const cache = new ActionCache({
        repositoryRoot: resolve(job.repositoryRoot || process.cwd()),
        cacheDirectory: job.cacheDirectory,
        disabled: job.noCache === true,
    });
    const result = cache.run({
        inputFile: job.inputFile,
        inputIdentity: job.inputIdentity,
        outputIdentity: job.inputIdentity ? "build:" + job.inputIdentity : undefined,
        outputFiles: outputs,
        target: job.target,
        outputType: job.outputType || "executable",
        compilerOptions: {
            options: { noJslib: !!job.noJslib },
            libraries: [],
            libraryPaths: [],
        },
        exports: job.exports || [],
        compile: () => compiler.compileFile(job.inputFile, job.outputFile),
        getInputs: () => (typeof compiler.getCacheInputs === "function"
            ? compiler.getCacheInputs()
            : []),
    });
    return {
        ok: true,
        output: job.outputFile,
        size: result.result && result.result.size,
        cacheHit: result.hit,
        cacheKey: result.key,
        buildId: result.buildId,
        disabled: result.disabled === true,
        timings: result.result && result.result.timings,
    };
}
