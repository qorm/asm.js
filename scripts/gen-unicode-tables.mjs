#!/usr/bin/env node
// scripts/gen-unicode-tables.mjs
//
// 为 runtime/node/__regexp_shim.js 生成 \p{…} / \P{…} Unicode 属性转义所需的
// 码点区间表(纯数据,零第三方依赖)。
//
// 生成方法(离线、可复现):
//   本机没有 UCD 文本文件,也不允许联网。宿主 Node 自带的正则引擎本身实现了
//   ECMAScript 的 \p{…},其数据即一份权威 UCD 快照。于是:
//     1. 把除代理区(U+D800..U+DFFF)外的全部码点拼成一个字符串 S,并记录
//        "UTF-16 下标 -> 码点" 映射;
//     2. 对每个属性用宿主的 /\p{X}+/gu 扫一遍 S,把匹配段还原成码点区间;
//     3. 代理区单独逐点用 re.test(String.fromCharCode(cp)) 判定后并入。
//   属性名清单为手写候选集,逐个交给宿主 new RegExp("\\p{...}","u") 判活:
//   宿主拒绝的候选直接丢弃,所以表里不会出现 ECMAScript 不认的名字。
//   另有三重体检(见 selfCheck):
//     a. 各 General_Category 值的并集必须等于 \p{Any};
//     b. 各 Script 值的并集必须等于 \p{Any}(含 Script=Unknown);
//     c. 每个别名的区间集必须与其规范名逐字节相同。
//   任一体检不过即报错退出——宁可没有数据,也不要错的数据。
//
// Unicode 版本 = 宿主 Node 的 process.versions.unicode(生成时写进表头注释)。
//
// 用法:
//   node scripts/gen-unicode-tables.mjs            # 打印统计,不落盘
//   node scripts/gen-unicode-tables.mjs --write    # 就地改写 __regexp_shim.js
//                                                  # 的 UNI-TABLES 标记区
//
// 编码(见 shim 侧 __re_uniDecode):
//   区间序列 [lo,hi] 升序,写成 (gap, len) 对;gap = lo - 上一段 hi - 1(首段
//   gap = lo),len = hi - lo。每个整数按小端 base-32 变长写:每字符取
//   alphabet[v],v<32 表示末位、v>=32 表示还有后继(载荷 v-32)。
//   alphabet = "0-9A-Za-z-_"(64 个 URL-safe 字符,JS 字符串里无需转义)。

import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SHIM = join(REPO, "runtime", "node", "__regexp_shim.js");

const ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

// ---------------------------------------------------------------------------
// 候选名清单(手写;宿主判活后才进表)
// ---------------------------------------------------------------------------

// General_Category:规范名 -> 别名数组(第一个元素是 ECMAScript 规范名)
const GC = [
    ["C", "Other"],
    ["Cc", "Control", "cntrl"],
    ["Cf", "Format"],
    ["Cn", "Unassigned"],
    ["Co", "Private_Use"],
    ["Cs", "Surrogate"],
    ["L", "Letter"],
    ["LC", "Cased_Letter"],
    ["Ll", "Lowercase_Letter"],
    ["Lm", "Modifier_Letter"],
    ["Lo", "Other_Letter"],
    ["Lt", "Titlecase_Letter"],
    ["Lu", "Uppercase_Letter"],
    ["M", "Mark", "Combining_Mark"],
    ["Mc", "Spacing_Mark"],
    ["Me", "Enclosing_Mark"],
    ["Mn", "Nonspacing_Mark"],
    ["N", "Number"],
    ["Nd", "Decimal_Number", "digit"],
    ["Nl", "Letter_Number"],
    ["No", "Other_Number"],
    ["P", "Punctuation", "punct"],
    ["Pc", "Connector_Punctuation"],
    ["Pd", "Dash_Punctuation"],
    ["Pe", "Close_Punctuation"],
    ["Pf", "Final_Punctuation"],
    ["Pi", "Initial_Punctuation"],
    ["Po", "Other_Punctuation"],
    ["Ps", "Open_Punctuation"],
    ["S", "Symbol"],
    ["Sc", "Currency_Symbol"],
    ["Sk", "Modifier_Symbol"],
    ["Sm", "Math_Symbol"],
    ["So", "Other_Symbol"],
    ["Z", "Separator"],
    ["Zl", "Line_Separator"],
    ["Zp", "Paragraph_Separator"],
    ["Zs", "Space_Separator"],
];

