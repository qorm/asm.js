// compiler/modules/shim-triggers.js
// Source-text scanners that decide whether to inject synthesized shims
// (__regexp_shim / __json_shim / __eval_shim) and related bootstrap gates.
// Pure functions over source strings — no Compiler instance, no fs.
// Extracted from compiler/index.js (P2.a) with zero semantic change.
// These run inside gen1: hand-written char scanners only, NO regex literals.

// 文件头是否已有 `import … from "<shimName>"`(用户手写或先前 inject)。
// 只扫 shebang 后连续的 import/注释,遇首个非 import 语句即停——避免把注释里的
// `from "__json_shim"` 示例串当成已注入(index.js 注释曾因此挡住真 JSON.stringify 注入)。
export function sourceHasTopShimImport(src, shimName) {
    const n = src.length;
    let i = 0;
    if (src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) {
        while (i < n && src.charCodeAt(i) !== 10) i++;
        if (i < n) i++;
    }
    const dq = '"' + shimName + '"';
    const sq = "'" + shimName + "'";
    while (i < n) {
        while (i < n) {
            const c = src.charCodeAt(i);
            if (c === 32 || c === 9 || c === 10 || c === 13) i++;
            else break;
        }
        if (i >= n) return false;
        if (src.charCodeAt(i) === 47 && i + 1 < n) {
            const c2 = src.charCodeAt(i + 1);
            if (c2 === 47) {
                i += 2;
                while (i < n && src.charCodeAt(i) !== 10) i++;
                continue;
            }
            if (c2 === 42) {
                i += 2;
                while (i + 1 < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) i++;
                i += 2;
                continue;
            }
        }
        if (i + 6 <= n && src.charCodeAt(i) === 105 && src.charCodeAt(i + 1) === 109 &&
            src.charCodeAt(i + 2) === 112 && src.charCodeAt(i + 3) === 111 &&
            src.charCodeAt(i + 4) === 114 && src.charCodeAt(i + 5) === 116) {
            const after = i + 6 < n ? src.charCodeAt(i + 6) : 0;
            // import / import{/import"
            if (after === 32 || after === 9 || after === 10 || after === 13 ||
                after === 123 || after === 34 || after === 39 || after === 42) {
                let j = i + 6;
                while (j < n && src.charCodeAt(j) !== 10) j++;
                const line = src.slice(i, j);
                if (line.indexOf(dq) !== -1 || line.indexOf(sq) !== -1) return true;
                i = j < n ? j + 1 : n;
                continue;
            }
        }
        return false;
    }
    return false;
}

// [W-35 Unicode 属性表按需发射] 判断源码里是否出现「反斜杠 + p/P」这两个字符的
// 相邻序列(不区分它出现在正则字面量、字符串字面量还是注释里)。__regexp_shim 的
// Unicode 属性表(__RE_UT 及四张名字表)约 84KB,只有真正用到属性转义的程序才需要;
// 本函数是「是否可能用到」的**保守**判定:宁可误报(白留表,纯体积)也不可漏报。
// 故意不跳字符串/注释、也不做转义配对:
//   /\p{L}/u                → 源码有 \ p             命中
//   new RegExp("\\p{L}","u") → 源码有 \ \ p(后一对) 命中
//   注释里写 \p             → 命中(误报,无害)
// 唯一漏得掉的是把 "\" 与 "p" 分开再拼起来的动态模式(见 readModuleSource 注释)。
// 手写扫描,不用正则(本代码在 gen1 运行,§1.6 禁正则)。
export function sourceHasPropEscapeText(src) {
    // indexOf 替代逐字节扫描(语义同:存在 \p / \P 子串)
    return src.indexOf("\\p") !== -1 || src.indexOf("\\P") !== -1;
}

// [W-35] __regexp_shim 里那几张 Unicode 属性表的变量名(值被整串置空即省掉表体)。
export function isUniTableVarName(name) {
    return name === "__RE_UT" || name === "__RE_UN_GC" || name === "__RE_UN_BIN" ||
           name === "__RE_UN_SC" || name === "__RE_UN_SCX";
}

// [批次D] 判断源码是否含正则字面量 token。手写字符扫描(不跑 Lexer 全量、
// 不用正则——本代码在 gen1 运行,§1.6 禁正则):跳过字符串/模板/注释,
// 遇 "/" 时按前一个有效字符判定除法还是正则起始(与 Lexer 的启发式同源),
// 并要求同一行内有闭合 "/"(尊重字符类内的 "/")。宁可误报(多注入一个未用
// shim 无害),不可漏报。
export function sourceHasRegexLiteral(src) {
    const n = src.length;
    let i = 0;
    let prevEnd = -1; // 最近一个有效字符下标;-1=开头,-2=字符串字面量结尾(后随 / 是除法)
    if (src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) { // shebang 行跳过
        while (i < n && src.charCodeAt(i) !== 10) i++;
    }
    while (i < n) {
        const c = src.charCodeAt(i);
        if (c === 39 || c === 34 || c === 96) { // ' " `
            const q = c;
            i++;
            while (i < n) {
                const d = src.charCodeAt(i);
                if (d === 92) { i += 2; continue; } // 转义
                if (d === q) break;
                if (q !== 96 && d === 10) break; // 普通串不跨行
                i++;
            }
            i++;
            prevEnd = -2;
            continue;
        }
        if (c === 47) { // '/'
            const c2 = i + 1 < n ? src.charCodeAt(i + 1) : 0;
            if (c2 === 47) { // 行注释
                i += 2;
                while (i < n && src.charCodeAt(i) !== 10) i++;
                continue;
            }
            if (c2 === 42) { // 块注释
                i += 2;
                while (i + 1 < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) i++;
                i += 2;
                continue;
            }
            if (regexCanStartAfter(src, prevEnd) && scanRegexLiteralBody(src, i)) {
                return true;
            }
            prevEnd = i; // 除法算符
            i++;
            continue;
        }
        if (c !== 32 && c !== 9 && c !== 13 && c !== 10) prevEnd = i;
        i++;
    }
    return false;
}

