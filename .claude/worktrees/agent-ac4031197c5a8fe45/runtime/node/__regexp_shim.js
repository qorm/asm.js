// asm.js RegExp shim - 纯 JS 回溯式正则引擎子集(参照 __json_shim 的注入路线)。
// compiler/index.js readModuleSource 在源码含正则字面量或 "new RegExp" 时自动
// 前置 import;调用点由 compiler/functions/functions.js 改派:
//   re.test(s)         -> __RE_test(re, s)
//   re.exec(s)         -> __RE_exec(re, s)
//   str.match(re)      -> __RE_match(str, re)
//   str.replace(re, r) -> __RE_replace(str, re, r)
// 正则对象是普通对象 {source, flags, global, ignoreCase, multiline, lastIndex}
// (由 __RE_new 创建;正则字面量/new RegExp 均编译为 __RE_new 调用)。
//
// 支持: 字面字符、.、\d \w \s \D \W \S \b \B、字符类 [a-z^]、
//       量词 * + ? {n} {n,} {n,m}(贪婪 + ? 惰性)、分组 ( ) 捕获与 (?: )、
//       交替 |、锚点 ^ $、转义(\n \r \t \f \v \0 \xNN \uNNNN 及标点)、
//       lookahead (?= (?!、lookbehind (?<= (?<!(定长优先,变长近似)、
//       反向引用 \1..\9、命名组 (?<name>) + \k<name> + exec .groups、
//       flags g/i/m/s(dotAll)/y(sticky);matchAll、replace 函数参 fn(m,p1..pn,off,str)。
// 不支持(编译标记 __bad,exec 返回 null / test false / replace 原样返回):
//       unicode 属性类 \p{...}、unicode u flag(忽略未知 flag)、$10+/\10+ 两位组引用。
//
// gen1-safe 铁律:本文件会被 gen1 编译器编译——不用正则、不用解构、不用默认参数、
// 不用 getter/生成器、不用 arr.length=n 截断;仅 charCodeAt/charAt/slice/indexOf/push。
// exec 结果是"类数组普通对象"{0:..,1:..,index,input,length}(asm.js 数组不支持挂
// 自定义属性,详见提交说明)。

// ---------- 字符判定 ----------

function __re_isDigitCode(c) {
    return c >= 48 && c <= 57;
}

function __re_isWordCode(c) {
    if (c >= 48 && c <= 57) return true;
    if (c >= 65 && c <= 90) return true;
    if (c >= 97 && c <= 122) return true;
    return c === 95;
}

function __re_isSpaceCode(c) {
    // space \t \n \v \f \r + NBSP(160)
    if (c === 32 || c === 160) return true;
    return c >= 9 && c <= 13;
}

function __re_hexVal(c) {
    if (c >= 48 && c <= 57) return c - 48;
    if (c >= 97 && c <= 102) return c - 87;
    if (c >= 65 && c <= 70) return c - 55;
    return -1;
}

// ---------- pattern 解析 ----------
// 节点: {k:"char",c}  {k:"any"}  {k:"cls",neg,items:[{t:0,lo,hi}|{t:1,c:"d".."S"}]}
//       {k:"grp",idx,alts:[[node..]..]}  {k:"rep",min,max,lazy,atom}
//       {k:"bol"} {k:"eol"} {k:"wb"} {k:"nwb"}
// max === -1 表示无上界。idx === -1 表示 (?: ) 非捕获组。

// 转义解析。返回 {t:0, code} 字面码点 / {t:1, c} 类简写 / {t:2, c} 词边界;
// 失败(不支持的转义,如反向引用)置 st.err 并返回 null。
function __re_parseEscape(st, inClass) {
    if (st.i >= st.n) {
        st.err = 1;
        return null;
    }
    var ch = st.p.charAt(st.i);
    var c = st.p.charCodeAt(st.i);
    st.i = st.i + 1;
    if (ch === "d" || ch === "D" || ch === "w" || ch === "W" || ch === "s" || ch === "S") {
        return { t: 1, c: ch, code: 0 };
    }
    if (ch === "b") {
        if (inClass) return { t: 0, c: "", code: 8 }; // 类内 [\b] = 退格
        return { t: 2, c: "b", code: 0 };
    }
    if (ch === "B") {
        if (inClass) {
            st.err = 1;
            return null;
        }
        return { t: 2, c: "B", code: 0 };
    }
    if (ch === "n") return { t: 0, c: "", code: 10 };
    if (ch === "r") return { t: 0, c: "", code: 13 };
    if (ch === "t") return { t: 0, c: "", code: 9 };
    if (ch === "f") return { t: 0, c: "", code: 12 };
    if (ch === "v") return { t: 0, c: "", code: 11 };
    if (ch === "0") return { t: 0, c: "", code: 0 };
    if (ch === "x" || ch === "u") {
        var want = ch === "x" ? 2 : 4;
        var val = 0;
        var got = 0;
        while (got < want && st.i < st.n) {
            var h = __re_hexVal(st.p.charCodeAt(st.i));
            if (h < 0) break;
            val = val * 16 + h;
            st.i = st.i + 1;
            got = got + 1;
        }
        if (got !== want) {
            // \x 后非法十六进制:按字面 "x"/"u" 处理(JS 语义)
            return { t: 0, c: "", code: c };
        }
        return { t: 0, c: "", code: val };
    }
    if (ch === "p" || ch === "P") {
        st.err = 1; // unicode 属性类 \p{...} \P{...} 不支持
        return null;
    }
    if (ch === "k") {
        if (inClass) return { t: 0, c: "", code: 107, ref: 0, name: "" }; // 类内 \k = 字面 'k'
        // \k<name> 命名反向引用
        if (st.i < st.n && st.p.charAt(st.i) === "<") {
            st.i = st.i + 1;
            var nm = "";
            while (st.i < st.n && st.p.charAt(st.i) !== ">") {
                nm = nm + st.p.charAt(st.i);
                st.i = st.i + 1;
            }
            if (st.i >= st.n) {
                st.err = 1;
                return null;
            }
            st.i = st.i + 1; // 跳过 '>'
            return { t: 4, c: "", code: 0, ref: 0, name: nm };
        }
        st.err = 1;
        return null;
    }
    if (!inClass && c >= 49 && c <= 57) {
        return { t: 3, c: "", code: 0, ref: c - 48, name: "" }; // 反向引用 \1..\9
    }
    if (inClass && c >= 48 && c <= 57) {
        return { t: 0, c: "", code: c - 48 === 0 ? 0 : c }; // 类内 \1 按字面数字
    }
    return { t: 0, c: "", code: c }; // \. \/ \\ \+ 等标点字面转义
}

