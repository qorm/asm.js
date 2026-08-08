// asm.js - RegExp 字面量解析时校验(parse-time early errors)
// 在 lang/parser/expressions.js parseRegexLiteral 处调用,对 flags 与 \p{}/\P{} 属性转义做
// 编译期早期错误校验(与 Node 对拍:u/v 模式下非法属性名/结构/二元属性带值/字符串属性误用等
// 一律 SyntaxError)。
//
// 属性名表复制自 runtime/node/__regexp_shim.js:55-58(由 scripts/gen-unicode-tables.mjs 生成,
// Unicode 17.0)。lang 侧校验必须与运行时 shim 的接受集合一致,否则编译期放行的正则运行时抛错
// (或编译期误拒合法程序)。修改表须两处同步。
// 已实现:flags 合法性、\p{} 结构与名/值精确匹配(A/C/D/E/F)、字符串属性 u 模式拒 + v 模式
// 负向/类内拒(B)、类内 \p{} 作范围端点拒(G)、v 模式类集合保留字符与交集操作符 &&(H:
// 单 & 为字面原子,`&&` 须左右操作数齐全,`[&&]`/`[^&&]`/`[a&&]` 拒;`{ }` 语法字符拒)。
// 未实现:v 模式 "--" 集合差文法(H 剩余,留后续)。
var __RE_UN_GC = "C:0 Other:0 Cc:1 Control:1 cntrl:1 Cf:2 Format:2 Cn:3 Unassigned:3 Co:4 Private_Use:4 Cs:5 Surrogate:5 L:6 Letter:6 LC:7 Cased_Letter:7 Ll:8 Lowercase_Letter:8 Lm:9 Modifier_Letter:9 Lo:10 Other_Letter:10 Lt:11 Titlecase_Letter:11 Lu:12 Uppercase_Letter:12 M:13 Mark:13 Combining_Mark:13 Mc:14 Spacing_Mark:14 Me:15 Enclosing_Mark:15 Mn:16 Nonspacing_Mark:16 N:17 Number:17 Nd:18 Decimal_Number:18 digit:18 Nl:19 Letter_Number:19 No:20 Other_Number:20 P:21 Punctuation:21 punct:21 Pc:22 Connector_Punctuation:22 Pd:23 Dash_Punctuation:23 Pe:24 Close_Punctuation:24 Pf:25 Final_Punctuation:25 Pi:26 Initial_Punctuation:26 Po:27 Other_Punctuation:27 Ps:28 Open_Punctuation:28 S:29 Symbol:29 Sc:30 Currency_Symbol:30 Sk:31 Modifier_Symbol:31 Sm:32 Math_Symbol:32 So:33 Other_Symbol:33 Z:34 Separator:34 Zl:35 Line_Separator:35 Zp:36 Paragraph_Separator:36 Zs:37 Space_Separator:37";
var __RE_UN_BIN = "ASCII:38 ASCII_Hex_Digit:39 AHex:39 Alphabetic:40 Alpha:40 Any:41 Assigned:42 Bidi_Control:43 Bidi_C:43 Bidi_Mirrored:44 Bidi_M:44 Case_Ignorable:45 CI:45 Cased:46 Changes_When_Casefolded:47 CWCF:47 Changes_When_Casemapped:48 CWCM:48 Changes_When_Lowercased:49 CWL:49 Changes_When_NFKC_Casefolded:50 CWKCF:50 Changes_When_Titlecased:51 CWT:51 Changes_When_Uppercased:52 CWU:52 Dash:53 Default_Ignorable_Code_Point:54 DI:54 Deprecated:55 Dep:55 Diacritic:56 Dia:56 Emoji:57 Emoji_Component:58 EComp:58 Emoji_Modifier:59 EMod:59 Emoji_Modifier_Base:60 EBase:60 Emoji_Presentation:61 EPres:61 Extended_Pictographic:62 ExtPict:62 Extender:63 Ext:63 Grapheme_Base:64 Gr_Base:64 Grapheme_Extend:65 Gr_Ext:65 Hex_Digit:66 Hex:66 IDS_Binary_Operator:67 IDSB:67 IDS_Trinary_Operator:68 IDST:68 ID_Continue:69 IDC:69 ID_Start:70 IDS:70 Ideographic:71 Ideo:71 Join_Control:72 Join_C:72 Logical_Order_Exception:73 LOE:73 Lowercase:74 Lower:74 Math:75 Noncharacter_Code_Point:76 NChar:76 Pattern_Syntax:77 Pat_Syn:77 Pattern_White_Space:78 Pat_WS:78 Quotation_Mark:79 QMark:79 Radical:80 Regional_Indicator:81 RI:81 Sentence_Terminal:82 STerm:82 Soft_Dotted:83 SD:83 Terminal_Punctuation:84 Term:84 Unified_Ideograph:85 UIdeo:85 Uppercase:86 Upper:86 Variation_Selector:87 VS:87 White_Space:88 space:88 XID_Continue:89 XIDC:89 XID_Start:90 XIDS:90";
var __RE_UN_SC = "Adlam:91 Adlm:91 Ahom:92 Anatolian_Hieroglyphs:93 Hluw:93 Arabic:94 Arab:94 Armenian:95 Armn:95 Avestan:96 Avst:96 Balinese:97 Bali:97 Bamum:98 Bamu:98 Bassa_Vah:99 Bass:99 Batak:100 Batk:100 Bengali:101 Beng:101 Beria_Erfe:102 Berf:102 Bhaiksuki:103 Bhks:103 Bopomofo:104 Bopo:104 Brahmi:105 Brah:105 Braille:106 Brai:106 Buginese:107 Bugi:107 Buhid:108 Buhd:108 Canadian_Aboriginal:109 Cans:109 Carian:110 Cari:110 Caucasian_Albanian:111 Aghb:111 Chakma:112 Cakm:112 Cham:113 Cherokee:114 Cher:114 Chorasmian:115 Chrs:115 Common:116 Zyyy:116 Coptic:117 Copt:117 Qaac:117 Cuneiform:118 Xsux:118 Cypriot:119 Cprt:119 Cypro_Minoan:120 Cpmn:120 Cyrillic:121 Cyrl:121 Deseret:122 Dsrt:122 Devanagari:123 Deva:123 Dives_Akuru:124 Diak:124 Dogra:125 Dogr:125 Duployan:126 Dupl:126 Egyptian_Hieroglyphs:127 Egyp:127 Elbasan:128 Elba:128 Elymaic:129 Elym:129 Ethiopic:130 Ethi:130 Garay:131 Gara:131 Georgian:132 Geor:132 Glagolitic:133 Glag:133 Gothic:134 Goth:134 Grantha:135 Gran:135 Greek:136 Grek:136 Gujarati:137 Gujr:137 Gunjala_Gondi:138 Gong:138 Gurmukhi:139 Guru:139 Gurung_Khema:140 Gukh:140 Han:141 Hani:141 Hangul:142 Hang:142 Hanifi_Rohingya:143 Rohg:143 Hanunoo:144 Hano:144 Hatran:145 Hatr:145 Hebrew:146 Hebr:146 Hiragana:147 Hira:147 Imperial_Aramaic:148 Armi:148 Inherited:149 Zinh:149 Qaai:149 Inscriptional_Pahlavi:150 Phli:150 Inscriptional_Parthian:151 Prti:151 Javanese:152 Java:152 Kaithi:153 Kthi:153 Kannada:154 Knda:154 Katakana:155 Kana:155 Kawi:156 Kayah_Li:157 Kali:157 Kharoshthi:158 Khar:158 Khitan_Small_Script:159 Kits:159 Khmer:160 Khmr:160 Khojki:161 Khoj:161 Khudawadi:162 Sind:162 Kirat_Rai:163 Krai:163 Lao:164 Laoo:164 Latin:165 Latn:165 Lepcha:166 Lepc:166 Limbu:167 Limb:167 Linear_A:168 Lina:168 Linear_B:169 Linb:169 Lisu:170 Lycian:171 Lyci:171 Lydian:172 Lydi:172 Mahajani:173 Mahj:173 Makasar:174 Maka:174 Malayalam:175 Mlym:175 Mandaic:176 Mand:176 Manichaean:177 Mani:177 Marchen:178 Marc:178 Masaram_Gondi:179 Gonm:179 Medefaidrin:180 Medf:180 Meetei_Mayek:181 Mtei:181 Mende_Kikakui:182 Mend:182 Meroitic_Cursive:183 Merc:183 Meroitic_Hieroglyphs:184 Mero:184 Miao:185 Plrd:185 Modi:186 Mongolian:187 Mong:187 Mro:188 Mroo:188 Multani:189 Mult:189 Myanmar:190 Mymr:190 Nabataean:191 Nbat:191 Nag_Mundari:192 Nagm:192 Nandinagari:193 Nand:193 New_Tai_Lue:194 Talu:194 Newa:195 Nko:196 Nkoo:196 Nushu:197 Nshu:197 Nyiakeng_Puachue_Hmong:198 Hmnp:198 Ogham:199 Ogam:199 Ol_Chiki:200 Olck:200 Ol_Onal:201 Onao:201 Old_Hungarian:202 Hung:202 Old_Italic:203 Ital:203 Old_North_Arabian:204 Narb:204 Old_Permic:205 Perm:205 Old_Persian:206 Xpeo:206 Old_Sogdian:207 Sogo:207 Old_South_Arabian:208 Sarb:208 Old_Turkic:209 Orkh:209 Old_Uyghur:210 Ougr:210 Oriya:211 Orya:211 Osage:212 Osge:212 Osmanya:213 Osma:213 Pahawh_Hmong:214 Hmng:214 Palmyrene:215 Palm:215 Pau_Cin_Hau:216 Pauc:216 Phags_Pa:217 Phag:217 Phoenician:218 Phnx:218 Psalter_Pahlavi:219 Phlp:219 Rejang:220 Rjng:220 Runic:221 Runr:221 Samaritan:222 Samr:222 Saurashtra:223 Saur:223 Sharada:224 Shrd:224 Shavian:225 Shaw:225 Siddham:226 Sidd:226 SignWriting:227 Sgnw:227 Sidetic:228 Sidt:228 Sinhala:229 Sinh:229 Sogdian:230 Sogd:230 Sora_Sompeng:231 Sora:231 Soyombo:232 Soyo:232 Sundanese:233 Sund:233 Sunuwar:234 Sunu:234 Syloti_Nagri:235 Sylo:235 Syriac:236 Syrc:236 Tagalog:237 Tglg:237 Tagbanwa:238 Tagb:238 Tai_Le:239 Tale:239 Tai_Tham:240 Lana:240 Tai_Viet:241 Tavt:241 Tai_Yo:242 Tayo:242 Takri:243 Takr:243 Tamil:244 Taml:244 Tangsa:245 Tnsa:245 Tangut:246 Tang:246 Telugu:247 Telu:247 Thaana:248 Thaa:248 Thai:249 Tibetan:250 Tibt:250 Tifinagh:251 Tfng:251 Tirhuta:252 Tirh:252 Todhri:253 Todr:253 Tolong_Siki:254 Tols:254 Toto:255 Tulu_Tigalari:256 Tutg:256 Ugaritic:257 Ugar:257 Unknown:258 Zzzz:258 Vai:259 Vaii:259 Vithkuqi:260 Vith:260 Wancho:261 Wcho:261 Warang_Citi:262 Wara:262 Yezidi:263 Yezi:263 Yi:264 Yiii:264 Zanabazar_Square:265 Zanb:265";
var __RE_UN_SCX = "Adlam:266 Adlm:266 Ahom:92 Anatolian_Hieroglyphs:93 Hluw:93 Arabic:267 Arab:267 Armenian:268 Armn:268 Avestan:269 Avst:269 Balinese:97 Bali:97 Bamum:98 Bamu:98 Bassa_Vah:99 Bass:99 Batak:100 Batk:100 Bengali:270 Beng:270 Beria_Erfe:102 Berf:102 Bhaiksuki:103 Bhks:103 Bopomofo:271 Bopo:271 Brahmi:105 Brah:105 Braille:106 Brai:106 Buginese:272 Bugi:272 Buhid:273 Buhd:273 Canadian_Aboriginal:109 Cans:109 Carian:274 Cari:274 Caucasian_Albanian:275 Aghb:275 Chakma:276 Cakm:276 Cham:113 Cherokee:277 Cher:277 Chorasmian:115 Chrs:115 Common:278 Zyyy:278 Coptic:279 Copt:279 Qaac:279 Cuneiform:118 Xsux:118 Cypriot:280 Cprt:280 Cypro_Minoan:281 Cpmn:281 Cyrillic:282 Cyrl:282 Deseret:122 Dsrt:122 Devanagari:283 Deva:283 Dives_Akuru:124 Diak:124 Dogra:284 Dogr:284 Duployan:285 Dupl:285 Egyptian_Hieroglyphs:127 Egyp:127 Elbasan:286 Elba:286 Elymaic:129 Elym:129 Ethiopic:287 Ethi:287 Garay:288 Gara:288 Georgian:289 Geor:289 Glagolitic:290 Glag:290 Gothic:291 Goth:291 Grantha:292 Gran:292 Greek:293 Grek:293 Gujarati:294 Gujr:294 Gunjala_Gondi:295 Gong:295 Gurmukhi:296 Guru:296 Gurung_Khema:297 Gukh:297 Han:298 Hani:298 Hangul:299 Hang:299 Hanifi_Rohingya:300 Rohg:300 Hanunoo:301 Hano:301 Hatran:145 Hatr:145 Hebrew:302 Hebr:302 Hiragana:303 Hira:303 Imperial_Aramaic:148 Armi:148 Inherited:304 Zinh:304 Qaai:304 Inscriptional_Pahlavi:150 Phli:150 Inscriptional_Parthian:151 Prti:151 Javanese:305 Java:305 Kaithi:306 Kthi:306 Kannada:307 Knda:307 Katakana:308 Kana:308 Kawi:156 Kayah_Li:309 Kali:309 Kharoshthi:158 Khar:158 Khitan_Small_Script:159 Kits:159 Khmer:160 Khmr:160 Khojki:310 Khoj:310 Khudawadi:311 Sind:311 Kirat_Rai:163 Krai:163 Lao:164 Laoo:164 Latin:312 Latn:312 Lepcha:166 Lepc:166 Limbu:313 Limb:313 Linear_A:314 Lina:314 Linear_B:315 Linb:315 Lisu:316 Lycian:317 Lyci:317 Lydian:318 Lydi:318 Mahajani:319 Mahj:319 Makasar:174 Maka:174 Malayalam:320 Mlym:320 Mandaic:321 Mand:321 Manichaean:322 Mani:322 Marchen:178 Marc:178 Masaram_Gondi:323 Gonm:323 Medefaidrin:180 Medf:180 Meetei_Mayek:181 Mtei:181 Mende_Kikakui:182 Mend:182 Meroitic_Cursive:183 Merc:183 Meroitic_Hieroglyphs:324 Mero:324 Miao:185 Plrd:185 Modi:325 Mongolian:326 Mong:326 Mro:188 Mroo:188 Multani:327 Mult:327 Myanmar:328 Mymr:328 Nabataean:191 Nbat:191 Nag_Mundari:192 Nagm:192 Nandinagari:329 Nand:329 New_Tai_Lue:194 Talu:194 Newa:330 Nko:331 Nkoo:331 Nushu:197 Nshu:197 Nyiakeng_Puachue_Hmong:198 Hmnp:198 Ogham:199 Ogam:199 Ol_Chiki:200 Olck:200 Ol_Onal:332 Onao:332 Old_Hungarian:333 Hung:333 Old_Italic:203 Ital:203 Old_North_Arabian:204 Narb:204 Old_Permic:334 Perm:334 Old_Persian:206 Xpeo:206 Old_Sogdian:207 Sogo:207 Old_South_Arabian:208 Sarb:208 Old_Turkic:335 Orkh:335 Old_Uyghur:336 Ougr:336 Oriya:337 Orya:337 Osage:338 Osge:338 Osmanya:213 Osma:213 Pahawh_Hmong:214 Hmng:214 Palmyrene:215 Palm:215 Pau_Cin_Hau:216 Pauc:216 Phags_Pa:339 Phag:339 Phoenician:218 Phnx:218 Psalter_Pahlavi:340 Phlp:340 Rejang:220 Rjng:220 Runic:341 Runr:341 Samaritan:342 Samr:342 Saurashtra:223 Saur:223 Sharada:343 Shrd:343 Shavian:344 Shaw:344 Siddham:226 Sidd:226 SignWriting:227 Sgnw:227 Sidetic:228 Sidt:228 Sinhala:345 Sinh:345 Sogdian:346 Sogd:346 Sora_Sompeng:231 Sora:231 Soyombo:232 Soyo:232 Sundanese:233 Sund:233 Sunuwar:347 Sunu:347 Syloti_Nagri:348 Sylo:348 Syriac:349 Syrc:349 Tagalog:350 Tglg:350 Tagbanwa:351 Tagb:351 Tai_Le:352 Tale:352 Tai_Tham:240 Lana:240 Tai_Viet:241 Tavt:241 Tai_Yo:242 Tayo:242 Takri:353 Takr:353 Tamil:354 Taml:354 Tangsa:245 Tnsa:245 Tangut:355 Tang:355 Telugu:356 Telu:356 Thaana:357 Thaa:357 Thai:358 Tibetan:359 Tibt:359 Tifinagh:360 Tfng:360 Tirhuta:361 Tirh:361 Todhri:362 Todr:362 Tolong_Siki:254 Tols:254 Toto:363 Tulu_Tigalari:364 Tutg:364 Ugaritic:257 Ugar:257 Unknown:258 Zzzz:258 Vai:259 Vaii:259 Vithkuqi:260 Vith:260 Wancho:261 Wcho:261 Warang_Citi:262 Wara:262 Yezidi:365 Yezi:365 Yi:366 Yiii:366 Zanabazar_Square:265 Zanb:265";