// 行首 import/export 判定（等价 /(^|\n)\s*(?:import|export)\b/）。
// 手写扫描：禁止在 toolchain 源里用正则字面量——自举时 toolchain 路径跳过
// __regexp_shim 注入,真实 /re/.test 会改派到未绑定的 __RE_test,gen1 一跑就
// ReferenceError（2026-09-12 P0.7 根因）。
export function sourceHasLineLeadingImportExport(src) {
    const n = src.length;
    let i = 0;
    if (n >= 2 && src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) {
        while (i < n && src.charCodeAt(i) !== 10) i++;
    }
    let atLineStart = true;
    while (i < n) {
        const c = src.charCodeAt(i);
        if (c === 10) { atLineStart = true; i++; continue; }
        if (c === 32 || c === 9 || c === 13) { i++; continue; }
        if (atLineStart) {
            // "import" / "export" 均为 6 字节
            if (i + 6 <= n) {
                const c0 = src.charCodeAt(i);
                let hit = false;
                if (c0 === 105) { // 'i'
                    hit = src.charCodeAt(i + 1) === 109 && src.charCodeAt(i + 2) === 112 &&
                        src.charCodeAt(i + 3) === 111 && src.charCodeAt(i + 4) === 114 &&
                        src.charCodeAt(i + 5) === 116;
                } else if (c0 === 101) { // 'e'
                    hit = src.charCodeAt(i + 1) === 120 && src.charCodeAt(i + 2) === 112 &&
                        src.charCodeAt(i + 3) === 111 && src.charCodeAt(i + 4) === 114 &&
                        src.charCodeAt(i + 5) === 116;
                }
                if (hit) {
                    const next = i + 6 < n ? src.charCodeAt(i + 6) : 0;
                    const isIdent = (next >= 48 && next <= 57) || (next >= 65 && next <= 90) ||
                        (next >= 97 && next <= 122) || next === 95 || next === 36;
                    if (!isIdent) return true;
                }
            }
            atLineStart = false;
        }
        i++;
    }
    return false;
}

// "/" 出现在 prevEnd 之后,能否是正则起始?(值结尾 → 除法;算符/开头 → 正则)

export function regexCanStartAfter(src, prevEnd) {
    if (prevEnd === -2) return false; // 字符串字面量之后 → 除法
    if (prevEnd < 0) return true; // 文件开头
    const p = src.charCodeAt(prevEnd);
    if (p === 41 || p === 93 || p === 125) return false; // ) ] } 之后按除法(保守)
    const isIdent = (p >= 48 && p <= 57) || (p >= 65 && p <= 90) ||
        (p >= 97 && p <= 122) || p === 95 || p === 36;
    if (!isIdent) return true; // 运算符、逗号、( [ { ; : ! ? = 等
    // 标识符/数字结尾:仅关键字之后允许正则(return /x/ 等)
    let s = prevEnd;
    while (s > 0) {
        const q = src.charCodeAt(s - 1);
        if ((q >= 48 && q <= 57) || (q >= 65 && q <= 90) ||
            (q >= 97 && q <= 122) || q === 95 || q === 36) s--;
        else break;
    }
    const w0 = src.charCodeAt(s);
    if (w0 >= 48 && w0 <= 57) return false; // 数字字面量 → 除法
    // `src` is scanned in UTF-8 byte offsets while public `slice` follows
    // UTF-16 units.  Compare the ASCII keyword directly at the byte range so
    // a non-ASCII prefix cannot shift the extracted token and hide a regex.
    const end = prevEnd + 1;
    const len = end - s;
    // Narrow by token length first: most identifiers take the cheap default
    // path without invoking the byte comparator repeatedly.
    if (len === 2) {
        return sourceByteEquals(src, s, end, "in") ||
            sourceByteEquals(src, s, end, "of") ||
            sourceByteEquals(src, s, end, "do");
    }
    if (len === 3) return sourceByteEquals(src, s, end, "new");
    if (len === 4) {
        return sourceByteEquals(src, s, end, "case") ||
            sourceByteEquals(src, s, end, "void") ||
            sourceByteEquals(src, s, end, "else");
    }
    if (len === 5) {
        return sourceByteEquals(src, s, end, "throw") ||
            sourceByteEquals(src, s, end, "yield") ||
            sourceByteEquals(src, s, end, "await");
    }
    if (len === 6) {
        return sourceByteEquals(src, s, end, "return") ||
            sourceByteEquals(src, s, end, "typeof") ||
            sourceByteEquals(src, s, end, "delete");
    }
    if (len === 10) return sourceByteEquals(src, s, end, "instanceof");
    return false;
}

// 从 "/"(下标 i)起,同一行内是否有形如正则字面量的闭合体
export function scanRegexLiteralBody(src, i) {
    const n = src.length;
    let j = i + 1;
    let inClass = false;
    let any = false;
    while (j < n) {
        const c = src.charCodeAt(j);
        if (c === 10) return false; // 正则不跨行
        if (c === 92) { // 转义
            j += 2;
            any = true;
            continue;
        }
        if (c === 91) inClass = true;
        else if (c === 93) inClass = false;
        else if (c === 47 && !inClass) return any; // 闭合(体非空;// 已被注释分支排除)
        any = true;
        j++;
    }
    return false;
}