function __re_parseClass(st) {
    var neg = false;
    if (st.i < st.n && st.p.charAt(st.i) === "^") {
        neg = true;
        st.i = st.i + 1;
    }
    var items = [];
    while (st.i < st.n && st.p.charAt(st.i) !== "]") {
        var lo = -1;
        if (st.p.charAt(st.i) === "\\") {
            st.i = st.i + 1;
            var e = __re_parseEscape(st, true);
            if (e === null) return null;
            if (e.t === 1) {
                items.push({ t: 1, c: e.c, lo: 0, hi: 0 });
                continue; // 类简写不参与范围
            }
            lo = e.code;
        } else {
            lo = st.p.charCodeAt(st.i);
            st.i = st.i + 1;
        }
        // 范围 a-z:'-' 后面不是 ']' 且还有字符
        if (st.i + 1 < st.n && st.p.charAt(st.i) === "-" && st.p.charAt(st.i + 1) !== "]") {
            st.i = st.i + 1; // 跳过 '-'
            var hi = -1;
            if (st.p.charAt(st.i) === "\\") {
                st.i = st.i + 1;
                var e2 = __re_parseEscape(st, true);
                if (e2 === null) return null;
                if (e2.t === 1) {
                    // [a-\d]:按字面 a、-、\d 三项(近似 JS 报错行为的宽容处理)
                    items.push({ t: 0, c: "", lo: lo, hi: lo });
                    items.push({ t: 0, c: "", lo: 45, hi: 45 });
                    items.push({ t: 1, c: e2.c, lo: 0, hi: 0 });
                    continue;
                }
                hi = e2.code;
            } else {
                hi = st.p.charCodeAt(st.i);
                st.i = st.i + 1;
            }
            if (hi < lo) {
                st.err = 1;
                return null;
            }
            items.push({ t: 0, c: "", lo: lo, hi: hi });
        } else {
            items.push({ t: 0, c: "", lo: lo, hi: lo });
        }
    }
    if (st.i >= st.n) {
        st.err = 1; // 未闭合的 [
        return null;
    }
    st.i = st.i + 1; // 跳过 ']'
    return { k: "cls", neg: neg, items: items };
}

// 尝试解析 {n} {n,} {n,m}。成功返回 {min,max,end};形式不合法返回 null
// (JS 语义:不合法的 { 按字面字符匹配,不报错)。
function __re_tryParseBrace(st) {
    var j = st.i + 1; // 跳过 '{'
    var min = 0;
    var d = 0;
    var got = 0;
    while (j < st.n && __re_isDigitCode(st.p.charCodeAt(j))) {
        min = min * 10 + (st.p.charCodeAt(j) - 48);
        j = j + 1;
        got = got + 1;
    }
    if (got === 0) return null;
    if (j < st.n && st.p.charAt(j) === "}") {
        return { min: min, max: min, end: j + 1 };
    }
    if (j < st.n && st.p.charAt(j) === ",") {
        j = j + 1;
        if (j < st.n && st.p.charAt(j) === "}") {
            return { min: min, max: -1, end: j + 1 };
        }
        var max = 0;
        got = 0;
        while (j < st.n && __re_isDigitCode(st.p.charCodeAt(j))) {
            max = max * 10 + (st.p.charCodeAt(j) - 48);
            j = j + 1;
            got = got + 1;
        }
        if (got > 0 && j < st.n && st.p.charAt(j) === "}" && max >= min) {
            return { min: min, max: max, end: j + 1 };
        }
    }
    return null;
}