// 属性名/值的精确匹配(镜像 __regexp_shim.js __re_uniName/__re_uniResolve)。
function _uniName(tab, name) {
    var key = name + ":";
    var at = tab.indexOf(key);
    while (at >= 0) {
        if (at === 0 || tab.charCodeAt(at - 1) === 32) {
            var j = at + key.length;
            var v = 0;
            while (j < tab.length) {
                var c = tab.charCodeAt(j);
                if (c < 48 || c > 57) break;
                v = v * 10 + (c - 48);
                j = j + 1;
            }
            return v;
        }
        at = tab.indexOf(key, at + 1);
    }
    return -1;
}

// 与 shim 一致:带值仅 gc/General_Category、sc/Script、scx/Script_Extensions;
// 裸名先查二元属性,再查 General_Category 值(Node 对 \p{Adlam} 裸脚本名亦报错)。
function _uniResolve(name, value, hasEq) {
    if (hasEq) {
        if (name.length === 0 || value.length === 0) return -1;
        if (name === "General_Category" || name === "gc") return _uniName(__RE_UN_GC, value);
        if (name === "Script" || name === "sc") return _uniName(__RE_UN_SC, value);
        if (name === "Script_Extensions" || name === "scx") return _uniName(__RE_UN_SCX, value);
        return -1;
    }
    if (name.length === 0) return -1;
    var ti = _uniName(__RE_UN_BIN, name);
    if (ti >= 0) return ti;
    return _uniName(__RE_UN_GC, name);
}