// `new RegExp` 无括号(ASI:`new RegExp;` / 换行)也须注入 shim。此前只认
// `new RegExp(`，test262 `var __re = new RegExp;` 不注入 → __RE_new 未链入，
// 构造落空对象，String.prototype.split 全挂。跳过字符串/注释(同 sourceHasRegExpCall)。
export function sourceHasBareNewRegExp(src) {
    const newKw = "new";
    const reKw = "Reg" + "Exp";
    const n = src.length;
    let i = 0;
    let inTplText = false;
    const tplBrace = [];
    let brace = 0;
    if (src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) {
        while (i < n && src.charCodeAt(i) !== 10) i++;
    }
    while (i < n) {
        const c = src.charCodeAt(i);
        if (inTplText) {
            if (c === 92) { i += 2; continue; }
            if (c === 96) { inTplText = false; i++; continue; }
            if (c === 36 && i + 1 < n && src.charCodeAt(i + 1) === 123) {
                inTplText = false;
                tplBrace.push(brace);
                brace++;
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        if (c === 96) { inTplText = true; i++; continue; }
        if (c === 39 || c === 34) {
            const q = c;
            i++;
            while (i < n) {
                const d = src.charCodeAt(i);
                if (d === 92) { i += 2; continue; }
                if (d === q) { i++; break; }
                i++;
            }
            continue;
        }
        if (c === 47) {
            const c2 = i + 1 < n ? src.charCodeAt(i + 1) : 0;
            if (c2 === 47) {
                i += 2;
                while (i < n && src.charCodeAt(i) !== 10) i++;
                continue;
            }
            if (c2 === 42) {
                i += 2;
                while (i + 1 < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) i++;
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        if (c === 123) { brace++; i++; continue; }
        if (c === 125) {
            brace--;
            if (tplBrace.length > 0 && tplBrace[tplBrace.length - 1] === brace) {
                tplBrace.pop();
                inTplText = true;
            }
            i++;
            continue;
        }
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36) {
            const s = i;
            while (i < n) {
                const d = src.charCodeAt(i);
                if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) ||
                    (d >= 97 && d <= 122) || d === 95 || d === 36) i++;
                else break;
            }
            if (i - s === newKw.length && sourceByteEquals(src, s, i, newKw)) {
                let j = i;
                while (j < n) {
                    const w = src.charCodeAt(j);
                    if (w === 32 || w === 9 || w === 13 || w === 10) j++;
                    else break;
                }
                if (j + reKw.length <= n && sourceByteEquals(src, j, j + reKw.length, reKw)) {
                    const after = j + reKw.length < n ? src.charCodeAt(j + reKw.length) : 0;
                    if (!((after >= 48 && after <= 57) || (after >= 65 && after <= 90) ||
                          (after >= 97 && after <= 122) || after === 95 || after === 36)) {
                        return true;
                    }
                }
            }
            continue;
        }
        if (c >= 48 && c <= 57) {
            while (i < n) {
                const d = src.charCodeAt(i);
                if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) ||
                    (d >= 97 && d <= 122) || d === 95 || d === 46) i++;
                else break;
            }
            continue;
        }
        i++;
    }
    return false;
}

// 源码是否含**调用形式**的 RegExp(...)(无 new)。手写扫描,不用正则(§1.6);
// 只在「代码位置」按整词匹配,故:
//   - myRegExp( / xRegExp( 不命中(标识符整词读出后比较,天然带词边界);
//   - 注释与字符串/模板文本里的 "RegExp(" 不命中(编译器自身 types.js、
//     functions.js 的中文注释里就有这串,裸 indexOf 会让自举白注入 shim);
//   - 模板替换 ${...} 内部按代码扫(`${RegExp("a")}` 仍命中,漏报比误报更糟)。
// `new RegExp(` 也会命中,但那条路径已被 reCtorText 覆盖,重复无害。
// 调用点仅在源码无正则字面量时才到达(见 readModuleSource 的 || 顺序),故
// "/" 一律按行注释/块注释/除法处理,不必再做正则字面量启发式。

// Compare an ASCII token against a source buffer whose indices are byte
// offsets.  The self-hosted compiler stores source as latin1/UTF-8 bytes;
// avoid `slice` (public String methods count UTF-16 units on non-ASCII data).
export function sourceByteEquals(src, start, end, token) {
    if (end - start !== token.length) return false;
    for (let k = 0; k < token.length; k++) {
        if (src.charCodeAt(start + k) !== token.charCodeAt(k)) return false;
    }
    return true;
}