function __re_parseAtom(st) {
    var ch = st.p.charAt(st.i);
    if (ch === "^") {
        st.i = st.i + 1;
        return { k: "bol", fm: st.mm };
    }
    if (ch === "$") {
        st.i = st.i + 1;
        return { k: "eol", fm: st.mm };
    }
    if (ch === ".") {
        st.i = st.i + 1;
        return { k: "any", fs: st.ms };
    }
    if (ch === "[") {
        st.i = st.i + 1;
        var _cls = __re_parseClass(st);
        if (_cls !== null && _cls.k === "cls") _cls.fi = st.mi; // 内联 i 作用域烙印
        return _cls;
    }
    if (ch === "(") {
        st.i = st.i + 1;
        var idx = 0;
        var look = 0;    // 0=非断言 1=lookahead 2=lookbehind
        var lneg = false; // 否定断言
        var gname = "";   // 命名捕获组名
        var isMod = false;                 // (?flags:…) 内联修饰组
        var sMi = st.mi, sMm = st.mm, sMs = st.ms; // 修饰前的作用域快照(退出还原)
        if (st.i < st.n && st.p.charAt(st.i) === "?") {
            var c2 = st.i + 1 < st.n ? st.p.charAt(st.i + 1) : "";
            if (c2 === "i" || c2 === "m" || c2 === "s" || c2 === "-") {
                // (?flags:…) / (?flags-flags:…) 内联修饰组(ES2024):flags∈{i,m,s};
                // '-' 后为要关闭的标志。非捕获,仅在组内改 i/m/s 作用域。
                var neg = false;
                var okm = true;
                var pj = st.i + 1; // 指向 c2
                while (pj < st.n) {
                    var fc = st.p.charAt(pj);
                    if (fc === ":") break;
                    if (fc === "-") { if (neg) { okm = false; break; } neg = true; }
                    else if (fc === "i") { if (neg) st.mi = false; else st.mi = true; }
                    else if (fc === "m") { if (neg) st.mm = false; else st.mm = true; }
                    else if (fc === "s") { if (neg) st.ms = false; else st.ms = true; }
                    else { okm = false; break; }
                    pj = pj + 1;
                }
                if (!okm || pj >= st.n || st.p.charAt(pj) !== ":") {
                    st.mi = sMi; st.mm = sMm; st.ms = sMs;
                    st.err = 1;
                    return null;
                }
                st.i = pj + 1; // 跳过 ':'
                idx = -1;
                isMod = true;
            } else if (c2 === ":") {
                st.i = st.i + 2;
                idx = -1;
            } else if (c2 === "=") {
                st.i = st.i + 2;
                look = 1;
                lneg = false;
                idx = -1;
            } else if (c2 === "!") {
                st.i = st.i + 2;
                look = 1;
                lneg = true;
                idx = -1;
            } else if (c2 === "<") {
                var c3 = st.i + 2 < st.n ? st.p.charAt(st.i + 2) : "";
                if (c3 === "=") {
                    st.i = st.i + 3;
                    look = 2;
                    lneg = false;
                    idx = -1;
                } else if (c3 === "!") {
                    st.i = st.i + 3;
                    look = 2;
                    lneg = true;
                    idx = -1;
                } else {
                    // (?<name> 命名捕获组
                    st.i = st.i + 2; // 跳过 '?<'
                    var nm2 = "";
                    while (st.i < st.n && st.p.charAt(st.i) !== ">") {
                        nm2 = nm2 + st.p.charAt(st.i);
                        st.i = st.i + 1;
                    }
                    if (st.i >= st.n || nm2.length === 0) {
                        st.err = 1;
                        return null;
                    }
                    st.i = st.i + 1; // 跳过 '>'
                    st.ncap = st.ncap + 1;
                    idx = st.ncap;
                    gname = nm2;
                    // [#32] name 是用户输入,仅当确是字符串才登记(挡 constructor/toString
                    // 等原型链污染);nameList 单独存,匹配期用 typeof 守卫读取。
                    if (typeof nm2 === "string") {
                        st.names[nm2] = idx;
                        st.nameList.push({ name: nm2, idx: idx });
                    }
                }
            } else {
                st.err = 1; // (?P<...> 等其余 (? 形式不支持
                return null;
            }
        } else {
            st.ncap = st.ncap + 1;
            idx = st.ncap;
        }
        var alts = __re_parseAlts(st);
        if (isMod) { st.mi = sMi; st.mm = sMm; st.ms = sMs; } // 退出修饰组:还原作用域
        if (alts === null) return null;
        if (st.i >= st.n || st.p.charAt(st.i) !== ")") {
            st.err = 1; // 未闭合的 (
            return null;
        }
        st.i = st.i + 1;
        if (look !== 0) {
            return { k: "look", neg: lneg, behind: look === 2, alts: alts };
        }
        return { k: "grp", idx: idx, alts: alts, name: gname };
    }
    if (ch === "\\") {
        st.i = st.i + 1;
        var e = __re_parseEscape(st, false);
        if (e === null) return null;
        if (e.t === 1) {
            return { k: "cls", neg: false, items: [{ t: 1, c: e.c, lo: 0, hi: 0 }], fi: st.mi };
        }
        if (e.t === 2) {
            if (e.c === "b") return { k: "wb" };
            return { k: "nwb" };
        }
        if (e.t === 3) {
            return { k: "bref", idx: e.ref, name: "", fi: st.mi };
        }
        if (e.t === 4) {
            return { k: "bref", idx: -1, name: e.name, fi: st.mi };
        }
        return { k: "char", c: e.code, fi: st.mi };
    }
    if (ch === ")" || ch === "|" || ch === "*" || ch === "+" || ch === "?") {
        st.err = 1; // 悬空量词/括号,由上层守卫,到此即语法错
        return null;
    }
    var code = st.p.charCodeAt(st.i);
    st.i = st.i + 1;
    return { k: "char", c: code, fi: st.mi };
}

function __re_parseSeq(st) {
    var nodes = [];
    while (st.i < st.n) {
        var ch = st.p.charAt(st.i);
        if (ch === "|" || ch === ")") break;
        var atom = __re_parseAtom(st);
        if (atom === null) return null;
        // 后缀量词(至多一个,可带惰性 ?)
        if (st.i < st.n) {
            var q = st.p.charAt(st.i);
            var min = -1;
            var max = -2;
            if (q === "*") {
                min = 0;
                max = -1;
                st.i = st.i + 1;
            } else if (q === "+") {
                min = 1;
                max = -1;
                st.i = st.i + 1;
            } else if (q === "?") {
                min = 0;
                max = 1;
                st.i = st.i + 1;
            } else if (q === "{") {
                var b = __re_tryParseBrace(st);
                if (b !== null) {
                    min = b.min;
                    max = b.max;
                    st.i = b.end;
                }
            }
            if (min >= 0) {
                var lazy = false;
                if (st.i < st.n && st.p.charAt(st.i) === "?") {
                    lazy = true;
                    st.i = st.i + 1;
                }
                atom = { k: "rep", min: min, max: max, lazy: lazy, atom: atom };
            }
        }
        nodes.push(atom);
    }
    return nodes;
}

function __re_parseAlts(st) {
    var alts = [];
    var seq = __re_parseSeq(st);
    if (seq === null) return null;
    alts.push(seq);
    while (st.i < st.n && st.p.charAt(st.i) === "|") {
        st.i = st.i + 1;
        seq = __re_parseSeq(st);
        if (seq === null) return null;
        alts.push(seq);
    }
    return alts;
}

// 编译(带缓存)。不支持的语法置 __bad,之后 exec 恒 null。
function __re_compile(re) {
    if (re.__bad) return null;
    if (re.__prog !== null && re.__prog !== undefined) return re.__prog;
    var src = re.source;
    // mi/mm/ms:当前内联修饰(?i:…)作用域下 i/m/s 的覆盖(true=开、false=关、undefined=继承
    // 全局标志);解析时逐 atom 烙印,匹配时优先用 atom 的覆盖,否则用全局 mst.ic/ml/da。
    var st = { p: src, i: 0, n: src.length, ncap: 0, err: 0, names: {}, nameList: [], mi: undefined, mm: undefined, ms: undefined };
    var alts = __re_parseAlts(st);
    if (alts === null || st.err !== 0 || st.i < st.n) {
        // st.i < st.n:停在了多余的 ")" → 语法错
        re.__bad = true;
        return null;
    }
    var prog = { alts: alts, ncap: st.ncap, names: st.names, nameList: st.nameList };
    re.__prog = prog;
    return prog;
}