// Unicode "Properties of Strings" 名:仅 v 模式下且为正向、类外时合法。
var STRINGS_PROPS = {
    "RGI_Emoji": 1,
    "RGI_Emoji_ZWJ_Sequence": 1,
    "RGI_Emoji_Tag_Sequence": 1,
    "RGI_Emoji_Flag_Sequence": 1,
    "RGI_Emoji_Modifier_Sequence": 1,
    "Emoji_Keycap_Sequence": 1,
    "Basic_Emoji": 1
};

// \p{…} 花括号内允许的字符:[A-Za-z0-9_=]
// [Wave 8 续] v 模式类集合保留双字符(ClassSetReservedDoublePunctuator):两个相同字符
// 连续出现即恒拒。`&&`(交集)与 `--`(差集)是操作符,不在此列。
function _isReservedDouble(c) {
    return c === "!" || c === "#" || c === "$" || c === "%" || c === "*" ||
           c === "+" || c === "," || c === "." || c === ":" || c === ";" ||
           c === "<" || c === "=" || c === ">" || c === "?" || c === "@" ||
           c === "^" || c === "`" || c === "~";
}

function _isPropCode(c) {
    if (c >= 48 && c <= 57) return true;
    if (c >= 65 && c <= 90) return true;
    if (c >= 97 && c <= 122) return true;
    return c === 95;
}