export function sourceHasJsonShimTrigger(src, byteLength) {
    // In native builds `src.length` counts decoded UTF-16 units, but all
    // offsets below are byte-oriented (see sourceByteEquals).  Use the
    // readFileSync byte hint whenever available; host Node has no hint and
    // continues to use its ordinary string length.
    const n = byteLength !== undefined ? byteLength : src.length;
    let i = 0;
    let inTplText = false;
    const tplBrace = [];
    let brace = 0;
    let hit = null;
    let hasRaw = false;
    if (src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) {
        while (i < n && src.charCodeAt(i) !== 10) i++;
    }
    while (i < n) {
        const c = src.charCodeAt(i);
        if (inTplText) {
            if (c === 92) { i += 2; continue; }
            if (c === 96) { inTplText = false; i++; continue; }
            if (c === 36 && i + 1 < n && src.charCodeAt(i + 1) === 123) {
                inTplText = false;
                tplBrace.push(brace);
                brace++;
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        if (c === 96) { inTplText = true; i++; continue; }
        if (c === 39 || c === 34) {
            const q = c;
            i++;
            while (i < n) {
                const d = src.charCodeAt(i);
                if (d === 92) { i += 2; continue; }
                if (d === q) break;
                if (d === 10) break;
                i++;
            }
            i++;
            continue;
        }
        if (c === 47) {
            const c2 = i + 1 < n ? src.charCodeAt(i + 1) : 0;
            if (c2 === 47) {
                i += 2;
                while (i < n && src.charCodeAt(i) !== 10) i++;
                continue;
            }
            if (c2 === 42) {
                i += 2;
                while (i + 1 < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) i++;
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        if (c === 123) { brace++; i++; continue; }
        if (c === 125) {
            brace--;
            if (tplBrace.length > 0 && tplBrace[tplBrace.length - 1] === brace) {
                tplBrace.pop();
                inTplText = true;
            }
            i++;
            continue;
        }
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36) {
            const s = i;
            while (i < n) {
                const d = src.charCodeAt(i);
                if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) ||
                    (d >= 97 && d <= 122) || d === 95 || d === 36) i++;
                else break;
            }
            const len = i - s;
            let j = i;
            while (j < n) {
                const w = src.charCodeAt(j);
                if (w === 32 || w === 9 || w === 13 || w === 10) j++;
                else break;
            }
            // structuredClone(
            if (len === 15 && src.charCodeAt(s) === 115 && src.charCodeAt(s + 1) === 116 &&
                src.charCodeAt(s + 2) === 114 && src.charCodeAt(s + 3) === 117 &&
                src.charCodeAt(s + 4) === 99 && src.charCodeAt(s + 5) === 116 &&
                src.charCodeAt(s + 6) === 117 && src.charCodeAt(s + 7) === 114 &&
                src.charCodeAt(s + 8) === 101 && src.charCodeAt(s + 9) === 100 &&
                src.charCodeAt(s + 10) === 67 && src.charCodeAt(s + 11) === 108 &&
                src.charCodeAt(s + 12) === 111 && src.charCodeAt(s + 13) === 110 &&
                src.charCodeAt(s + 14) === 101) {
                if (j < n && src.charCodeAt(j) === 40) {
                    if (!hit) hit = "structuredClone(";
                }
                continue;
            }
            // JSON.stringify|parse|rawJSON|isRawJSON
            if (len === 4 && src.charCodeAt(s) === 74 && src.charCodeAt(s + 1) === 83 &&
                src.charCodeAt(s + 2) === 79 && src.charCodeAt(s + 3) === 78) {
                if (j < n && src.charCodeAt(j) === 46) {
                    j++;
                    const ps = j;
                    while (j < n) {
                        const d = src.charCodeAt(j);
                        if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) ||
                            (d >= 97 && d <= 122) || d === 95 || d === 36) j++;
                        else break;
                    }
                    // `src` is a latin1/UTF-8 byte string in gen1.  Calling
                    // the public UTF-16 `slice` here would reinterpret byte
                    // offsets after a non-ASCII literal and make an otherwise
                    // valid `JSON.stringify` token disappear.  Compare the
                    // ASCII property directly at byte offsets instead.
                    let prop = "";
                    if (sourceByteEquals(src, ps, j, "stringify")) prop = "stringify";
                    else if (sourceByteEquals(src, ps, j, "parse")) prop = "parse";
                    else if (sourceByteEquals(src, ps, j, "rawJSON")) prop = "rawJSON";
                    else if (sourceByteEquals(src, ps, j, "isRawJSON")) prop = "isRawJSON";
                    if (prop !== "") {
                        if (prop === "rawJSON" || prop === "isRawJSON") hasRaw = true;
                        if (!hit) hit = "JSON." + prop;
                    }
                }
                continue;
            }
            continue;
        }
        if (c >= 48 && c <= 57) {
            while (i < n) {
                const d = src.charCodeAt(i);
                if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) ||
                    (d >= 97 && d <= 122) || d === 95 || d === 46) i++;
                else break;
            }
            continue;
        }
        i++;
    }
    if (!hit) return false;
    return hasRaw ? "json-raw" : hit;
}