// ---------- 回溯匹配(CPS:cont(endPos) 返回最终终点或 -1) ----------

function __re_foldCode(c) {
    if (c >= 65 && c <= 90) return c + 32;
    return c;
}

// ic 为该处生效的 ignoreCase(atom 的内联覆盖或全局 mst.ic,由调用方算好)。
function __re_charEq(ic, pat, got) {
    if (pat === got) return true;
    if (ic) return __re_foldCode(pat) === __re_foldCode(got);
    return false;
}

function __re_clsMatch(ic, node, c) {
    var hit = false;
    var items = node.items;
    var i = 0;
    while (i < items.length) {
        var it = items[i];
        if (it.t === 0) {
            if (c >= it.lo && c <= it.hi) {
                hit = true;
                break;
            }
            if (ic) {
                // 大小写折叠:c 的另一侧大小写也算命中
                var alt = -1;
                if (c >= 97 && c <= 122) alt = c - 32;
                else if (c >= 65 && c <= 90) alt = c + 32;
                if (alt >= 0 && alt >= it.lo && alt <= it.hi) {
                    hit = true;
                    break;
                }
            }
        } else {
            var cc = it.c;
            var m = false;
            if (cc === "d") m = __re_isDigitCode(c);
            else if (cc === "D") m = !__re_isDigitCode(c);
            else if (cc === "w") m = __re_isWordCode(c);
            else if (cc === "W") m = !__re_isWordCode(c);
            else if (cc === "s") m = __re_isSpaceCode(c);
            else m = !__re_isSpaceCode(c);
            if (m) {
                hit = true;
                break;
            }
        }
        i = i + 1;
    }
    if (node.neg) return !hit;
    return hit;
}

function __re_isWordAt(mst, pos) {
    if (pos < 0 || pos >= mst.n) return false;
    return __re_isWordCode(mst.s.charCodeAt(pos));
}

// 捕获快照/还原:lookaround 与否定断言里的组在断言退出/失败时须回滚,
// 正向断言成功后其内组保留(与 JS 语义一致)。
function __re_snapCaps(mst) {
    var out = [];
    var cs = mst.capS;
    var ce = mst.capE;
    var i = 0;
    while (i < cs.length) {
        out.push(cs[i]);
        out.push(ce[i]);
        i = i + 1;
    }
    return out;
}

function __re_restCaps(mst, snap) {
    var cs = mst.capS;
    var ce = mst.capE;
    var i = 0;
    var k = 0;
    while (i < cs.length) {
        cs[i] = snap[k];
        ce[i] = snap[k + 1];
        k = k + 2;
        i = i + 1;
    }
}

// 命名反向引用的组下标解析(#32 typeof 守卫:name 命中原型链函数时退化为 -1)
function __re_resolveName(mst, name) {
    var ri = mst.names[name];
    if (typeof ri !== "number") return -1;
    return ri;
}

// !! 全部匹配函数保持 ≤4 参数:asm.js x64 后端的 P1 热槽晋升对"循环体内 ≥5 实参
// 调用且调用后还有代码"的形态会错编(晋升重放的 push/pop→mov 改写在 x64 上与
// A2/A3/A4=V2/V1/V3 寄存器别名冲突;arm64 无别名不受影响;P1_OFF=1 可复现/规避)。
// 故把 (ni,pos)/(count,pos) 打包进一个整数参数:pk = hi * 2^26 + pos。
// 代价:输入串长度上限 2^26-1(67M 字符),hi(节点下标/重复计数)同上限。
var __RE_PK = 67108864; // 2^26

function __re_mSeq(mst, nodes, pk, cont) {
    var pos = pk % __RE_PK;
    var ni = (pk - pos) / __RE_PK;
    if (ni >= nodes.length) return cont(pos);
    return __re_mNode(mst, nodes[ni], pos, function (e) {
        return __re_mSeq(mst, nodes, (ni + 1) * __RE_PK + e, cont);
    });
}

function __re_mAlts(mst, alts, pos, cont) {
    var i = 0;
    while (i < alts.length) {
        var r = __re_mSeq(mst, alts[i], pos, cont);
        if (r >= 0) return r;
        i = i + 1;
    }
    return -1;
}