// 二元属性:规范名 -> 别名
const BINARY = [
    ["ASCII"],
    ["ASCII_Hex_Digit", "AHex"],
    ["Alphabetic", "Alpha"],
    ["Any"],
    ["Assigned"],
    ["Bidi_Control", "Bidi_C"],
    ["Bidi_Mirrored", "Bidi_M"],
    ["Case_Ignorable", "CI"],
    ["Cased"],
    ["Changes_When_Casefolded", "CWCF"],
    ["Changes_When_Casemapped", "CWCM"],
    ["Changes_When_Lowercased", "CWL"],
    ["Changes_When_NFKC_Casefolded", "CWKCF"],
    ["Changes_When_Titlecased", "CWT"],
    ["Changes_When_Uppercased", "CWU"],
    ["Dash"],
    ["Default_Ignorable_Code_Point", "DI"],
    ["Deprecated", "Dep"],
    ["Diacritic", "Dia"],
    ["Emoji"],
    ["Emoji_Component", "EComp"],
    ["Emoji_Modifier", "EMod"],
    ["Emoji_Modifier_Base", "EBase"],
    ["Emoji_Presentation", "EPres"],
    ["Extended_Pictographic", "ExtPict"],
    ["Extender", "Ext"],
    ["Grapheme_Base", "Gr_Base"],
    ["Grapheme_Extend", "Gr_Ext"],
    ["Hex_Digit", "Hex"],
    ["IDS_Binary_Operator", "IDSB"],
    ["IDS_Trinary_Operator", "IDST"],
    ["IDS_Unary_Operator", "IDSU"],
    ["ID_Compat_Math_Continue"],
    ["ID_Compat_Math_Start"],
    ["ID_Continue", "IDC"],
    ["ID_Start", "IDS"],
    ["Ideographic", "Ideo"],
    ["Join_Control", "Join_C"],
    ["Logical_Order_Exception", "LOE"],
    ["Lowercase", "Lower"],
    ["Math"],
    ["Modifier_Combining_Mark", "MCM"],
    ["Noncharacter_Code_Point", "NChar"],
    ["Pattern_Syntax", "Pat_Syn"],
    ["Pattern_White_Space", "Pat_WS"],
    ["Quotation_Mark", "QMark"],
    ["Radical"],
    ["Regional_Indicator", "RI"],
    ["Sentence_Terminal", "STerm"],
    ["Soft_Dotted", "SD"],
    ["Terminal_Punctuation", "Term"],
    ["Unified_Ideograph", "UIdeo"],
    ["Uppercase", "Upper"],
    ["Variation_Selector", "VS"],
    ["White_Space", "space"],
    ["XID_Continue", "XIDC"],
    ["XID_Start", "XIDS"],
];