export function sourceHasEvalOrFunctionCtor(src, allowBareEval = false) {
    const n = src.length;
    let i = 0;
    let inTplText = false;
    const tplBrace = [];
    let brace = 0;
    if (src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) {
        while (i < n && src.charCodeAt(i) !== 10) i++;
    }
    while (i < n) {
        const c = src.charCodeAt(i);
        if (inTplText) {
            if (c === 92) { i += 2; continue; }
            if (c === 96) { inTplText = false; i++; continue; }
            if (c === 36 && i + 1 < n && src.charCodeAt(i + 1) === 123) {
                inTplText = false;
                tplBrace.push(brace);
                brace++;
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        if (c === 96) { inTplText = true; i++; continue; }
        if (c === 39 || c === 34) {
            const q = c;
            i++;
            while (i < n) {
                const d = src.charCodeAt(i);
                if (d === 92) { i += 2; continue; }
                if (d === q) break;
                if (q !== 96 && d === 10) break;
                i++;
            }
            i++;
            continue;
        }
        if (c === 47) {
            const c2 = i + 1 < n ? src.charCodeAt(i + 1) : 0;
            if (c2 === 47) {
                i += 2;
                while (i < n && src.charCodeAt(i) !== 10) i++;
                continue;
            }
            if (c2 === 42) {
                i += 2;
                while (i + 1 < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) i++;
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        if (c === 123) { brace++; i++; continue; }
        if (c === 125) {
            brace--;
            if (tplBrace.length > 0 && tplBrace[tplBrace.length - 1] === brace) {
                tplBrace.pop();
                inTplText = true;
            }
            i++;
            continue;
        }
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36) {
            const s = i;
            while (i < n) {
                const d = src.charCodeAt(i);
                if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) ||
                    (d >= 97 && d <= 122) || d === 95 || d === 36) i++;
                else break;
            }
            const len = i - s;
            const skipWs = (j) => {
                while (j < n) {
                    const w = src.charCodeAt(j);
                    if (w === 32 || w === 9 || w === 13 || w === 10) j++;
                    else break;
                }
                return j;
            };
            // eval( / eval)(
            if (len === 4 && src.charCodeAt(s) === 101 && src.charCodeAt(s + 1) === 118 &&
                src.charCodeAt(s + 2) === 97 && src.charCodeAt(s + 3) === 108) {
                let j = skipWs(i);
                if (j < n && src.charCodeAt(j) === 40) return true;
                if (j < n && src.charCodeAt(j) === 41) {
                    j = skipWs(j + 1);
                    if (j < n && src.charCodeAt(j) === 40) return true;
                    // Bare `eval` used as a value (most notably
                    // `factory(eval)` / `const e = eval`) must materialize
                    // the eval shim too.  Do not treat an object-literal key
                    // (`{ eval: ... }`) as a reference; `.`-qualified names
                    // are likewise handled by their own property paths.
                    if (allowBareEval) return true;
                }
                if (allowBareEval && (j >= n ||
                    (src.charCodeAt(j) !== 58 && src.charCodeAt(j) !== 46))) {
                    // Any non-call delimiter is a value position in the
                    // grammar (assignment/return/comma/semicolon/etc.).
                    // The lexical scanner has already ruled out comments and
                    // strings, so this conservative trigger is safe; local
                    // bindings still win in compileIdentifier.
                    return true;
                }
                continue;
            }
            // Function(
            if (len === 8 && src.charCodeAt(s) === 70 && src.charCodeAt(s + 1) === 117 &&
                src.charCodeAt(s + 2) === 110 && src.charCodeAt(s + 3) === 99 &&
                src.charCodeAt(s + 4) === 116 && src.charCodeAt(s + 5) === 105 &&
                src.charCodeAt(s + 6) === 111 && src.charCodeAt(s + 7) === 110) {
                let j = skipWs(i);
                if (j < n && src.charCodeAt(j) === 40) return true;
                continue;
            }
            // GeneratorFunction( / AsyncFunction( / AsyncGeneratorFunction(.
            // These are normally local aliases obtained from a specialised
            // function's `.constructor`; invoking them still requires route B.
            if (len === 17 || len === 13 || len === 22) {
                const word = src.slice(s, i);
                if (word === "GeneratorFunction" || word === "AsyncFunction" ||
                    word === "AsyncGeneratorFunction") {
                    const j = skipWs(i);
                    if (j < n && src.charCodeAt(j) === 40) return true;
                }
            }
            // new Function(
            if (len === 3 && src.charCodeAt(s) === 110 && src.charCodeAt(s + 1) === 101 &&
                src.charCodeAt(s + 2) === 119) {
                let j = skipWs(i);
                const fs = j;
                while (j < n) {
                    const d = src.charCodeAt(j);
                    if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) ||
                        (d >= 97 && d <= 122) || d === 95 || d === 36) j++;
                    else break;
                }
                if (j - fs === 8 && src.charCodeAt(fs) === 70 &&
                    src.charCodeAt(fs + 1) === 117 && src.charCodeAt(fs + 2) === 110 &&
                    src.charCodeAt(fs + 3) === 99 && src.charCodeAt(fs + 4) === 116 &&
                    src.charCodeAt(fs + 5) === 105 && src.charCodeAt(fs + 6) === 111 &&
                    src.charCodeAt(fs + 7) === 110) {
                    j = skipWs(j);
                    if (j < n && src.charCodeAt(j) === 40) return true;
                }
                continue;
            }
            continue;
        }
        if (c >= 48 && c <= 57) {
            while (i < n) {
                const d = src.charCodeAt(i);
                if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) ||
                    (d >= 97 && d <= 122) || d === 95 || d === 46) i++;
                else break;
            }
            continue;
        }
        i++;
    }
    return false;
}