function __re_mNode(mst, node, pos, cont) {
    var k = node.k;
    if (k === "char") {
        var cic = node.fi !== undefined ? node.fi : mst.ic; // 内联 i 覆盖优先
        if (pos < mst.n && __re_charEq(cic, node.c, mst.s.charCodeAt(pos))) return cont(pos + 1);
        return -1;
    }
    if (k === "cls") {
        var lic = node.fi !== undefined ? node.fi : mst.ic;
        if (pos < mst.n && __re_clsMatch(lic, node, mst.s.charCodeAt(pos))) return cont(pos + 1);
        return -1;
    }
    if (k === "any") {
        if (pos < mst.n) {
            var c = mst.s.charCodeAt(pos);
            var ada = node.fs !== undefined ? node.fs : mst.da; // 内联 s 覆盖
            // dotAll(s):. 匹配包含行终止符在内的任意字符
            if (ada) return cont(pos + 1);
            // 否则 . 不匹配行终止符(\n \r U+2028 U+2029)
            if (c !== 10 && c !== 13 && c !== 8232 && c !== 8233) return cont(pos + 1);
        }
        return -1;
    }
    if (k === "bol") {
        if (pos === 0) return cont(pos);
        var bml = node.fm !== undefined ? node.fm : mst.ml; // 内联 m 覆盖
        if (bml) {
            var pc = mst.s.charCodeAt(pos - 1);
            if (pc === 10 || pc === 13) return cont(pos);
        }
        return -1;
    }
    if (k === "eol") {
        if (pos === mst.n) return cont(pos);
        var eml = node.fm !== undefined ? node.fm : mst.ml;
        if (eml) {
            var nc = mst.s.charCodeAt(pos);
            if (nc === 10 || nc === 13) return cont(pos);
        }
        return -1;
    }
    if (k === "wb") {
        if (__re_isWordAt(mst, pos - 1) !== __re_isWordAt(mst, pos)) return cont(pos);
        return -1;
    }
    if (k === "nwb") {
        if (__re_isWordAt(mst, pos - 1) === __re_isWordAt(mst, pos)) return cont(pos);
        return -1;
    }
    if (k === "grp") {
        var idx = node.idx;
        var oldS = idx > 0 ? mst.capS[idx] : 0;
        var oldE = idx > 0 ? mst.capE[idx] : 0;
        var start = pos;
        var ai = 0;
        while (ai < node.alts.length) {
            var r = __re_mSeq(mst, node.alts[ai], start, function (e) {
                if (idx > 0) {
                    mst.capS[idx] = start;
                    mst.capE[idx] = e;
                }
                return cont(e);
            });
            if (r >= 0) return r;
            if (idx > 0) {
                mst.capS[idx] = oldS;
                mst.capE[idx] = oldE;
            }
            ai = ai + 1;
        }
        return -1;
    }
    if (k === "bref") {
        var gi = node.idx;
        if (gi < 0) gi = __re_resolveName(mst, node.name);
        // 未捕获的组(含未定义命名)按空串匹配(JS 语义)
        if (gi < 1 || mst.capS[gi] < 0) return cont(pos);
        var bs = mst.capS[gi];
        var be = mst.capE[gi];
        var blen = be - bs;
        if (pos + blen > mst.n) return -1;
        var bic = node.fi !== undefined ? node.fi : mst.ic;
        var bi = 0;
        while (bi < blen) {
            if (!__re_charEq(bic, mst.s.charCodeAt(bs + bi), mst.s.charCodeAt(pos + bi))) return -1;
            bi = bi + 1;
        }
        return cont(pos + blen);
    }
    if (k === "look") {
        var snap = __re_snapCaps(mst);
        if (node.behind) {
            // lookbehind:存在 j∈[0,pos] 使子模式恰好匹配 s[j..pos]。
            // 从 j=0 起(偏好最长左界),近似 JS 的右向贪婪;变长子模式记偏差。
            var matched = -1;
            var j = 0;
            while (j <= pos) {
                var jr = __re_mAlts(mst, node.alts, j, function (e) {
                    return e === pos ? e : -1;
                });
                if (jr >= 0) {
                    matched = jr;
                    break;
                }
                j = j + 1;
            }
            if (node.neg) {
                __re_restCaps(mst, snap); // 否定断言不保留内部捕获
                if (matched >= 0) return -1;
                return cont(pos);
            }
            if (matched < 0) {
                __re_restCaps(mst, snap);
                return -1;
            }
            var rb = cont(pos); // 零宽:位置不动,保留内部捕获
            if (rb < 0) __re_restCaps(mst, snap);
            return rb;
        }
        // lookahead
        var ar = __re_mAlts(mst, node.alts, pos, function (e) {
            return e;
        });
        if (node.neg) {
            __re_restCaps(mst, snap);
            if (ar >= 0) return -1;
            return cont(pos);
        }
        if (ar < 0) {
            __re_restCaps(mst, snap);
            return -1;
        }
        var ra = cont(pos);
        if (ra < 0) __re_restCaps(mst, snap);
        return ra;
    }
    // rep(ck 打包:count * __RE_PK + pos,此处 count=0)
    return __re_mRep(mst, node, pos, cont);
}

function __re_mRep(mst, node, ck, cont) {
    var pos = ck % __RE_PK;
    var count = (ck - pos) / __RE_PK;
    var atom = node.atom;
    if (count < node.min) {
        return __re_mNode(mst, atom, pos, function (e) {
            return __re_mRep(mst, node, (count + 1) * __RE_PK + e, cont);
        });
    }
    var canMore = node.max === -1 || count < node.max;
    if (node.lazy) {
        var r0 = cont(pos);
        if (r0 >= 0) return r0;
        if (!canMore) return -1;
        return __re_mNode(mst, atom, pos, function (e) {
            if (e === pos) return -1; // 零宽原子防死循环
            return __re_mRep(mst, node, (count + 1) * __RE_PK + e, cont);
        });
    }
    if (canMore) {
        var r = __re_mNode(mst, atom, pos, function (e) {
            if (e === pos) return -1; // 零宽原子防死循环
            return __re_mRep(mst, node, (count + 1) * __RE_PK + e, cont);
        });
        if (r >= 0) return r;
    }
    return cont(pos);
}

// ---------- 对外 API ----------

export function __RE_new(pattern, flags) {
    var src = pattern;
    var f = flags;
    if (typeof src !== "string") {
        if (src !== null && src !== undefined && typeof src.source === "string") {
            // new RegExp(re) / new RegExp(re, flags)
            if (typeof f !== "string") f = src.flags;
            src = src.source;
        } else if (src === null || src === undefined) {
            src = "";
        } else {
            src = "" + src;
        }
    }
    if (typeof f !== "string") f = "";
    return {
        source: src,
        flags: f,
        global: f.indexOf("g") !== -1,
        ignoreCase: f.indexOf("i") !== -1,
        multiline: f.indexOf("m") !== -1,
        dotAll: f.indexOf("s") !== -1,
        sticky: f.indexOf("y") !== -1,
        unicode: f.indexOf("u") !== -1,
        hasIndices: f.indexOf("d") !== -1,
        lastIndex: 0,
        __isRegExp: true,
        __prog: null,
        __bad: false,
    };
}

