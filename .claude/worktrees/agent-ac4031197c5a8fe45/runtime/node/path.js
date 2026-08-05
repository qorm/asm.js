// asm.js Runtime - Node.js path
// Provides path utilities for asm.js compiled binaries

const platform = __get_process().platform || "macos";
// 分隔符统一用 "/"——asm.js 整个代码库(及自举源码)一律用正斜杠路径,Windows 文件 API
// (CreateFileA 等)也接受 "/"。原先 win32 用 "\\" 会让 dirname("a/b.js") 找不到 "\\"
// 返 "."、resolve 产出混合分隔符(".\a/b\c"),导致自举时深层导入路径被搞乱、模块解析
// 中途丢失(89 模块只发现 26)。用 "/" 使全平台路径操作一致。
const PATH_SEP = "/";

export function dirname(p) {
    if (!p) return ".";
    // 去尾部斜杠(node: dirname("/foo/bar/")==="/foo"),但纯根 "/" 保留
    let end = p.length;
    while (end > 1 && p.substring(end - 1, end) === PATH_SEP) end = end - 1;
    let i = end - 1;
    while (i >= 0 && p.substring(i, i + 1) !== PATH_SEP) i = i - 1;
    if (i < 0) return ".";
    if (i === 0) return PATH_SEP;
    return p.substring(0, i);
}

export function basename(p, ext) {
    if (!p) return "";
    // 去尾部斜杠(node: basename("/foo/bar/")==="bar")
    let end = p.length;
    while (end > 0 && p.substring(end - 1, end) === PATH_SEP) end = end - 1;
    if (end === 0) return ""; // 全是斜杠
    let i = end - 1;
    while (i >= 0 && p.substring(i, i + 1) !== PATH_SEP) i = i - 1;
    let base = p.substring(i + 1, end);
    if (ext && base.length > ext.length && base.substring(base.length - ext.length) === ext) {
        base = base.substring(0, base.length - ext.length);
    }
    return base;
}

export function extname(p) {
    if (!p) return "";
    let i = p.length - 1;
    while (i >= 0 && p.substring(i, i + 1) !== PATH_SEP && p.substring(i, i + 1) !== ".") i = i - 1;
    if (i <= 0 || p.substring(i, i + 1) !== ".") return "";
    return p.substring(i);
}

export function join(p1, p2, p3, p4, p5) {
    let res = p1 || "";
    const parts = [p2, p3, p4, p5].filter(Boolean);
    for (let part of parts) {
        if (res !== "" && res.substring(res.length - 1) !== PATH_SEP) res = res + PATH_SEP;
        // 折叠边界重复斜杠(node: join("a/","/b")==="a/b")
        while (part.length > 0 && part.charAt(0) === PATH_SEP && res.length > 0 && res.substring(res.length - 1) === PATH_SEP) {
            part = part.substring(1);
        }
        res = res + part;
    }
    // 外科式归一:仅结果含 "." 段(".."/"./"/含 "/.")时走 normalize(node 的 join
    // 全量归一;这里最小化行为面——编译器模块解析热用 join,普通路径保持逐字节旧
    // 输出以保自举定点)。文件名里的 "." (如 "index.js")不含 "/."/"./" 子串,不触发。
    // join("a/b","../c")→"a/c"、join("a","./b")→"a/b"。
    if (res.indexOf("..") !== -1 || res.indexOf("./") !== -1 || res.indexOf("/.") !== -1) {
        return normalize(res);
    }
    return res;
}

export function resolve(p1, p2, p3) {
    if (p1 && p2 && p2.startsWith("/")) return p2;
    return join(p1, p2, p3);
}

export function normalize(p) {
    if (!p) return ".";
    const isAbs = p.charAt(0) === PATH_SEP;
    const parts = p.split(PATH_SEP).filter(Boolean);
    const result = [];
    for (let part of parts) {
        if (part === "..") {
            // 相对路径保留无法消解的前导 "..";绝对路径 root/.. 归 root(丢弃)
            if (result.length > 0 && result[result.length - 1] !== "..") result.pop();
            else if (!isAbs) result.push("..");
        } else if (part !== ".") {
            result.push(part);
        }
    }
    let res = result.join(PATH_SEP);
    if (isAbs) res = PATH_SEP + res;
    return res || (isAbs ? PATH_SEP : ".");
}

export function isAbsolute(p) {
    if (!p) return false;
    if (p.startsWith("/")) return true;
    if (platform !== "win32") return false;
    // win32 盘符 "X:"(手写判定,不用正则字面量——本文件在自举模块图里,
    // 正则字面量会触发 __regexp_shim 注入进自举,见 compiler/index.js)
    if (p.length < 2 || p.charAt(1) !== ":") return false;
    const c0 = p.charCodeAt(0);
    return (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122);
}

export function relative(from, to) {
    const fromParts = normalize(from).split(PATH_SEP).filter(Boolean);
    const toParts = normalize(to).split(PATH_SEP).filter(Boolean);
    let i = 0;
    while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
    const up = fromParts.slice(i).map(() => "..");
    return [...up, ...toParts.slice(i)].join(PATH_SEP) || ".";
}

// 默认导出改**普通对象**(属性=具名函数闭包,2026-07-14):此前是类静态——
// asm.js 的通用对象方法派发(_object_get)看不见类静态,`path.join` 又与数组
// join 同名被方法派发拦截 → 用户方法分支 _object_get miss 调垃圾崩。普通对象
// 的属性即闭包,_object_get 直取,与 join 运行时 tag 派发(非数组→用户方法)
// 天然契合。定参转发(勿 rest+spread:class static (...args){f(...args)} 曾产坏值)。
const path = {
    dirname: dirname,
    basename: basename,
    extname: extname,
    join: join,
    resolve: resolve,
    normalize: normalize,
    isAbsolute: isAbsolute,
    relative: relative,
    toNamespacedPath: function (p) { return p; },
    // Node 里 path.sep / path.delimiter 是字符串属性(非函数)
    sep: PATH_SEP,
    delimiter: platform === "win32" ? ";" : ":",
    format: function (p) {
        // node 语义:dir = p.dir || p.root;base = p.base || (p.name||"")+ext。
        // 无 dir 时返 base;dir===root 时直接拼(不插分隔符),否则 dir + sep + base。
        const dir = p.dir || p.root || "";
        let ext = p.ext || "";
        if (ext && ext.charAt(0) !== ".") ext = "." + ext;
        const base = p.base || ((p.name || "") + ext);
        if (!dir) return base;
        if (dir === p.root) return dir + base;
        return dir + PATH_SEP + base;
    },
    parse: function (p) {
        // node 的键序:root, dir, base, ext, name
        return {
            root: p.startsWith("/") ? "/" : "",
            dir: dirname(p), base: basename(p),
            ext: extname(p), name: basename(p, extname(p))
        };
    },
};

export { path };
export default path;