// Script / Script_Extensions 值:规范名 -> ISO 15924 短别名
const SCRIPTS = [
    ["Adlam", "Adlm"], ["Ahom"], ["Anatolian_Hieroglyphs", "Hluw"],
    ["Arabic", "Arab"], ["Armenian", "Armn"], ["Avestan", "Avst"],
    ["Balinese", "Bali"], ["Bamum", "Bamu"], ["Bassa_Vah", "Bass"],
    ["Batak", "Batk"], ["Bengali", "Beng"], ["Beria_Erfe", "Berf"],
    ["Bhaiksuki", "Bhks"], ["Bopomofo", "Bopo"], ["Brahmi", "Brah"],
    ["Braille", "Brai"], ["Buginese", "Bugi"], ["Buhid", "Buhd"],
    ["Canadian_Aboriginal", "Cans"], ["Carian", "Cari"],
    ["Caucasian_Albanian", "Aghb"], ["Chakma", "Cakm"], ["Cham"],
    ["Cherokee", "Cher"], ["Chorasmian", "Chrs"], ["Common", "Zyyy"],
    ["Coptic", "Copt", "Qaac"], ["Cuneiform", "Xsux"], ["Cypriot", "Cprt"],
    ["Cypro_Minoan", "Cpmn"], ["Cyrillic", "Cyrl"], ["Deseret", "Dsrt"],
    ["Devanagari", "Deva"], ["Dives_Akuru", "Diak"], ["Dogra", "Dogr"],
    ["Duployan", "Dupl"], ["Egyptian_Hieroglyphs", "Egyp"], ["Elbasan", "Elba"],
    ["Elymaic", "Elym"], ["Ethiopic", "Ethi"], ["Garay", "Gara"],
    ["Georgian", "Geor"], ["Glagolitic", "Glag"], ["Gothic", "Goth"],
    ["Grantha", "Gran"], ["Greek", "Grek"], ["Gujarati", "Gujr"],
    ["Gunjala_Gondi", "Gong"], ["Gurmukhi", "Guru"], ["Gurung_Khema", "Gukh"],
    ["Han", "Hani"], ["Hangul", "Hang"], ["Hanifi_Rohingya", "Rohg"],
    ["Hanunoo", "Hano"], ["Hatran", "Hatr"], ["Hebrew", "Hebr"],
    ["Hiragana", "Hira"], ["Imperial_Aramaic", "Armi"],
    ["Inherited", "Zinh", "Qaai"], ["Inscriptional_Pahlavi", "Phli"],
    ["Inscriptional_Parthian", "Prti"], ["Javanese", "Java"],
    ["Kaithi", "Kthi"], ["Kannada", "Knda"], ["Katakana", "Kana"],
    ["Kawi"], ["Kayah_Li", "Kali"], ["Kharoshthi", "Khar"],
    ["Khitan_Small_Script", "Kits"], ["Khmer", "Khmr"], ["Khojki", "Khoj"],
    ["Khudawadi", "Sind"], ["Kirat_Rai", "Krai"], ["Lao", "Laoo"],
    ["Latin", "Latn"], ["Lepcha", "Lepc"], ["Limbu", "Limb"],
    ["Linear_A", "Lina"], ["Linear_B", "Linb"], ["Lisu"], ["Lycian", "Lyci"],
    ["Lydian", "Lydi"], ["Mahajani", "Mahj"], ["Makasar", "Maka"],
    ["Malayalam", "Mlym"], ["Mandaic", "Mand"], ["Manichaean", "Mani"],
    ["Marchen", "Marc"], ["Masaram_Gondi", "Gonm"], ["Medefaidrin", "Medf"],
    ["Meetei_Mayek", "Mtei"], ["Mende_Kikakui", "Mend"],
    ["Meroitic_Cursive", "Merc"], ["Meroitic_Hieroglyphs", "Mero"],
    ["Miao", "Plrd"], ["Modi"], ["Mongolian", "Mong"], ["Mro", "Mroo"],
    ["Multani", "Mult"], ["Myanmar", "Mymr"], ["Nabataean", "Nbat"],
    ["Nag_Mundari", "Nagm"], ["Nandinagari", "Nand"], ["New_Tai_Lue", "Talu"],
    ["Newa"], ["Nko", "Nkoo"], ["Nushu", "Nshu"], ["Nyiakeng_Puachue_Hmong", "Hmnp"],
    ["Ogham", "Ogam"], ["Ol_Chiki", "Olck"], ["Ol_Onal", "Onao"],
    ["Old_Hungarian", "Hung"], ["Old_Italic", "Ital"], ["Old_North_Arabian", "Narb"],
    ["Old_Permic", "Perm"], ["Old_Persian", "Xpeo"], ["Old_Sogdian", "Sogo"],
    ["Old_South_Arabian", "Sarb"], ["Old_Turkic", "Orkh"], ["Old_Uyghur", "Ougr"],
    ["Oriya", "Orya"], ["Osage", "Osge"], ["Osmanya", "Osma"],
    ["Pahawh_Hmong", "Hmng"], ["Palmyrene", "Palm"], ["Pau_Cin_Hau", "Pauc"],
    ["Phags_Pa", "Phag"], ["Phoenician", "Phnx"], ["Psalter_Pahlavi", "Phlp"],
    ["Rejang", "Rjng"], ["Runic", "Runr"], ["Samaritan", "Samr"],
    ["Saurashtra", "Saur"], ["Sharada", "Shrd"], ["Shavian", "Shaw"],
    ["Siddham", "Sidd"], ["SignWriting", "Sgnw"], ["Sidetic", "Sidt"],
    ["Sinhala", "Sinh"], ["Sogdian", "Sogd"], ["Sora_Sompeng", "Sora"],
    ["Soyombo", "Soyo"], ["Sundanese", "Sund"], ["Sunuwar", "Sunu"],
    ["Syloti_Nagri", "Sylo"], ["Syriac", "Syrc"], ["Tagalog", "Tglg"],
    ["Tagbanwa", "Tagb"], ["Tai_Le", "Tale"], ["Tai_Tham", "Lana"],
    ["Tai_Viet", "Tavt"], ["Tai_Yo", "Tayo"], ["Takri", "Takr"], ["Tamil", "Taml"],
    ["Tangsa", "Tnsa"], ["Tangut", "Tang"], ["Telugu", "Telu"],
    ["Thaana", "Thaa"], ["Thai"], ["Tibetan", "Tibt"], ["Tifinagh", "Tfng"],
    ["Tirhuta", "Tirh"], ["Todhri", "Todr"], ["Tolong_Siki", "Tols"],
    ["Toto"], ["Tulu_Tigalari", "Tutg"], ["Ugaritic", "Ugar"],
    ["Unknown", "Zzzz"], ["Vai", "Vaii"], ["Vithkuqi", "Vith"], ["Wancho", "Wcho"],
    ["Warang_Citi", "Wara"], ["Yezidi", "Yezi"], ["Yi", "Yiii"],
    ["Zanabazar_Square", "Zanb"],
];