// exec:返回类数组对象 {0:整体, 1..n:分组(未命中 undefined), index, input, length}
// 或 null。g 标志下维护 re.lastIndex(与 JS 语义一致)。
export function __RE_exec(re, str) {
    var s = str;
    if (typeof s !== "string") s = "" + s;
    var prog = __re_compile(re);
    if (prog === null) {
        re.lastIndex = 0;
        return null;
    }
    var n = s.length;
    if (n >= __RE_PK) {
        // 超出 pk 打包上限(2^26-1 字符)的超长输入不支持(见 __RE_PK 注释)
        re.lastIndex = 0;
        return null;
    }
    var anchored = re.global || re.sticky; // lastIndex 参与匹配定位
    var start = 0;
    if (anchored) start = re.lastIndex;
    if (start < 0) start = 0;
    if (start > n) {
        re.lastIndex = 0;
        return null;
    }
    var mst = { s: s, n: n, ic: re.ignoreCase, ml: re.multiline, da: re.dotAll, names: prog.names, capS: [], capE: [] };
    var i = 0;
    while (i <= prog.ncap) {
        mst.capS.push(-1);
        mst.capE.push(-1);
        i = i + 1;
    }
    var idFn = function (e) {
        return e;
    };
    var p = start;
    while (p <= n) {
        var j = 0;
        while (j <= prog.ncap) {
            mst.capS[j] = -1;
            mst.capE[j] = -1;
            j = j + 1;
        }
        var end = __re_mAlts(mst, prog.alts, p, idFn);
        if (end >= 0) {
            if (anchored) re.lastIndex = end;
            var m = { index: p, input: s, length: prog.ncap + 1 };
            // 注意:必须用字面量下标逐个赋值——asm.js 的对象计算键赋值 m[g](g 为
            // 数值变量)有键归一化 bug(全部塌到同一槽),字面量键则正常。
            // 因此捕获组支持上限 9($1..$9,与 replace 的组引用范围一致)。
            m[0] = s.slice(p, end);
            if (prog.ncap >= 1) m[1] = __re_capVal(mst, s, 1);
            if (prog.ncap >= 2) m[2] = __re_capVal(mst, s, 2);
            if (prog.ncap >= 3) m[3] = __re_capVal(mst, s, 3);
            if (prog.ncap >= 4) m[4] = __re_capVal(mst, s, 4);
            if (prog.ncap >= 5) m[5] = __re_capVal(mst, s, 5);
            if (prog.ncap >= 6) m[6] = __re_capVal(mst, s, 6);
            if (prog.ncap >= 7) m[7] = __re_capVal(mst, s, 7);
            if (prog.ncap >= 8) m[8] = __re_capVal(mst, s, 8);
            if (prog.ncap >= 9) m[9] = __re_capVal(mst, s, 9);
            // 命名组:.groups(无命名组时为 undefined,与 JS 一致)
            if (prog.nameList.length > 0) m.groups = __re_buildGroups(mst, s, prog);
            else m.groups = undefined;
            // .slice:结果对象非真数组,挂函数属性产出真数组(闭包捕获 m);
            // 编译器 object-tag 分派把 r.slice(...) 路由到此。
            m.slice = function (a, b) { return __re_result_slice(m, a, b); };
            // d 标志:.indices —— 每组 [start,end](未命中 undefined),含 .groups(命名组)。
            if (re.hasIndices) m.indices = __re_buildIndices(mst, p, end, prog);
            return m;
        }
        if (re.sticky) break; // sticky:只在 lastIndex 处锚定,不向后扫描
        p = p + 1;
    }
    if (anchored) re.lastIndex = 0;
    return null;
}

// [start,end] 子区间(真数组,asm.js 支持嵌套数组元素)。
function __re_pair(a, b) { var r = []; r.push(a); r.push(b); return r; }
// 组 gi 的 indices 项:命中→[start,end],未命中→undefined。
function __re_indPair(mst, gi) { return mst.capS[gi] >= 0 ? __re_pair(mst.capS[gi], mst.capE[gi]) : undefined; }

// 构造 exec 结果的 .indices(d 标志)。**普通对象**(非数组:asm.js 数组无命名属性容器,
// `arr.groups=` 会崩),字面量键 0..9 + length + groups(同 m 匹配对象的伪数组模式)。
// [i]=组 i 的 [start,end] 或 undefined;.groups 为命名组名→[start,end]。
function __re_buildIndices(mst, p, end, prog) {
    var ind = { length: prog.ncap + 1 };
    ind[0] = __re_pair(p, end);
    if (prog.ncap >= 1) ind[1] = __re_indPair(mst, 1);
    if (prog.ncap >= 2) ind[2] = __re_indPair(mst, 2);
    if (prog.ncap >= 3) ind[3] = __re_indPair(mst, 3);
    if (prog.ncap >= 4) ind[4] = __re_indPair(mst, 4);
    if (prog.ncap >= 5) ind[5] = __re_indPair(mst, 5);
    if (prog.ncap >= 6) ind[6] = __re_indPair(mst, 6);
    if (prog.ncap >= 7) ind[7] = __re_indPair(mst, 7);
    if (prog.ncap >= 8) ind[8] = __re_indPair(mst, 8);
    if (prog.ncap >= 9) ind[9] = __re_indPair(mst, 9);
    if (prog.nameList.length > 0) {
        var g = {};
        var j = 0;
        while (j < prog.nameList.length) {
            var nm = prog.nameList[j].name;
            var gi = prog.nameList[j].idx;
            if (typeof nm === "string") g[nm] = __re_indPair(mst, gi);
            j = j + 1;
        }
        ind.groups = g;
    } else {
        ind.groups = undefined;
    }
    return ind;
}

// 构造 exec 结果的 .groups 字典。[#32] 名恒为字符串才落键(typeof 守卫),
// 挡 __proto__/constructor 等原型链污染。
function __re_buildGroups(mst, s, prog) {
    var g = {};
    var list = prog.nameList;
    var i = 0;
    while (i < list.length) {
        var nm = list[i].name;
        var gi = list[i].idx;
        if (typeof nm === "string") {
            var v = undefined;
            if (mst.capS[gi] >= 0) v = s.slice(mst.capS[gi], mst.capE[gi]);
            g[nm] = v;
        }
        i = i + 1;
    }
    return g;
}

function __re_capVal(mst, s, g) {
    if (mst.capS[g] >= 0) return s.slice(mst.capS[g], mst.capE[g]);
    return undefined;
}