export function sourceHasRegExpCall(src) {
    const target = "Reg" + "Exp"; // 拆开拼接:免得本文件自己命中
    const n = src.length;
    let i = 0;
    let inTplText = false;  // 正在扫模板字面量的文本部分(非 ${} 内)
    const tplBrace = [];    // 每层 ${ 起始时的花括号深度,用于识别配对的 }
    let brace = 0;
    if (src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) { // shebang 行跳过
        while (i < n && src.charCodeAt(i) !== 10) i++;
    }
    while (i < n) {
        const c = src.charCodeAt(i);
        if (inTplText) {
            if (c === 92) { i += 2; continue; } // 转义
            if (c === 96) { inTplText = false; i++; continue; } // ` 收尾
            if (c === 36 && i + 1 < n && src.charCodeAt(i + 1) === 123) { // ${
                inTplText = false;
                tplBrace.push(brace);
                brace++;
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        if (c === 96) { inTplText = true; i++; continue; } // 模板起始
        if (c === 39 || c === 34) { // ' "
            const q = c;
            i++;
            while (i < n) {
                const d = src.charCodeAt(i);
                if (d === 92) { i += 2; continue; }
                if (d === q) break;
                if (d === 10) break; // 普通串不跨行
                i++;
            }
            i++;
            continue;
        }
        if (c === 47) { // '/'
            const c2 = i + 1 < n ? src.charCodeAt(i + 1) : 0;
            if (c2 === 47) { // 行注释
                i += 2;
                while (i < n && src.charCodeAt(i) !== 10) i++;
                continue;
            }
            if (c2 === 42) { // 块注释
                i += 2;
                while (i + 1 < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) i++;
                i += 2;
                continue;
            }
            i++; // 除法
            continue;
        }
        if (c === 123) { brace++; i++; continue; }
        if (c === 125) {
            brace--;
            if (tplBrace.length > 0 && tplBrace[tplBrace.length - 1] === brace) {
                tplBrace.pop();
                inTplText = true; // ${} 收尾,回到模板文本
            }
            i++;
            continue;
        }
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36) {
            const s = i;
            while (i < n) {
                const d = src.charCodeAt(i);
                if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) ||
                    (d >= 97 && d <= 122) || d === 95 || d === 36) i++;
                else break;
            }
            if (i - s === target.length && sourceByteEquals(src, s, i, target)) {
                let j = i;
                while (j < n) { // 允许 RegExp ( 之间有空白
                    const w = src.charCodeAt(j);
                    if (w === 32 || w === 9 || w === 13 || w === 10) j++;
                    else break;
                }
                if (j < n && src.charCodeAt(j) === 40) return true;
                // RegExp.escape(...)：构造调用扫描看不到 `RegExp(`，但必须注入
                // __regexp_shim，否则 __RE_escape 改派/静态属性都链不上。
                if (j < n && src.charCodeAt(j) === 46) {
                    let k = j + 1;
                    while (k < n) {
                        const w = src.charCodeAt(k);
                        if (w === 32 || w === 9 || w === 13 || w === 10) k++;
                        else break;
                    }
                    if (k + 6 <= n && sourceByteEquals(src, k, k + 6, "escape")) {
                        const after = k + 6 < n ? src.charCodeAt(k + 6) : 0;
                        if (!((after >= 48 && after <= 57) || (after >= 65 && after <= 90) ||
                              (after >= 97 && after <= 122) || after === 95 || after === 36)) {
                            return true;
                        }
                    }
                    // RegExp.prototype[Symbol.*] 覆写/取值族:无字面量也须注入,
                    // 否则 String#match 走 _str_match、@@split 走空壳。只认
                    // `prototype[Symbol`——`RegExp.prototype.exec` 名/描述符测例
                    // 不得灌 360KB shim(会改 .name 并拖慢编译)。
                    if (k + 9 <= n && sourceByteEquals(src, k, k + 9, "prototype")) {
                        const after = k + 9 < n ? src.charCodeAt(k + 9) : 0;
                        if (!((after >= 48 && after <= 57) || (after >= 65 && after <= 90) ||
                              (after >= 97 && after <= 122) || after === 95 || after === 36)) {
                            // Reading/reflecting any RegExp.prototype property
                            // (including the ordinary string-named accessors
                            // source/flags/global/…) needs the real shim.  The
                            // earlier trigger only recognized
                            // `prototype[Symbol.*]`, so accessor-only tests were
                            // compiled with the placeholder getter whose
                            // synthetic helper aliases did not exist.
                            return true;
                            /* istanbul ignore next -- retained below as
                             * documentation for the old Symbol-specific scan. */
                            let p = k + 9;
                            while (p < n) {
                                const w = src.charCodeAt(p);
                                if (w === 32 || w === 9 || w === 13 || w === 10) p++;
                                else break;
                            }
                            if (p < n && src.charCodeAt(p) === 91) {
                                p++;
                                while (p < n) {
                                    const w = src.charCodeAt(p);
                                    if (w === 32 || w === 9 || w === 13 || w === 10) p++;
                                    else break;
                                }
                                if (p + 6 <= n && sourceByteEquals(src, p, p + 6, "Symbol")) return true;
                            }
                        }
                    }
                }
                // heritage 为 RegExp 标识符(`class C extends` + 该名):无调用括号
                // 也须注入,否则派生 super() 链不上 __RE_new。
                let k = s;
                while (k > 0) {
                    const w = src.charCodeAt(k - 1);
                    if (w === 32 || w === 9 || w === 13 || w === 10) k--;
                    else break;
                }
                if (k >= 7 && sourceByteEquals(src, k - 7, k, "extends")) {
                    const prev = k >= 8 ? src.charCodeAt(k - 8) : 0;
                    if (!((prev >= 48 && prev <= 57) || (prev >= 65 && prev <= 90) ||
                          (prev >= 97 && prev <= 122) || prev === 95 || prev === 36)) {
                        return true;
                    }
                }
            }
            // Symbol.search / Symbol.matchAll:无 `RegExp(` / 字面量也须注入,
            // 否则 `"ab3c".search({[Symbol.search]:null,toString:()=>"\\d"})`
            // 与 `"a1b1c".matchAll(1)` 走原生 indexOf、无 .index。
            if (i - s === 6 && sourceByteEquals(src, s, i, "Symbol")) {
                let j = i;
                while (j < n) {
                    const w = src.charCodeAt(j);
                    if (w === 32 || w === 9 || w === 13 || w === 10) j++;
                    else break;
                }
                if (j < n && src.charCodeAt(j) === 46) {
                    let k = j + 1;
                    while (k < n) {
                        const w = src.charCodeAt(k);
                        if (w === 32 || w === 9 || w === 13 || w === 10) k++;
                        else break;
                    }
                    if (k + 6 <= n && sourceByteEquals(src, k, k + 6, "search")) {
                        const after = k + 6 < n ? src.charCodeAt(k + 6) : 0;
                        if (!((after >= 48 && after <= 57) || (after >= 65 && after <= 90) ||
                              (after >= 97 && after <= 122) || after === 95 || after === 36)) {
                            return true;
                        }
                    }
                    if (k + 8 <= n && sourceByteEquals(src, k, k + 8, "matchAll")) {
                        const after = k + 8 < n ? src.charCodeAt(k + 8) : 0;
                        if (!((after >= 48 && after <= 57) || (after >= 65 && after <= 90) ||
                              (after >= 97 && after <= 122) || after === 95 || after === 36)) {
                            return true;
                        }
                    }
                    // String.prototype.replace also performs the observable
                    // GetMethod(@@replace) step.  Unlike match/search it was
                    // historically omitted from the cheap trigger to avoid
                    // broad shim injection; a real `Symbol.replace` token is
                    // unambiguous (the scanner is already skipping strings
                    // and comments), so inject the protocol shim here.
                    if (k + 7 <= n && sourceByteEquals(src, k, k + 7, "replace")) {
                        const after = k + 7 < n ? src.charCodeAt(k + 7) : 0;
                        if (!((after >= 48 && after <= 57) || (after >= 65 && after <= 90) ||
                              (after >= 97 && after <= 122) || after === 95 || after === 36)) {
                            return true;
                        }
                    }
                }
            }
            // String.prototype.match/matchAll/search calls also need the
            // RegExp shim when the source contains no regexp literal or
            // `RegExp(...)` spelling (for example `"x".matchAll(null)`).
            // Detect the call form in code, rather than key text in comments
            // or strings, so ordinary property names do not inject the large
            // shim accidentally.  A preceding dot covers direct, optional,
            // and parenthesised receivers; computed `obj["matchAll"]()` is
            // handled by the Symbol.matchAll trigger above when applicable.
            if ((i - s === 5 && sourceByteEquals(src, s, i, "match")) ||
                (i - s === 8 && sourceByteEquals(src, s, i, "matchAll")) ||
                (i - s === 6 && sourceByteEquals(src, s, i, "search"))) {
                let p = s - 1;
                while (p >= 0) {
                    const w = src.charCodeAt(p);
                    if (w === 32 || w === 9 || w === 13 || w === 10) p--;
                    else break;
                }
                if (p >= 0 && src.charCodeAt(p) === 46) {
                    let q = i;
                    while (q < n) {
                        const w = src.charCodeAt(q);
                        if (w === 32 || w === 9 || w === 13 || w === 10) q++;
                        else break;
                    }
                    if (q < n && src.charCodeAt(q) === 40) return true;
                }
            }
            continue;
        }
        if (c >= 48 && c <= 57) { // 数字:整体跳过,免得 1e5 之类被拆出标识符
            while (i < n) {
                const d = src.charCodeAt(i);
                if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) ||
                    (d >= 97 && d <= 122) || d === 95 || d === 46) i++;
                else break;
            }
            continue;
        }
        i++;
    }
    return false;
}