// ---------------------------------------------------------------------------
// 码点串 + 下标映射
// ---------------------------------------------------------------------------

function buildScan() {
    const chunks = [];
    const idx = [];
    let len = 0;
    let buf = "";
    for (let cp = 0; cp <= 0x10ffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        buf += String.fromCodePoint(cp);
        idx.push(len);
        len += cp > 0xffff ? 2 : 1;
        if (buf.length > 1 << 16) { chunks.push(buf); buf = ""; }
    }
    chunks.push(buf);
    const S = chunks.join("");
    // idx[i] = 第 i 个码点在 S 中的起始下标;反查用二分。
    const starts = Int32Array.from(idx);
    const cps = new Int32Array(starts.length);
    let k = 0;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        cps[k++] = cp;
    }
    return { S, starts, cps };
}

function idxToOrd(starts, at) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= at) lo = mid; else hi = mid - 1;
    }
    return lo;
}

// 属性表达式 -> 升序不相交区间数组 [[lo,hi],...]
function rangesOf(scan, expr) {
    const re = new RegExp("\\p{" + expr + "}+", "gu");
    const out = [];
    let m;
    while ((m = re.exec(scan.S)) !== null) {
        const o0 = idxToOrd(scan.starts, m.index);
        const o1 = idxToOrd(scan.starts, m.index + m[0].length - 1);
        pushRange(out, scan.cps[o0], scan.cps[o1]);
        if (m[0].length === 0) re.lastIndex++;
    }
    // 代理区逐点补测(它们被排除在 S 之外,免得拼成合法代理对)
    const sre = new RegExp("^\\p{" + expr + "}$", "u");
    for (let cp = 0xd800; cp <= 0xdfff; cp++) {
        if (sre.test(String.fromCharCode(cp))) pushRange(out, cp, cp);
    }
    out.sort((a, b) => a[0] - b[0]);
    return mergeRanges(out);
}