// 用字面量下标读取组值(同上:asm.js 对象计算键 m[gi](gi 为数值变量)有 bug,
// 读也会塌到 0 号槽,必须走字面量键)
function __re_grp(m, gi) {
    switch (gi) {
        case 0: return m[0];
        case 1: return m[1];
        case 2: return m[2];
        case 3: return m[3];
        case 4: return m[4];
        case 5: return m[5];
        case 6: return m[6];
        case 7: return m[7];
        case 8: return m[8];
        case 9: return m[9];
    }
    return undefined;
}

// exec/match 结果对象(类数组普通对象)的 .slice:产出**真数组**(用字面量下标
// __re_grp 逐个读,push 进真数组),使 r.slice(1) 及其后续 .join/.map 等数组方法
// 可用。挂为对象上的函数属性;编译器把 object-tag 接收者的 .slice 分派到此用户
// 方法(见 functions.js 歧义 arr/str 分派的 object 分支)。gen1-safe:无默认参数,
// undefined 由显式判定补默认。
function __re_result_slice(m, a, b) {
    var len = m.length;
    var s = a;
    var e = b;
    if (s === undefined || s === null) s = 0;
    if (e === undefined || e === null) e = len;
    if (s < 0) s = len + s;
    if (s < 0) s = 0;
    if (s > len) s = len;
    if (e < 0) e = len + e;
    if (e < 0) e = 0;
    if (e > len) e = len;
    var out = [];
    var i = s;
    while (i < e) {
        out.push(__re_grp(m, i));
        i = i + 1;
    }
    return out;
}

export function __RE_test(re, str) {
    return __RE_exec(re, str) !== null;
}

// RegExp.prototype.toString → "/source/flags"。显式传 re(不依赖 this 绑定,asm.js
// 对象方法 this 布局敏感)。供 re.toString()/String(re) 的编译期分派调用。
export function __RE_toString(re) {
    if (re === null || re === undefined || typeof re.source !== "string") return "" + re;
    return "/" + re.source + "/" + re.flags;
}

// str.search(re):首个匹配的下标(无命中 -1)。规范:忽略 lastIndex,恒从 0 起搜、
// 不改 re.lastIndex。string 参转字面正则(同 __RE_match)。
export function __RE_search(str, re) {
    if (typeof re === "string") re = __RE_new(re, "");
    var saved = re.lastIndex;
    re.lastIndex = 0;
    var m = __RE_exec(re, str);
    re.lastIndex = saved;
    return m === null ? -1 : m.index;
}

// str.match(re):非 g 同 exec;g 收集全部整体匹配(字符串数组),无命中 null。
export function __RE_match(str, re) {
    if (typeof re === "string") re = __RE_new(re, "");
    if (!re.global) return __RE_exec(re, str);
    var out = [];
    re.lastIndex = 0;
    while (true) {
        var m = __RE_exec(re, str);
        if (m === null) break;
        out.push(m[0]);
        if (m[0] === "") re.lastIndex = re.lastIndex + 1; // 空匹配前进防死循环
    }
    re.lastIndex = 0;
    if (out.length === 0) return null;
    return out;
}

// 替换串展开:$$ $& $` $' $1..$99
function __re_expand(m, repl, s) {
    var out = "";
    var i = 0;
    var n = repl.length;
    while (i < n) {
        var ch = repl.charAt(i);
        if (ch === "$" && i + 1 < n) {
            var c2 = repl.charAt(i + 1);
            if (c2 === "$") {
                out = out + "$";
                i = i + 2;
                continue;
            }
            if (c2 === "&") {
                out = out + m[0];
                i = i + 2;
                continue;
            }
            if (c2 === "`") {
                out = out + s.slice(0, m.index);
                i = i + 2;
                continue;
            }
            if (c2 === "'") {
                out = out + s.slice(m.index + m[0].length);
                i = i + 2;
                continue;
            }
            if (c2 === "<") {
                // $<name> 命名组引用。[#32] typeof 守卫:名命中原型链函数则不展开。
                var gt = i + 2;
                var gnm = "";
                while (gt < n && repl.charAt(gt) !== ">") {
                    gnm = gnm + repl.charAt(gt);
                    gt = gt + 1;
                }
                if (gt < n) {
                    var gv = undefined;
                    if (m.groups !== undefined && m.groups !== null) gv = m.groups[gnm];
                    if (typeof gv === "string") out = out + gv;
                    i = gt + 1;
                    continue;
                }
            }
            var d = repl.charCodeAt(i + 1) - 48;
            if (d >= 1 && d <= 9) {
                // 组引用 $1..$9(捕获组上限 9,见 __RE_exec 的字面量键说明;
                // $10..$99 不支持——两位数会按 "$1" + 字面数字处理)
                if (d < m.length) {
                    var v = __re_grp(m, d);
                    if (v !== undefined && v !== null) out = out + v;
                    i = i + 2;
                    continue;
                }
            }
        }
        out = out + ch;
        i = i + 1;
    }
    return out;
}

// 函数替换参:以 (match, p1..pn, offset, string) 调用 fn,返回值转字符串。
function __re_callRepl(fn, m, s) {
    var args = [];
    args.push(m[0]);
    var gc = m.length - 1; // 捕获组数
    var gi = 1;
    while (gi <= gc) {
        args.push(__re_grp(m, gi)); // 未命中组传 undefined(与 JS 一致)
        gi = gi + 1;
    }
    args.push(m.index);
    args.push(s);
    // 命名组存在时,replacer 末参为 groups 对象(node 语义);无命名组则不传。
    if (m.groups !== undefined) args.push(m.groups);
    // asm.js 直接调用支持 6 位置实参,而 fn.apply 仅透 5(调用 ABI);groups 是**末参**,故
    // ≤6 实参(捕获组 ≤2 的命名组场景)走直接调用让 groups 到位。>6(捕获组 ≥3)才回退
    // apply,此时 groups 溢出丢弃(6 参 ABI 限,记偏差)。
    var r;
    if (args.length <= 6) {
        r = fn(args[0], args[1], args[2], args[3], args[4], args[5]);
    } else {
        r = fn.apply(null, args);
    }
    return "" + r; // String(r):undefined→"undefined"、数字→十进制串
}