// 从 "/"(下标 i)起跳过正则字面量体,返回闭合 "/" 之后的下标;同一行内无合法
// 闭合(或体为空)返回 -1。规则与 scanRegexLiteralBody 一一对应(后者只判有无、
// 本函数给出终点,供 sourceHasTopLevelEsmDecl 整体跳过正则)。

export function sourceHasRegExpShimTrigger(src) {
    return sourceHasBareNewRegExp(src) || sourceHasRegExpCall(src);
}

export function skipRegexLiteralBody(src, i) {
    const n = src.length;
    let j = i + 1;
    let inClass = false;
    let any = false;
    while (j < n) {
        const c = src.charCodeAt(j);
        if (c === 10) return -1; // 正则不跨行
        if (c === 92) { j += 2; any = true; continue; } // 转义
        if (c === 91) inClass = true;
        else if (c === 93) inClass = false;
        else if (c === 47 && !inClass) return any ? j + 1 : -1; // 闭合(体非空)
        any = true;
        j++;
    }
    return -1;
}

// [CJS 误判修复] 词法感知判定:源码在**真实代码位置**是否含顶层 import/export
// 声明关键字。looksLikeCjsSource 的 ESM 判据,取代朴素子串扫描:注释/字符串/
// 模板文本/正则字面量里的 "export "/"import " 文字不算数(那些文字曾使合法 CJS
// 文件被误判为非 CJS、不做 CJS 包装,import 之运行期崩
// "FATAL: _object_set called with NULL object";Node 照常执行)。
// 手写字符扫描(§1.6 禁正则;本代码在 gen1 运行),状态机与 sourceHasRegExpCall
// 同源:字符串/模板/注释整体跳过,模板 ${} 用 tplBrace 栈归位,"/" 按
// regexCanStartAfter 启发式区分正则起始与除法。
// 语义与原扫描对齐、仅剔除字面量内误报(保守:拿不准的一律维持原判定):
//   export:花括号深度 0、前一有效字符非 "."(排除 x.export)、紧随字符
//     ∈ {空白, {, *}(export 声明的全部合法续接;export: 标签/var export 等
//     保留字误用在 Node 同为 SyntaxError,判 ESM 不算误拒);
//   import:深度 0、前一有效字符非 "."、同行前方只有空白(与原 "\nimport "
//     行首锚定一致)、跳过空白后下一字符非 "(" 非 "."(排除动态 import() 与
//     import.meta;import"x" 副作用导入仍算声明)。
// 深度 > 0 的 import/export 声明在合法 JS 中不存在;对象字面量 { export: 1 }、
// 类方法 export(){} 由深度自然排除。
// 已知偏差(与原扫描同错或更准,不劣化):非 ASCII 字节紧邻的 "export" 子串仍
// 可能误判(同原扫描);")" 之后的正则按除法处理(regexCanStartAfter 保守分支,
// 与本编译器解析器自身对 ")" 后 "/" 的处理一致,不引入新分歧)。