function pushRange(out, lo, hi) {
    const last = out.length ? out[out.length - 1] : null;
    if (last && last[1] + 1 === lo) { last[1] = hi; return; }
    out.push([lo, hi]);
}

function mergeRanges(rs) {
    const out = [];
    for (const r of rs) {
        const last = out.length ? out[out.length - 1] : null;
        if (last && r[0] <= last[1] + 1) { if (r[1] > last[1]) last[1] = r[1]; continue; }
        out.push([r[0], r[1]]);
    }
    return out;
}

// ---------------------------------------------------------------------------
// 变长 base-32(载荷)/ base-64(字符)编码
// ---------------------------------------------------------------------------

function encInt(v) {
    let s = "";
    for (;;) {
        const d = v % 32;
        v = (v - d) / 32;
        if (v === 0) { s += ALPHA[d]; return s; }
        s += ALPHA[d + 32];
    }
}

function encodeRanges(rs) {
    let s = "";
    let prev = -1;
    for (const r of rs) {
        s += encInt(r[0] - prev - 1);
        s += encInt(r[1] - r[0]);
        prev = r[1];
    }
    return s;
}

function decodeRanges(s) {
    const out = [];
    let i = 0, prev = -1;
    while (i < s.length) {
        let v = 0, mul = 1;
        for (;;) {
            const d = ALPHA.indexOf(s[i++]);
            if (d < 32) { v += d * mul; break; }
            v += (d - 32) * mul; mul *= 32;
        }
        const lo = prev + 1 + v;
        let w = 0; mul = 1;
        for (;;) {
            const d = ALPHA.indexOf(s[i++]);
            if (d < 32) { w += d * mul; break; }
            w += (d - 32) * mul; mul *= 32;
        }
        out.push([lo, lo + w]);
        prev = lo + w;
    }
    return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function supported(expr) {
    try { new RegExp("\\p{" + expr + "}", "u"); return true; } catch (e) { return false; }
}

function main() {
    const write = process.argv.includes("--write");
    const uniVer = process.versions.unicode;
    process.stderr.write(`[gen] node ${process.version}, Unicode ${uniVer}\n`);
    const scan = buildScan();
    process.stderr.write(`[gen] scan string ${scan.S.length} UTF-16 units\n`);

    // 区间串去重:scx 与 sc 大量重合(多数文种二者相同),同串只存一份。
    const tables = [];        // 去重后的表(顺序 = 运行时 ordinal)
    const byEnc = new Map();  // enc -> ordinal
    const nameGc = [];        // [alias, ordinal]
    const nameBin = [];
    const nameSc = [];
    const nameScx = [];

    function intern(kind, name, rs, enc) {
        if (byEnc.has(enc)) return byEnc.get(enc);
        const ti = tables.length;
        tables.push({ name, kind, ranges: rs, enc });
        byEnc.set(enc, ti);
        return ti;
    }

    function collect(groups, prefix, sink) {
        for (const g of groups) {
            const canon = g[0];
            const probe = prefix ? prefix + "=" + canon : canon;
            if (!supported(probe)) {
                process.stderr.write(`[gen] host rejects ${probe} - dropped\n`);
                continue;
            }
            const rs = rangesOf(scan, probe);
            const enc = encodeRanges(rs);
            // 自检:解码回来必须一致
            const back = decodeRanges(enc);
            if (JSON.stringify(back) !== JSON.stringify(rs)) {
                throw new Error("roundtrip mismatch for " + probe);
            }
            const ti = intern(prefix || "bin", canon, rs, enc);
            sink.push([canon, ti]);
            for (let a = 1; a < g.length; a++) {
                const alias = g[a];
                const pa = prefix ? prefix + "=" + alias : alias;
                if (!supported(pa)) {
                    process.stderr.write(`[gen] host rejects alias ${pa} - dropped\n`);
                    continue;
                }
                // 别名必须与规范名同集合
                const ea = encodeRanges(rangesOf(scan, pa));
                if (ea !== enc) throw new Error("alias set mismatch: " + pa + " != " + probe);
                sink.push([alias, ti]);
            }
        }
    }

    collect(GC, "General_Category", nameGc);
    collect(BINARY, "", nameBin);
    collect(SCRIPTS, "Script", nameSc);
    collect(SCRIPTS, "Script_Extensions", nameScx);

    if (process.argv.includes("--stats")) {
        const rows = tables.map(t => [t.kind + "=" + t.name, t.enc.length, t.ranges.length])
            .sort((a, b) => b[1] - a[1]);
        let sum = 0;
        for (const r of rows) sum += r[1];
        process.stderr.write("[gen] total payload " + sum + "\n");
        for (const r of rows.slice(0, 40)) {
            process.stderr.write("  " + String(r[1]).padStart(6) + "  " + String(r[2]).padStart(6) + "r  " + r[0] + "\n");
        }
    }

    selfCheck(tables, [["General_Category", nameGc], ["", nameBin],
                       ["Script", nameSc], ["Script_Extensions", nameScx]]);
    const out = emit(tables, nameGc, nameBin, nameSc, nameScx, uniVer);

    process.stderr.write(`[gen] tables=${tables.length} names=${nameGc.length + nameBin.length + nameSc.length + nameScx.length}\n`);
    process.stderr.write(`[gen] encoded payload = ${out.payloadBytes} bytes, emitted source = ${out.text.length} bytes\n`);

    if (write) {
        const src = readFileSync(SHIM, "utf8");
        const B = "// <<<UNI-TABLES-BEGIN (generated by scripts/gen-unicode-tables.mjs; do not edit by hand)";
        const E = "// >>>UNI-TABLES-END";
        const bi = src.indexOf(B), ei = src.indexOf(E);
        if (bi < 0 || ei < 0) throw new Error("marker not found in " + SHIM);
        const next = src.slice(0, bi + B.length) + "\n" + out.text + src.slice(ei);
        writeFileSync(SHIM, next);
        process.stderr.write(`[gen] wrote ${SHIM}\n`);
    } else {
        process.stdout.write(out.text);
    }
}

function selfCheck(tables, groups) {
    const find = (pairs, n) => { for (const p of pairs) if (p[0] === n) return p[1]; return -1; };
    const nameGc = groups[0][1], nameSc = groups[2][1];

    // a. General_Category 二字母值的并集必须铺满整个码点空间
    const cover = new Uint8Array(0x110000);
    for (const p of nameGc) {
        if (p[0].length !== 2 || p[0] === "LC") continue;
        for (const r of tables[p[1]].ranges) for (let c = r[0]; c <= r[1]; c++) cover[c] = 1;
    }
    for (let c = 0; c <= 0x10ffff; c++) {
        if (!cover[c]) throw new Error("gc coverage hole at U+" + c.toString(16));
    }
    // b. Script 值(含 Unknown)的并集必须铺满整个码点空间
    const cov2 = new Uint8Array(0x110000);
    for (const p of nameSc) {
        for (const r of tables[p[1]].ranges) for (let c = r[0]; c <= r[1]; c++) cov2[c] = 1;
    }
    for (let c = 0; c <= 0x10ffff; c++) {
        if (!cov2[c]) throw new Error("script coverage hole at U+" + c.toString(16));
    }
    // c. 逐 **名字**(含全部别名)抽样复核:与宿主判定必须一致
    let checked = 0;
    for (const g of groups) {
        for (const p of g[1]) {
            const expr = g[0] ? g[0] + "=" + p[0] : p[0];
            const re = new RegExp("^\\p{" + expr + "}$", "u");
            const rs = tables[p[1]].ranges;
            for (let s = 0; s < 200; s++) {
                const cp = Math.floor(Math.random() * 0x110000);
                if (cp >= 0xd800 && cp <= 0xdfff) continue;
                const want = re.test(String.fromCodePoint(cp));
                let got = false;
                for (const r of rs) if (cp >= r[0] && cp <= r[1]) { got = true; break; }
                if (want !== got) throw new Error(`sample mismatch ${expr} U+${cp.toString(16)} want=${want} got=${got}`);
                checked++;
            }
            // 边界复核:每段的 lo/hi 与 lo-1/hi+1 必须与宿主一致
            for (const r of rs) {
                for (const c of [r[0], r[1], r[0] - 1, r[1] + 1]) {
                    if (c < 0 || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) continue;
                    let got = false;
                    for (const q of rs) if (c >= q[0] && c <= q[1]) { got = true; break; }
                    if (re.test(String.fromCodePoint(c)) !== got) {
                        throw new Error(`edge mismatch ${expr} U+${c.toString(16)}`);
                    }
                    checked++;
                }
            }
        }
    }
    if (find(nameGc, "Lu") < 0 || find(nameSc, "Greek") < 0) throw new Error("expected names missing");
    process.stderr.write(`[gen] selfCheck ok (gc/script coverage complete, ${checked} probes vs host)\n`);
}

function emit(tables, nameGc, nameBin, nameSc, nameScx, uniVer) {
    // 表载荷:各属性的区间串以 "\n" 拼接成一个大字符串常量;名字表把属性名映射到
    // 该串里的**段序号**(运行时用 indexOf("\n") 数过去,首次使用后进 cache)。
    const payload = tables.map(t => t.enc).join("\n");
    // 必须是**单条**字面量:拆成 "a" + "b" + … 会让 asm.js 在启动时把各段在堆上再
    // 拼一份,rodata 与堆各存一遍,实测二进制多长一倍(+112KiB -> +60KiB)。
    const chop = (s) => JSON.stringify(s);
    const lines = [];
    lines.push("// 由 scripts/gen-unicode-tables.mjs 生成 —— 请勿手改(改数据请改生成器)。");
    lines.push("// 数据来源:宿主 Node 正则引擎的 \\p{…} 判定(方法见生成器头注释),");
    lines.push("// Unicode " + uniVer + "。编码:每段是若干 (gap,len) 对,整数按变长小端");
    lines.push("// base-32 写入;数字字符表 = \"" + ALPHA + "\"");
    lines.push("// (字符值 v<32 表示末位、v>=32 表示还有后继且载荷为 v-32,解码见 __re_uniDigit)。");
    lines.push("// 段与段之间以 \\n 分隔。名字表形如 \"Lu:12 Uppercase_Letter:12 …\"。");
    lines.push("var __RE_UT = " + chop(payload) + ";");
    const nt = (pairs) => pairs.map(p => p[0] + ":" + p[1]).join(" ");
    lines.push("var __RE_UN_GC = " + chop(nt(nameGc)) + ";");
    lines.push("var __RE_UN_BIN = " + chop(nt(nameBin)) + ";");
    lines.push("var __RE_UN_SC = " + chop(nt(nameSc)) + ";");
    lines.push("var __RE_UN_SCX = " + chop(nt(nameScx)) + ";");

    const text = lines.join("\n") + "\n";
    return { text, payloadBytes: payload.length };
}

main();