// str.replace(re, 替换串|函数)。替换串支持 $$ $& $` $' $1..$9 $<name>;
// 函数参走 __re_callRepl。
export function __RE_replace(str, re, repl) {
    var s = str;
    if (typeof s !== "string") s = "" + s;
    if (typeof re === "string") {
        // 防御:字符串 search 本应走原生 _str_replace 路径
        return s;
    }
    var isFn = typeof repl === "function";
    if (!isFn && typeof repl !== "string") return s;
    var prog = __re_compile(re);
    if (prog === null) return s;
    var out = "";
    var last = 0;
    if (re.global) re.lastIndex = 0;
    while (true) {
        var m = __RE_exec(re, s);
        if (m === null) break;
        var piece = isFn ? __re_callRepl(repl, m, s) : __re_expand(m, repl, s);
        out = out + s.slice(last, m.index) + piece;
        last = m.index + m[0].length;
        if (!re.global) break;
        if (m[0] === "") re.lastIndex = re.lastIndex + 1; // 空匹配前进防死循环
    }
    if (re.global) re.lastIndex = 0;
    out = out + s.slice(last);
    return out;
}

// str.matchAll(re):返回全部匹配对象组成的数组(近似——JS 返回迭代器,
// 这里返回数组,for-of 可用)。每个元素是完整 exec 结果(含分组/index/groups)。
// ---------- RegExp.escape (ES2025) ----------
// 语义对齐 Node 24:首字符若为 ASCII 字母/数字则 \xHH;语法字符 ^$\.*+?()[]{}|/ 前加 \;
// \t\n\v\f\r 用控制转义;一批标点/空白(空格 ! " # % & ' , - : ; < = > @ ` ~)转 \xHH;
// 其余(含 _、控制码 0-8/14-31/127、非 ASCII 字节)原样输出。
// gen1-safe:仅 charCodeAt/charAt/字符串拼接与整数算术,无位运算/正则/Math。
function __re_hexDigit(v) {
    return "0123456789abcdef".charAt(v);
}

function __re_hex2(code) {
    var hi = 0;
    var lo = code;
    while (lo >= 16) { lo = lo - 16; hi = hi + 1; }
    return "\\x" + __re_hexDigit(hi) + __re_hexDigit(lo);
}

function __re_isSyntaxCode(c) {
    if (c === 94 || c === 36 || c === 92 || c === 46) return true; // ^ $ \ .
    if (c === 42 || c === 43 || c === 63) return true;             // * + ?
    if (c === 40 || c === 41 || c === 91 || c === 93) return true; // ( ) [ ]
    if (c === 123 || c === 124 || c === 125 || c === 47) return true; // { | } /
    return false;
}

function __re_isHexEscCode(c) {
    if (c === 32 || c === 33 || c === 34 || c === 35) return true; // space ! " #
    if (c === 37 || c === 38 || c === 39 || c === 44) return true; // % & ' ,
    if (c === 45 || c === 58 || c === 59 || c === 60) return true; // - : ; <
    if (c === 61 || c === 62 || c === 64 || c === 96) return true; // = > @ `
    if (c === 126) return true;                                    // ~
    return false;
}

function __re_isAsciiAlnum(c) {
    if (c >= 48 && c <= 57) return true;
    if (c >= 65 && c <= 90) return true;
    if (c >= 97 && c <= 122) return true;
    return false;
}

export function __RE_escape(str) {
    var s = str;
    if (typeof s !== "string") s = "" + s;
    var out = "";
    var i = 0;
    var n = s.length;
    while (i < n) {
        var c = s.charCodeAt(i);
        if (__re_isSyntaxCode(c)) {
            out = out + "\\" + s.charAt(i);
        } else if (c === 9) {
            out = out + "\\t";
        } else if (c === 10) {
            out = out + "\\n";
        } else if (c === 11) {
            out = out + "\\v";
        } else if (c === 12) {
            out = out + "\\f";
        } else if (c === 13) {
            out = out + "\\r";
        } else if (__re_isHexEscCode(c)) {
            out = out + __re_hex2(c);
        } else if (i === 0 && __re_isAsciiAlnum(c)) {
            out = out + __re_hex2(c);
        } else {
            out = out + s.charAt(i);
        }
        i = i + 1;
    }
    return out;
}

export function __RE_matchAll(str, re) {
    if (typeof re === "string") re = __RE_new(re, "g");
    var s = str;
    if (typeof s !== "string") s = "" + s;
    var out = [];
    re.lastIndex = 0;
    while (true) {
        var m = __RE_exec(re, s);
        if (m === null) break;
        out.push(m);
        if (!re.global) break; // 非 g:JS 会抛,这里宽容只取一个
        if (m[0] === "") re.lastIndex = re.lastIndex + 1; // 空匹配前进防死循环
    }
    re.lastIndex = 0;
    return out;
}

// str.split(re[, limit]):正则分隔符。ES SplitMatch 语义:切匹配之间的片段,
// 捕获组按序并入结果;空匹配不在 last 处重切且推进一位防死循环;limit 截断。
// 用 g 标志工作副本驱动 __RE_exec 扫描(原 re 的 lastIndex 不受影响)。
export function __RE_split(str, re, limit) {
    var lim = (limit === undefined || limit === null) ? 4294967295 : limit;
    if (lim === 0) return [];
    var flags = re.flags;
    if (flags.indexOf("g") < 0) flags = flags + "g";
    var g = __RE_new(re.source, flags);
    if (str === "") {
        // 规范:空串上正则能匹配空 → [],否则 [""]
        var me = __RE_exec(g, "");
        if (me === null) return [""];
        return [];
    }
    var out = [];
    var last = 0;
    g.lastIndex = 0;
    while (true) {
        var m = __RE_exec(g, str);
        if (m === null) break;
        var q = m.index;
        if (q >= str.length) break;
        var e = q + m[0].length;
        if (e === last) { g.lastIndex = q + 1; continue; } // 空匹配未推进:跳过
        out.push(str.slice(last, q));
        if (out.length >= lim) return out;
        var k = 1;
        while (k < m.length) { // 捕获组并入(ES 规范)
            out.push(m[k]);
            if (out.length >= lim) return out;
            k = k + 1;
        }
        last = e;
        g.lastIndex = (m[0].length === 0) ? q + 1 : e;
    }
    out.push(str.slice(last));
    return out;
}