export function sourceHasTopLevelEsmDecl(src) {
    const n = src.length;
    let i = 0;
    let inTplText = false;  // 正在扫模板字面量的文本部分(非 ${} 内)
    const tplBrace = [];    // 每层 ${ 起始时的花括号深度,用于识别配对的 }
    let brace = 0;
    let prevEnd = -1; // 最近一个有效字符下标;-1=开头,-2=字符串/模板/正则结尾
    if (src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) { // shebang 行跳过
        while (i < n && src.charCodeAt(i) !== 10) i++;
    }
    while (i < n) {
        const c = src.charCodeAt(i);
        if (inTplText) {
            if (c === 92) { i += 2; continue; } // 转义
            if (c === 96) { inTplText = false; prevEnd = -2; i++; continue; } // ` 收尾
            if (c === 36 && i + 1 < n && src.charCodeAt(i + 1) === 123) { // ${
                inTplText = false;
                tplBrace.push(brace);
                brace++;
                i += 2;
                prevEnd = i - 1; // ${ 的 "{" 是有效字符(其后 / 按正则起始)
                continue;
            }
            i++;
            continue;
        }
        if (c === 96) { inTplText = true; i++; continue; } // 模板起始
        if (c === 39 || c === 34) { // ' "
            const q = c;
            i++;
            while (i < n) {
                const d = src.charCodeAt(i);
                if (d === 92) { i += 2; continue; }
                if (d === q) break;
                if (d === 10) break; // 普通串不跨行
                i++;
            }
            i++;
            prevEnd = -2;
            continue;
        }
        if (c === 47) { // '/'
            const c2 = i + 1 < n ? src.charCodeAt(i + 1) : 0;
            if (c2 === 47) { // 行注释
                i += 2;
                while (i < n && src.charCodeAt(i) !== 10) i++;
                continue;
            }
            if (c2 === 42) { // 块注释
                i += 2;
                while (i + 1 < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) i++;
                i += 2;
                continue;
            }
            const reEnd = regexCanStartAfter(src, prevEnd) ? skipRegexLiteralBody(src, i) : -1;
            if (reEnd > 0) { // 正则字面量:连同 flags 整体跳过
                i = reEnd;
                while (i < n) {
                    const f = src.charCodeAt(i);
                    if ((f >= 97 && f <= 122) || (f >= 65 && f <= 90)) i++;
                    else break;
                }
                prevEnd = -2;
                continue;
            }
            prevEnd = i; // 除法算符
            i++;
            continue;
        }
        if (c === 123) { brace++; prevEnd = i; i++; continue; }
        if (c === 125) {
            brace--;
            if (tplBrace.length > 0 && tplBrace[tplBrace.length - 1] === brace) {
                tplBrace.pop();
                inTplText = true; // ${} 收尾,回到模板文本
            }
            prevEnd = i;
            i++;
            continue;
        }
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36) {
            const s = i;
            while (i < n) {
                const d = src.charCodeAt(i);
                if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) ||
                    (d >= 97 && d <= 122) || d === 95 || d === 36) i++;
                else break;
            }
            if (brace === 0 && i - s === 6) {
                const prevCh = prevEnd >= 0 ? src.charCodeAt(prevEnd) : 0;
                if (prevCh !== 46) { // 非 x.export / x.import 成员访问
                    const word = src.slice(s, i);
                    if (word === "export") {
                        const f = i < n ? src.charCodeAt(i) : 0;
                        // export 声明的合法续接:空白 { *(export: 标签等排除)
                        if (f === 32 || f === 9 || f === 10 || f === 13 ||
                            f === 123 || f === 42) return true;
                    } else if (word === "import") {
                        // 行首锚定(与原 "\nimport " 语义一致):同行前方只有空白
                        let ls = s - 1;
                        let lineStart = true;
                        while (ls >= 0) {
                            const w = src.charCodeAt(ls);
                            if (w === 10) break;
                            if (w === 32 || w === 9 || w === 13) { ls--; continue; }
                            lineStart = false;
                            break;
                        }
                        if (lineStart) {
                            let j = i;
                            while (j < n) { // import 与下一 token 间允许空白
                                const w = src.charCodeAt(j);
                                if (w === 32 || w === 9 || w === 13 || w === 10) j++;
                                else break;
                            }
                            const f = j < n ? src.charCodeAt(j) : 0;
                            if (f !== 40 && f !== 46) return true; // 非 import( / import.
                        }
                    }
                }
            }
            prevEnd = i - 1;
            continue;
        }
        if (c >= 48 && c <= 57) { // 数字:整体跳过,免得 1e5 之类被拆出标识符
            while (i < n) {
                const d = src.charCodeAt(i);
                if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) ||
                    (d >= 97 && d <= 122) || d === 95 || d === 46) i++;
                else break;
            }
            prevEnd = i - 1;
            continue;
        }
        if (c !== 32 && c !== 9 && c !== 13 && c !== 10) prevEnd = i;
        i++;
    }
    return false;
}