// flags 校验:允许 d g i m s u v y,不重复,u/v 互斥。返回错误消息或 null。
function _checkFlags(f) {
    var seen = "";
    var i = 0;
    while (i < f.length) {
        var ch = f.charAt(i);
        if ("dgimsuvy".indexOf(ch) < 0 || seen.indexOf(ch) >= 0) {
            return "Invalid regular expression flags: " + f;
        }
        seen = seen + ch;
        i = i + 1;
    }
    if (seen.indexOf("u") >= 0 && seen.indexOf("v") >= 0) {
        return "Invalid regular expression flags: " + f;
    }
    return null;
}

// 扫描 pattern,校验 u/v 模式下的 \p{}/\P{} 属性转义。返回错误消息或 null。
function _scanProps(pattern, modeV) {
    var inClass = false;
    var classNeg = false;   // 类以 ^ 开头(否定类):字符串属性在否定类内非法
    var negPending = false; // 类的下一个字符是否可能是否定 ^(尚未消费首字符)
    var atomSeen = false;   // [W-P9] 自 `[` 或上一个 `&&` 以来是否已消费类集原子
    var i = 0;
    var n = pattern.length;
    while (i < n) {
        var ch = pattern.charAt(i);
        if (ch === "\\") {
            var nx = pattern.charAt(i + 1);
            if (nx === "p" || nx === "P") {
                var neg = nx === "P";
                if (pattern.charAt(i + 2) !== "{") return "Invalid property name";
                var j = i + 3;
                var name = "";
                var value = "";
                var hasEq = false;
                var closed = false;
                while (j < n) {
                    var c = pattern.charAt(j);
                    if (c === "}") { j = j + 1; closed = true; break; }
                    if (c === "=") {
                        if (hasEq) return "Invalid property name";
                        hasEq = true;
                        j = j + 1;
                        continue;
                    }
                    if (!_isPropCode(pattern.charCodeAt(j))) return "Invalid property name";
                    if (hasEq) value = value + c; else name = name + c;
                    j = j + 1;
                }
                if (!closed) return "Invalid property name";
                if (hasEq && (name.length === 0 || value.length === 0)) return "Invalid property name";
                if (!hasEq && name.length === 0) return "Invalid property name";
                if (STRINGS_PROPS[name]) {
                    // 字符串属性:非 v 模式 / \P 负向 / 否定类([^…])内 皆非法;
                    // 正向 v 类内与类外皆合法(Node 对 \p{Emoji_Keycap_Sequence} 于 [a\p{…}b] 接受)。
                    if (!modeV || neg || (inClass && classNeg)) return "Invalid property name";
                } else {
                    if (_uniResolve(name, value, hasEq) < 0) return "Invalid property name";
                }
                // [test262] 类内 \p{} 紧接 '-' 且其后还有原子 → 范围端点 → SyntaxError
                // (u 模式;v 模式 "--" 集合差文法未实现,整族留后续)
                if (!modeV && inClass && pattern.charAt(j) === "-" &&
                    pattern.charAt(j + 1) !== "]" && pattern.charAt(j + 1) !== "") {
                    return "Invalid character class";
                }
                if (inClass) atomSeen = true;   // 属性转义是类集原子
                i = j;
                continue;
            }
            // 非 \p/\P 转义:按转义族整段消费,避免把 \u{...}/\q{...} 的花括号误当量词。
            if (nx === "q" && modeV && pattern.charAt(i + 2) === "{") {
                // v 模式字符串字面量类转义 \q{…}
                var j = i + 3;
                while (j < n && pattern.charAt(j) !== "}") j = j + 1;
                if (j >= n) return "Invalid escape";
                if (inClass) atomSeen = true;   // 字符串字面量是类集原子
                i = j + 1;
                continue;
            }
            if (nx === "u" && pattern.charAt(i + 2) === "{") {
                // 花括号码点 \u{HEX}:消费至 '}'
                var j = i + 3;
                while (j < n && pattern.charAt(j) !== "}") j = j + 1;
                if (j >= n) return "Invalid escape";
                if (inClass) atomSeen = true;
                i = j + 1;
                continue;
            }
            if (nx === "u") { i = i + 6; if (inClass) atomSeen = true; continue; }   // \uXXXX
            if (nx === "x") { i = i + 4; if (inClass) atomSeen = true; continue; }   // \xHH
            i = i + 2;
            if (inClass) atomSeen = true;
            continue;
        }
        if (ch === "[") {
            inClass = true;
            classNeg = pattern.charAt(i + 1) === "^";
            negPending = classNeg;
            atomSeen = false;   // 新类从零计:类首(及 [^ 后)尚无原子
            i = i + 1;
            continue;
        }
        if (ch === "]") { inClass = false; classNeg = false; negPending = false; atomSeen = false; i = i + 1; continue; }
        if (inClass) {
            // 类首字符:若是否定 ^,只是标记,不是原子;处理完首字符后 negPending 复位,
            // 使类内后续 `^`(如 [^^a] 的第二个 ^)恢复为普通字面原子。
            if (negPending) {
                negPending = false;
                if (ch === "^") { i = i + 1; continue; }
            }
            // [W-P9] v 模式类集交集操作符 &&:要求左、右操作数齐全。
            // 单 & 是字面原子(Node 对拍 `[&]`/`[a&b]`/`[a&]`/`[&a]` 皆收),不拒。
            if (modeV && ch === "&") {
                if (pattern.charAt(i + 1) === "&") {
                    if (!atomSeen) return "Invalid set operation in character class";
                    var nxt = pattern.charAt(i + 2);
                    if (nxt === "]" || nxt === "") return "Invalid set operation in character class";
                    i = i + 2;
                    atomSeen = false;   // 操作数(整条集合表达式)尚待右端原子
                    continue;
                }
                atomSeen = true;
                i = i + 1;
                continue;
            }
            // [Wave 8 续] v 模式类集合语法字符:{ } 恒为 ClassSetSyntaxCharacter → 裸用拒;
            // 双保留符(;; @@ ** !! ## $$ %% ++ ,, .. :: << == >> ?? ^^ `` ~~)为
            // ClassSetReservedDoublePunctuator → 恒拒。单个 ; @ * 等是**字面原子**(Node 对拍
            // `[;]`/`[@]`/`[*]`/`[*a]`/`[a;b]` 皆收,仅 `[;;]`/`[@@]`/`[**]` 拒);& 是 `&&`
            // 操作符(上方已处理)、- 是 `--` 差集操作符(未实现,留后续)。u 模式类内不查。
            if (modeV && (ch === "{" || ch === "}")) {
                return "Invalid character class";
            }
            if (modeV && ch === pattern.charAt(i + 1) && _isReservedDouble(ch)) {
                return "Invalid character class";
            }
            atomSeen = true;
            i = i + 1;
            continue;
        }
        // 类外 u/v 模式量词花括号:未转义 `{` 必须构成有效量词 {n}/{n,}/{n,m};
        // 未转义 `}` 不得单独出现(否则 Node 报 Lone quantifier brackets)。
        if (ch === "{") {
            var j = i + 1;
            var d0 = 0;
            while (j < n && pattern.charAt(j) >= "0" && pattern.charAt(j) <= "9") { j = j + 1; d0 = d0 + 1; }
            var hasComma = false;
            if (j < n && pattern.charAt(j) === ",") { hasComma = true; j = j + 1; }
            var d1 = 0;
            while (j < n && pattern.charAt(j) >= "0" && pattern.charAt(j) <= "9") { j = j + 1; d1 = d1 + 1; }
            if (j >= n || pattern.charAt(j) !== "}") return "Invalid quantifier";
            // {} / {,n} / {,} → d0 为 0,非法;{n} → 无逗号,d0>0 合法;
            // {n,} → 逗号后无数字合法;{n,m} → 逗号后须有数字。
            if (d0 === 0) return "Invalid quantifier";
            if (hasComma && d1 === 0 && j < n && pattern.charAt(j) === "}") { /* {n,} 合法 */ }
            else if (hasComma && d1 === 0) return "Invalid quantifier";
            i = j + 1;
            continue;
        }
        if (ch === "}") return "Lone quantifier brackets";
        i = i + 1;
    }
    return null;
}

// 入口:返回错误消息或 null(合法)。在 parseRegexLiteral 中调用,非空即记 SyntaxError。
export function validateRegexLiteral(pattern, flags) {
    var flagErr = _checkFlags(flags);
    if (flagErr !== null) return flagErr;
    var modeU = flags.indexOf("u") >= 0;
    var modeV = flags.indexOf("v") >= 0;
    if (!modeU && !modeV) return null;   // 非 u/v 模式 \p 是身份转义,不做量词/属性校验
    return _scanProps(pattern, modeV);
}
