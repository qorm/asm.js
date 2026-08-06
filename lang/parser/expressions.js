// asm.js 解析器 - 表达式解析
// 解析 JavaScript 表达式

import { TokenType } from "../lexer/token.js";
import * as AST from "./ast.js";
import { Precedence } from "./precedence.js";
import { validateRegexLiteral } from "./regexp-validate.js";

// 表达式解析混入
export const ExpressionParser = {
    // ============ 解析表达式 ============

    parseExpression(precedence) {
        // [安全] 递归深度守卫(见 parser/index.js 构造器):深层嵌套 ( / [ / { 会耗尽原生栈。
        this.parseDepth = this.parseDepth + 1;
        if (this.parseDepth > this.maxParseDepth) {
            this.parseDepth = this.parseDepth - 1;
            this.errors.push(`SyntaxError: Maximum parse depth exceeded at line ${this.curToken.line}:${this.curToken.column}`);
            return null;
        }
        if (process.env.DEBUG_PARSER) {
            console.log(`[DEBUG_PARSER] parseExpression(${precedence}) start curToken=${this.curToken.type}(${this.curToken.literal}) line=${this.curToken.line}:${this.curToken.column}`);
        }
        let prefix = this.prefixParseFns[this.curToken.type];
        if (!prefix) {
            this.errors.push(`no prefix parse function for ${this.curToken.type} (${this.curToken.literal}) at line ${this.curToken.line}:${this.curToken.column}`);
            this.parseDepth = this.parseDepth - 1;
            return null;
        }
        let leftExp = prefix();
        while (!this.peekTokenIs(TokenType.SEMICOLON) && precedence < this.peekPrecedence()) {
            if (process.env.DEBUG_PARSER) {
                console.log(`[DEBUG_PARSER] parseExpression(${precedence}) while peekToken=${this.peekToken.type}(${this.peekToken.literal}) peekPrecedence=${this.peekPrecedence()}`);
            }
            let infix = this.infixParseFns[this.peekToken.type];
            if (!infix) { this.parseDepth = this.parseDepth - 1; return leftExp; }
            // [test262 早期错误 G] 后缀 ++/-- 与左操作数之间禁有 LineTerminator(no LineTerminator
            // here):`i\n++j` 不是 `i++` 而是 ASI 后的 `i; ++j`。curToken 是左操作数末 token,
            // peekToken 是 ++/--;不同行即停止本表达式(交回语句层按 ASI/前缀解析),不消费 ++。
            // 仅后缀(中缀)INCREMENT/DECREMENT 受此约束;前缀 ++ 走 prefix 路径不受影响。
            if ((this.peekToken.type === TokenType.INCREMENT || this.peekToken.type === TokenType.DECREMENT) &&
                this.curToken.line !== this.peekToken.line) {
                this.parseDepth = this.parseDepth - 1;
                return leftExp;
            }
            this.nextToken();
            leftExp = infix(leftExp);
        }
        this.parseDepth = this.parseDepth - 1;
        return leftExp;
    },

    parseIdentifier() {
        const ident = new AST.Identifier(this.curToken.literal);
        // [W-P9] 裸私有名引用(`#x in o` 品牌检查等;词法已把 `#x` 合并为单个 IDENT)。
        // 收集进引用表供类体收尾校验;类体外(classDepth===0)留既有缺口不处理。
        if (this.classDepth > 0 && this.curToken.literal && this.curToken.literal.charAt(0) === "#") {
            this._recordPrivateRef(this.curToken.literal);
        }
        // [Wave 8] 字段初始化器 ContainsArguments:init 上下文(穿透箭头)内 `arguments`
        // 标识符引用是早期错误(函数边界已复位 _inFieldInit)。
        if (this._inFieldInit && this.curToken.literal === "arguments") {
            this.errors.push(`'arguments' is not allowed in class field initializer at line ${this.curToken.line}`);
        }
        // [Wave 8] yield/await 作标识符引用(仅转义形态 yield/await 落此路径;未转义
        // 走 YIELD/AWAIT 记号)在生成器/异步函数内是早期错误。绑定位由 checkYieldAwaitBinding 覆盖。
        if (this.fnGenDepth > 0 && this.curToken.literal === "yield") {
            this.errors.push("Cannot use 'yield' as an identifier in a generator");
        }
        if (this.fnAsyncDepth > 0 && this.curToken.literal === "await") {
            this.errors.push("Cannot use 'await' as an identifier in an async function");
        }
        // 检查是否是无括号单参数箭头函数: x => expr
        if (this.peekTokenIs(TokenType.ARROW)) {
            this.nextToken(); // 消费 =>
            return this.parseArrowFunctionBody([ident]);
        }
        return ident;
    },

    parseNumberLiteral() {
        const raw = this.curToken.literal;
        // 进制前缀（0x/0b/0o）恒整数：其中 e/E 是十六进制数字，不是浮点指数。
        // 否则 0x9e670000 含 'e' 走 parseFloat("0x9e670000")=0 → 汇编器 hex 编码常量塌成 0。
        const isRadix = raw.length > 2 && raw.charAt(0) === "0" &&
            (raw.charAt(1) === "x" || raw.charAt(1) === "X" ||
             raw.charAt(1) === "o" || raw.charAt(1) === "O" ||
             raw.charAt(1) === "b" || raw.charAt(1) === "B");
        if (!isRadix && (raw.includes(".") || raw.includes("e") || raw.includes("E"))) {
            return new AST.Literal(parseFloat(raw), raw);
        } else {
            // 处理进制前缀：parseInt 不识别 0o/0b（→0，如 0o644 变 0），须显式按进制解析。
            let val;
            if (raw.length > 2 && raw.charAt(0) === "0" && (raw.charAt(1) === "x" || raw.charAt(1) === "X")) {
                val = parseInt(raw.slice(2), 16);
            } else if (raw.length > 2 && raw.charAt(0) === "0" && (raw.charAt(1) === "o" || raw.charAt(1) === "O")) {
                val = parseInt(raw.slice(2), 8);
            } else if (raw.length > 2 && raw.charAt(0) === "0" && (raw.charAt(1) === "b" || raw.charAt(1) === "B")) {
                val = parseInt(raw.slice(2), 2);
            } else {
                val = parseInt(raw, 10);
            }
            return new AST.Literal(val, raw);
        }
    },

    parseBigIntLiteral() {
        // The 'n' suffix is stripped at tokenization; raw 形如 "0xff" / "255" / "0b101"。
        const raw = this.curToken.literal;
        return new AST.Literal(this.bigIntFromLiteral(raw), raw);
    },

    // 把 BigInt 字面量字符串精确转成 64 位 BigInt 值。
    // 关键：自举编译器(gen1)运行时的 BigInt("0x..") 经 _number_coerce→float64→fcvtzs
    // 路径会丢失低位，且运行时 BigInt 乘法与「BigInt 循环累加」均不可靠（返回 0）。
    // 编译器源码充斥 0x7ffd000000000000n 之类 NaN-boxing 常量，若用 BigInt(raw) 解析，
    // gen0(node 原生 BigInt) 精确、gen1(float 路径) 塌成 0 → gen2 全部装箱 tag/mask 错乱、
    // 对象被误读(count>0/props=0) → 启动即崩。故这里手工按 32 位半字拆解，
    // 仅用移位/或（gen1 可靠）合成，保证 gen0 与 gen1 逐字节一致。
    bigIntFromLiteral(raw) {
        const p2 = raw.length >= 2 ? (raw.charAt(0) + raw.charAt(1)) : "";
        if (p2 === "0x" || p2 === "0X") {
            return this.radixHalvesToBigInt(raw.slice(2), 16, 8);
        }
        if (p2 === "0b" || p2 === "0B") {
            return this.radixHalvesToBigInt(raw.slice(2), 2, 32);
        }
        if (p2 === "0o" || p2 === "0O") {
            // 八进制非 32 位对齐；八进制 BigInt 极少见，逐位用 Number 累加后单次装箱。
            let n = 0;
            for (let i = 0; i < raw.length - 2; i++) {
                n = n * 8 + (raw.charCodeAt(i + 2) - 48);
            }
            return BigInt(n);
        }
        // 十进制：运行时 BigInt(十进制串) 对本编译器所用（低位为 0 的）常量足够精确。
        return BigInt(raw);
    },

    // 把 base 进制数字串按每 digitsPerHalf 位一段拆成低/高两个 ≤32 位半字，
    // 用 Number 循环（可靠）解析每段，再用移位/或（可靠）合成 64 位 BigInt，
    // 全程规避运行时 BigInt 乘法/循环累加/BigInt(进制串) 的缺陷。
    radixHalvesToBigInt(digits, base, digitsPerHalf) {
        // 截断到 64 位：保留最低 2*digitsPerHalf 位数字（编译器 BigInt 常量均 ≤64 位）。
        const maxDigits = digitsPerHalf * 2;
        if (digits.length > maxDigits) {
            digits = digits.slice(digits.length - maxDigits);
        }
        let lowStr, highStr;
        if (digits.length > digitsPerHalf) {
            highStr = digits.slice(0, digits.length - digitsPerHalf);
            lowStr = digits.slice(digits.length - digitsPerHalf);
        } else {
            highStr = "";
            lowStr = digits;
        }
        const low = this.parseRadixToNumber(lowStr, base);
        const high = this.parseRadixToNumber(highStr, base);
        // 高半字左移 (digitsPerHalf * log2(base)) 位；hex→32、binary→32。
        const shift = base === 16 ? 32n : (base === 2 ? 32n : 0n);
        return (BigInt(high) << shift) | BigInt(low);
    },

    // 用 Number 运算把 ≤32 位的 base 进制串解析成 Number（安全，< 2^32 < 2^53）。
    parseRadixToNumber(str, base) {
        let n = 0;
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            let d;
            if (c >= 97) { d = c - 87; }        // a-f
            else if (c >= 65) { d = c - 55; }   // A-F
            else { d = c - 48; }                // 0-9
            n = n * base + d;
        }
        return n;
    },

    parseRegexLiteral() {
        const raw = this.curToken.literal;
        // 提取 pattern 和 flags。手动从末尾扫最后一个 "/"（不用 lastIndexOf——
        // 自举运行时 String.lastIndexOf 有 bug 会崩，parse 到含正则字面量的模块即崩）。
        let lastSlash = -1;
        for (let i = raw.length - 1; i > 0; i = i - 1) {
            if (raw.charAt(i) === "/") { lastSlash = i; break; }
        }
        const pattern = raw.substring(1, lastSlash);
        const flags = raw.substring(lastSlash + 1);
        // [Wave 8] 解析时早期错误校验:非法 flags、u/v 模式下 \p{}/\P{} 属性转义结构/名称、
        // 量词花括号、类内 \p{} 作范围端点等 → 记 SyntaxError(与 Node 对拍,零误拒见台账)。
        const regexErr = validateRegexLiteral(pattern, flags);
        if (regexErr !== null) {
            this.errors.push("SyntaxError: " + regexErr + " in regular expression at line " + this.curToken.line + ":" + this.curToken.column);
        }
        return new AST.RegexLiteral(pattern, flags, raw);
    },

    parseStringLiteral() {
        return new AST.Literal(this.curToken.literal, '"' + this.curToken.literal + '"');
    },

    // [#34] tag`a${x}b` → CallExpression(tag, [ArrayExpression(["a","b"]), x])
    // (解析期脱糖,零 codegen)。cooked 数组正常;但 strings.raw 需数组自定义属性,asm.js 数组
    // 暂不支持(赋任意字符串键会毁堆),故普通 tag 的 strings.raw 仍缺(记偏差,见报告)。
    // String.raw`...` 特化:脱糖为 raw quasi 与表达式的字符串拼接,不依赖数组 .raw,可用。
    parseTaggedTemplate(tag) {
        let tpl;
        // [Wave 8 续] tagged 模板不校验转义:tag`\9` / String.raw`\9` raw 原样合法。
        this._taggedTemplate = this._taggedTemplate + 1;
        if (this.curToken.type === TokenType.TEMPLATE_STRING) {
            tpl = this.parseTemplateLiteral();
        } else {
            tpl = this.parseTemplateLiteralWithExpressions();
        }
        this._taggedTemplate = this._taggedTemplate - 1;
        if (!tpl) return null;
        const quasis = tpl.quasis || [];
        const exprs = tpl.expressions || [];

        // String.raw`...` 识别:tag 为非计算成员 String.raw
        if (tag && tag.type === "MemberExpression" && !tag.computed &&
            tag.object && tag.object.type === "Identifier" && tag.object.name === "String" &&
            tag.property && tag.property.type === "Identifier" && tag.property.name === "raw") {
            let result = new AST.Literal(this._quasiRawText(quasis[0]), null);
            for (let i = 0; i < exprs.length; i++) {
                result = new AST.BinaryExpression("+", result, exprs[i]);
                result = new AST.BinaryExpression("+", result, new AST.Literal(this._quasiRawText(quasis[i + 1]), null));
            }
            return result;
        }

        // 自定义 tag:第一实参为 strings 数组,并经 __attachRaw 内建(codegen 认名分派,
        // 同 __syscall 模式——非合成 shim 调用,无跨作用域陷阱)把 raw 文本数组挂到
        // strings 数组的属性侧表(.raw),且按站点缓存(node 语义:模板对象每站点同一)。
        const strs = new AST.ArrayExpression(
            quasis.map((q) => new AST.Literal(q.value.cooked, q.value.raw))
        );
        const raws = new AST.ArrayExpression(
            quasis.map((q) => new AST.Literal(this._quasiRawText(q), null))
        );
        const strsWithRaw = new AST.CallExpression(new AST.Identifier("__attachRaw"), [strs, raws]);
        const args = [strsWithRaw].concat(exprs);
        return new AST.CallExpression(tag, args);
    },

    // quasi 的 raw 源文本(反斜杠转义原样);缺失时回退 cooked。
    _quasiRawText(q) {
        if (q && q.value && q.value.rawText !== undefined && q.value.rawText !== null) {
            return q.value.rawText;
        }
        return q && q.value ? q.value.cooked : "";
    },

    parseTemplateLiteral() {
        // [Wave 8 续] 裸模板非法转义校验(tagged 已跳过;tag`\9` 合法)。
        if (this._taggedTemplate === 0) {
            const tplErr = this._validateTemplateRaw(this.curToken.templateRaw);
            if (tplErr !== null) this.errors.push(tplErr + " at line " + this.curToken.line);
        }
        let quasi = {
            type: "TemplateElement",
            value: { raw: this.curToken.literal, cooked: this.curToken.literal, rawText: this.curToken.templateRaw },
            tail: true,
        };
        return new AST.TemplateLiteral([quasi], []);
    },

    // [Wave 8 续] 裸模板转义序列校验(Node 对拍):\8/\9、\1-\7、\0 后随数字(legacy 八进制)、
    // 坏 \uXXXX/\u{…}/\xHH 一律 SyntaxError;tagged 模板跳过(parseTaggedTemplate 置深度)。
    // 返回错误消息或 null。
    _validateTemplateRaw(raw) {
        if (!raw) return null;
        const n = raw.length;
        for (let i = 0; i < n; i++) {
            if (raw.charAt(i) !== "\\") continue;
            const c = raw.charAt(i + 1);
            if (c === "u") {
                if (raw.charAt(i + 2) === "{") {
                    let j = i + 3;
                    let any = false;
                    while (j < n && raw.charAt(j) !== "}") {
                        if (!this._isHexDigit(raw.charAt(j))) return "Invalid Unicode escape sequence in template literal";
                        any = true;
                        j = j + 1;
                    }
                    if (!any || j >= n) return "Invalid Unicode escape sequence in template literal";
                    i = j;
                } else {
                    for (let k = 1; k <= 4; k++) {
                        if (!this._isHexDigit(raw.charAt(i + 1 + k))) return "Invalid Unicode escape sequence in template literal";
                    }
                    i = i + 5;
                }
            } else if (c === "x") {
                for (let k = 1; k <= 2; k++) {
                    if (!this._isHexDigit(raw.charAt(i + 1 + k))) return "Invalid hex escape sequence in template literal";
                }
                i = i + 3;
            } else if (c >= "0" && c <= "9") {
                if (c === "8" || c === "9") return "Invalid octal escape sequence in template literal";
                if (c === "0") {
                    if (this._isDigitChar(raw.charAt(i + 2))) return "Invalid octal escape sequence in template literal";
                    i = i + 1;
                } else {
                    return "Invalid octal escape sequence in template literal";
                }
            } else {
                i = i + 1;   // \n \\ \' 等合法转义
            }
        }
        return null;
    },
    _isHexDigit(c) {
        return (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
    },
    _isDigitChar(c) {
        return c >= "0" && c <= "9";
    },

    parseTemplateLiteralWithExpressions() {
        let quasis = [];
        let expressions = [];

        // [Wave 8 续] 裸模板非法转义校验(tagged 已跳过)。
        if (this._taggedTemplate === 0) {
            const tplErr = this._validateTemplateRaw(this.curToken.templateRaw);
            if (tplErr !== null) this.errors.push(tplErr + " at line " + this.curToken.line);
        }
        let firstQuasi = {
            type: "TemplateElement",
            value: { raw: this.curToken.literal, cooked: this.curToken.literal, rawText: this.curToken.templateRaw },
            tail: false,
        };
        quasis.push(firstQuasi);

        while (true) {
            this.nextToken();
            // 模板替换位的文法是 **Expression**(含逗号序列):`${a = 1}` / `${(a, b)}`。
            // 此前传 ASSIGN(3) → Pratt 循环 `3 < 3` 假,`=`/`+=` 不被消费,报
            // "unexpected token in template literal: ="。LOWEST 让赋值与逗号都并入;
            // 终结符 TEMPLATE_MIDDLE/TEMPLATE_TAIL 无中缀优先级,循环自然停下。
            let expr = this.parseExpression(Precedence.LOWEST);
            expressions.push(expr);
            this.nextToken();

            let quasi = {
                type: "TemplateElement",
                value: { raw: this.curToken.literal, cooked: this.curToken.literal, rawText: this.curToken.templateRaw },
                tail: this.curToken.type === TokenType.TEMPLATE_TAIL,
            };
            // [Wave 8 续] 中段/尾段 quasi 同样校验(tagged 已跳过)。
            if (this._taggedTemplate === 0) {
                const qErr = this._validateTemplateRaw(this.curToken.templateRaw);
                if (qErr !== null) this.errors.push(qErr + " at line " + this.curToken.line);
            }
            quasis.push(quasi);

            if (this.curToken.type === TokenType.TEMPLATE_TAIL) {
                break;
            }
            if (this.curToken.type !== TokenType.TEMPLATE_MIDDLE) {
                this.errors.push("unexpected token in template literal: " + this.curToken.type);
                return null;
            }
        }
        return new AST.TemplateLiteral(quasis, expressions);
    },

    parseBooleanLiteral() {
        return new AST.Literal(this.curTokenIs(TokenType.TRUE), this.curToken.literal);
    },

    parseNullLiteral() {
        return new AST.Literal(null, "null");
    },

    parseUndefinedLiteral() {
        return new AST.Literal(undefined, "undefined");
    },

    parsePrefixExpression() {
        let operator = this.curToken.literal;
        const opLine = this.curToken.line;
        const opColumn = this.curToken.column;
        this.nextToken();
        const arg = this.parseExpression(Precedence.PREFIX);
        // [test262 S1] strict 模式下 `delete` 裸变量引用是早期错误(Node 抛 SyntaxError)。
        // 仅当操作数是裸标识符时触发;`delete obj.p` / `delete obj[k]`(成员/下标)仍合法。
        if (operator === "delete" && arg && arg.type === "Identifier" && this.inStrictMode()) {
            this.errors.push(`Delete of an unqualified identifier in strict mode at line ${opLine}:${opColumn}`);
        }
        // [Wave 8] `delete` 私有名成员引用(最终访问是 .#name)恒为早期错误,与声明与否无关:
        // delete o.#x / delete (g()).#m / delete this.#m。`delete o.#x.y`/`delete o.#x[0]`/
        // `delete this.#m()` 的操作数最终属性非私有名,仍合法(Node 对拍)。
        if (operator === "delete" && arg && arg.type === "MemberExpression" &&
            arg.property && arg.property.type === "PrivateIdentifier") {
            this.errors.push(`Private fields can not be deleted at line ${opLine}:${opColumn}`);
        }
        // [Wave 8] yield 不是 UnaryExpression:生成器内 `void yield`/`typeof yield`/`!yield`/
        // `delete yield` 等一元操作数位是早期错误(Node 对拍)。await 是 UnaryExpression(`void await x`
        // 合法),不入此查。
        if (this.fnGenDepth > 0 && arg && arg.type === "YieldExpression") {
            this.errors.push(`'yield' cannot be used as the operand of '${operator}' in a generator at line ${opLine}:${opColumn}`);
        }
        return new AST.UnaryExpression(operator, arg, true);
    },

    // [test262 S1] 当前是否处于 strict 模式:顶层程序指令 或 函数体 "use strict" 指令。
    inStrictMode() {
        // 类体隐式 strict(classDepth>0):类名不可用 let/yield/static、delete 标识符抛错等
        return this.programStrict || this.fnStrictDepth > 0 || this.classDepth > 0;
    },

    parseAwaitExpression() {
        // [L2-④] await 只能在 async 函数(含 async-gen)内出现;非异步上下文(模块顶层/
        // 类体隐式 strict/strict 模式)中 await 是保留字,恒 SyntaxError。
        if (this.fnAsyncDepth === 0) {
            this.errors.push("await expression not allowed outside of an async function");
        }
        if (this._inFormalParams && this.fnAsyncDepth > 0) {
            this.errors.push("await expression not allowed in formal parameter of async function");
        }
        this.nextToken();
        return new AST.AwaitExpression(this.parseExpression(Precedence.PREFIX));
    },

    parsePrefixUpdateExpression() {
        let operator = this.curToken.literal;
        this.nextToken();
        const arg = this.parseExpression(Precedence.PREFIX);
        // [Wave 8] 生成器内 `++yield`/`--yield`:yield 不能作自增自减操作数。
        if (this.fnGenDepth > 0 && arg && arg.type === "YieldExpression") {
            this.errors.push(`'yield' cannot be used as the operand of '${operator}' in a generator`);
        }
        this.checkAssignmentTarget(arg, false);   // [test262 S1] ++/-- 左值校验(不允许模式)
        return new AST.UpdateExpression(operator, arg, true);
    },

    parsePostfixUpdateExpression(left) {
        this.checkAssignmentTarget(left, false);   // [test262 S1] ++/-- 左值校验(不允许模式)
        return new AST.UpdateExpression(this.curToken.literal, left, false);
    },

    parseBinaryExpression(left) {
        let operator = this.curToken.literal;
        let precedence = this.curPrecedence();
        // [test262 早期错误 G] `**` 左操作数不得是未加括号的一元表达式:-x ** 2 / !x ** 2 /
        // typeof x ** 2 / delete o.p ** 2 皆 SyntaxError;(-x) ** 2 与 ++x ** 2(UpdateExpression
        // 非 UnaryExpression)合法。右操作数允许一元(2 ** -3 合法),故只查 left。
        if (operator === "**" && left && left.type === "UnaryExpression" && !left._parenthesized) {
            this.errors.push("Unary operator may not be applied to the left-hand side of '**' without parentheses");
        }
        this.nextToken();
        // ** 右结合:右操作数用 precedence-1,使 2**3**2 解析为 2**(3**2)=512(非 (2**3)**2=64)。
        const rightPrec = operator === "**" ? precedence - 1 : precedence;
        return new AST.BinaryExpression(operator, left, this.parseExpression(rightPrec));
    },

    parseLogicalExpression(left) {
        let operator = this.curToken.literal;
        let precedence = this.curPrecedence();
        this.nextToken();
        let right = this.parseExpression(precedence);
        // [test262 早期错误 G] ?? 不得与 && / || 在无括号时混用(a ?? b && c / a && b ?? c 等)。
        // 仅当冲突侧操作数是「未加括号」的逻辑表达式(非 parseGroupedOrArrow 产出,无
        // _logicalGrouped 标记)时报错;(a ?? b) && c / a ?? (b && c) / a ?? b ?? c 皆合法。
        const isCoalesce = operator === "??";
        if (isCoalesce || operator === "&&" || operator === "||") {
            const mixes = (n) => n && n.type === "LogicalExpression" && !n._parenthesized &&
                (isCoalesce ? (n.operator === "&&" || n.operator === "||") : (n.operator === "??"));
            if (mixes(left) || mixes(right)) {
                this.errors.push("Cannot mix '??' with '&&' or '||' without parentheses");
            }
        }
        return new AST.LogicalExpression(operator, left, right);
    },

    // [test262 S1 早期错误] 校验赋值/更新左值的 AssignmentTargetType。只拒 node 同样拒绝的
    // 非法形态(对自举源码零误拒):合法左值 = Identifier / 非可选链 MemberExpression;`=` 额外
    // 允许数组·对象解构模式;复合赋值(+=等)与自增/自减不允许模式。其余(BinaryExpression、
    // LogicalExpression、CallExpression、字面量、null/true、UpdateExpression、含 ?. 的成员)一律报错。
    checkAssignmentTarget(left, allowPattern) {
        if (!left) return;
        const t = left.type;
        const isPattern = t === "ArrayExpression" || t === "ObjectExpression" ||
                          t === "ArrayPattern" || t === "ObjectPattern";
        if (isPattern) {
            if (!allowPattern) this.errors.push("Invalid left-hand side in assignment");
            else this.checkPatternTargets(left);
            return;
        }
        if (t === "Identifier") {
            // [test262 S1] strict 下 eval/arguments 不可作赋值/自增左值(`(arguments) = 20`)。
            // 非 strict 一律放行;自举源码无 "use strict" 指令 → 此分支对其恒不触发。
            if (this.inStrictMode() && (left.name === "eval" || left.name === "arguments")) {
                this.errors.push("Invalid left-hand side in assignment");
            }
            return;
        }
        if (t === "MemberExpression") {
            if (left.optional === true) this.errors.push("Invalid left-hand side in assignment");
            return;
        }
        this.errors.push("Invalid left-hand side in assignment");
    },

    // [test262 S1 早期错误] 解构赋值模式内层目标位的最小校验:只拒 **SequenceExpression**
    // (`[(x, y)] = []` / `[...[(x, y)]] = [[]]` / `({a: (x, y)} = {})`)。ES 规定
    // DestructuringAssignmentTarget 必须是 LeftHandSideExpression,逗号序列绝无可能;
    // 其它形态(成员表达式、嵌套模式、默认值)一律放行,保证对自举源码零误拒。
    // 只看**目标位**:AssignmentExpression 只查 .left(`[a = (1,2)]` 的右值是合法序列),
    // SpreadElement 查 .argument,对象属性查 .value。
    checkPatternTargets(node) {
        if (!node) return;
        const t = node.type;
        if (t === "SequenceExpression") {
            this.errors.push("Invalid destructuring assignment target");
            return;
        }
        if (t === "ArrayExpression" || t === "ArrayPattern") {
            const els = node.elements;
            if (!els) return;
            for (let i = 0; i < els.length; i++) this.checkPatternTargets(els[i]);
            return;
        }
        if (t === "ObjectExpression" || t === "ObjectPattern") {
            const props = node.properties;
            if (!props) return;
            for (let i = 0; i < props.length; i++) {
                const p = props[i];
                if (!p) continue;
                if (p.type === "SpreadElement") this.checkPatternTargets(p.argument);
                else this.checkPatternTargets(p.value);
            }
            return;
        }
        if (t === "SpreadElement") { this.checkPatternTargets(node.argument); return; }
        if (t === "AssignmentExpression" || t === "AssignmentPattern") { this.checkPatternTargets(node.left); return; }
    },

    parseAssignmentExpression(left) {
        let operator = this.curToken.literal;
        this.checkAssignmentTarget(left, operator === "=");
        this.nextToken();
        return new AST.AssignmentExpression(operator, left, this.parseExpression(Precedence.ASSIGN - 1));
    },

    parseConditionalExpression(test) {
        this.nextToken();
        let consequent = this.parseExpression(Precedence.ASSIGN - 1);
        if (!this.expectPeek(TokenType.COLON)) return null;
        this.nextToken();
        return new AST.ConditionalExpression(test, consequent, this.parseExpression(Precedence.TERNARY - 1));
    },

    parseGroupedOrArrow() {
        this.nextToken();
        if (this.curTokenIs(TokenType.RPAREN)) {
            if (this.peekTokenIs(TokenType.ARROW)) {
                this.nextToken();
                return this.parseArrowFunctionBody([]);
            }
        }
        let params = [];
        let isArrowMode = false;

        // [seq] 箭头形参 vs 括号表达式的判别统一走 **token 级平衡前扫**:快照后从 `(` 内
        // 平衡扫到外层 `(` 的闭合 `)`,看其后是否紧跟 `=>`,再恢复。此前是启发式
        // (`(a,` / `(...` / `(a)` 且下一字符是 `=`),对 `(a, b)`、`(a) == b` 误判成箭头,
        // 而形参循环见不到 `=>` 时既不回退也不报错 —— curToken 卡在 `)`,落到下面的
        // parseExpression 报 "no prefix parse function for )":括号序列表达式因此完全
        // 无法解析。前扫是精确判别,`({a})=>` / `([a])=>` 这类解构参数箭头(与括号对象/
        // 数组字面量同形,唯尾随 `=>` 可辨)也一并由它认出。
        // 前置门槛:只有形参列表可能的首 token(IDENT / ... / { / [)才值得前扫,
        // 免得给 `(1+2)`、`(x.y)` 之外的常见分组白付一次扫描。
        if (this.curTokenIs(TokenType.IDENT) || this.curTokenIs(TokenType.SPREAD) ||
            this.curTokenIs(TokenType.LBRACE) || this.curTokenIs(TokenType.LBRACKET)) {
            const snap = this.saveState();
            let depth = 1; // 已在外层 ( 内(parseGroupedOrArrow 起始 nextToken 消费了 ()
            let looksArrow = false;
            while (!this.curTokenIs(TokenType.EOF)) {
                const t = this.curToken.type;
                if (t === TokenType.LPAREN || t === TokenType.LBRACE || t === TokenType.LBRACKET) {
                    depth++;
                } else if (t === TokenType.RPAREN || t === TokenType.RBRACE || t === TokenType.RBRACKET) {
                    depth--;
                    if (depth === 0) { looksArrow = this.peekTokenIs(TokenType.ARROW); break; }
                }
                this.nextToken();
            }
            this.restoreState(snap);
            if (looksArrow) isArrowMode = true;
        }

        if (isArrowMode) {
            // 前扫已确认尾随 `=>`。形参循环若仍走不到 `) =>`(形参形态不受支持/非法),
            // 保留期间产生的错误,再回退按表达式重解析:既不丢早期错误(restoreState 会把
            // 错误截回快照水位),也保住既有的宽松恢复行为。parseDepth 单独存,
            // 因 parseFunctionParam 会递归下钻。
            const arrowSnap = this.saveState();
            const arrowDepth = this.parseDepth;
            const errMark = this.errors.length;
            while (true) {
                // [#34] 统一走 parseFunctionParam:获得默认值(AssignmentPattern)
                // 与 rest 支持,与 function 声明形参同构。单参默认 `(y=5)=>` 因
                // 与分组赋值二义仍不支持(须多参或裸参形态)。
                // 经 pushFunctionParam 而非直接 push:rest 模式目标(`(...[a,b]) => …`)
                // 需要展开出影子参数(见 parser/statements.js 的 pushFunctionParam),
                // 否则 gather 与 destructure 两步接不上。
                let arrowParam = this.parseFunctionParam(true);
                this.pushFunctionParam(params, arrowParam);
                this.nextToken();
                // [test262 早期错误 D] rest 形参必须末位且不得带尾逗号:`(...a, b) => …` /
                // `(...a,) => …`。nextToken 后 cur 是分隔符;rest(SpreadElement)后随逗号即非法。
                if (arrowParam && arrowParam.type === "SpreadElement" && this.curTokenIs(TokenType.COMMA)) {
                    this.errors.push("Rest parameter must be last formal parameter");
                }
                if (this.curTokenIs(TokenType.COMMA)) {
                    this.nextToken();
                    // 尾逗号 (x, y,) =>:逗号后紧跟 ) → 参数列表结束,别把 ) 当形参。
                    if (this.curTokenIs(TokenType.RPAREN)) {
                        if (this.peekTokenIs(TokenType.ARROW)) {
                            this.nextToken();
                            return this.parseArrowFunctionBody(params);
                        }
                        break;
                    }
                } else if (this.curTokenIs(TokenType.RPAREN)) {
                    if (this.peekTokenIs(TokenType.ARROW)) {
                        this.nextToken(); // moves to =>
                        return this.parseArrowFunctionBody(params);
                    }
                    break;
                } else {
                    break;
                }
            }
            // 形参路径未成:先记下期间产生的错误,回退后原样补回,再走普通括号表达式路径
            // (逗号由 COMMA 中缀 → SequenceExpression)。
            const kept = [];
            for (let i = errMark; i < this.errors.length; i++) kept.push(this.errors[i]);
            this.restoreState(arrowSnap);
            this.parseDepth = arrowDepth;
            for (let i = 0; i < kept.length; i++) this.errors.push(kept[i]);
            params = [];
        }

        let expr = this.parseExpression(Precedence.LOWEST);
        if (this.curTokenIs(TokenType.RPAREN)) {
            this.nextToken(); // 必须消费掉 )
        } else {
            if (!this.expectPeek(TokenType.RPAREN)) return null;
        }

        if (this.peekTokenIs(TokenType.ARROW) &&
            (expr.type === "Identifier" || expr.type === "SequenceExpression" || expr.type === "AssignmentExpression")) {
            // [#34 续] 单参默认 `(a=7)=>` / 首参默认 `(a=1,b=2)=>`:isArrowMode 检测
            // (curToken=IDENT 且 peek=COMMA/RPAREN)漏掉 peek=ASSIGN 的形态 → 落到这里
            // expr 是 AssignmentExpression/含之的 SequenceExpression。codegen 的默认参数只认
            // AssignmentPattern(left/right),故把 AssignmentExpression 转为 AssignmentPattern
            // (用 AST 类实例,gen2 安全;非默认参保持原节点)。
            this.nextToken();
            const toParam = (e) => e && e.type === "AssignmentExpression"
                ? new AST.AssignmentPattern(e.left, e.right) : e;
            let p;
            if (expr.type === "SequenceExpression") {
                p = expr.expressions.map(toParam);
            } else {
                p = [toParam(expr)];
            }
            return this.parseArrowFunctionBody(p);
        }
        // [test262 早期错误 G] 标记「括号包裹」的表达式:?? 与 &&/|| 混用、`**` 左操作数禁一元
        // 等校验都需区分有无括号(括号重置结合性)。下划线前缀 + 布尔值:编译期各 `for..in`
        // AST 遍历或按 `_` 前缀跳过(compiler/index.js 约定)或因非对象跳过,对 codegen/自举定点零影响。
        if (expr) expr._parenthesized = true;
        return expr;
    },

    parseArrowFunctionBody(params) {
        this.nextToken();
        let body,
            isExpression = false;
        if (this.curTokenIs(TokenType.LBRACE)) {
            // [test262 早期错误 B] 块体箭头带显式 "use strict" 指令时,形参必须是简单形参列表
            // (默认值/剩余/解构皆非法)。cur=`{`,peek=体首 token,peekUseStrictDirective 可探测。
            // 简写体(表达式)无指令可言,不受此约束。仅显式指令触发,隐式 strict 不受影响。
            let isStrict = this.peekUseStrictDirective();
            if (isStrict) { this.fnStrictDepth++; this.checkStrictParams(params); }
            this.checkInheritedStrictParams(params, isStrict);   // [test262 早期错误 C] 继承 strict 重参
            body = this.parseBlockStatement();
            if (isStrict) this.fnStrictDepth--;
        } else {
            // [test262 早期错误 C] 简写体无指令,但继承 strict(程序级/外层 strict/类体)下形参
            // 仍不可重名/eval/arguments。ownStrict 恒 false。
            this.checkInheritedStrictParams(params, false);
            // 箭头简写体是 **AssignmentExpression**:须含赋值运算符(=,+=,*= 等,优先级
            // ASSIGN=3),但不含逗号序列(COMMA=2,`v=>a,b` 应为 `(v=>a),b`)。传 COMMA
            // 优先级:Pratt 循环 `prec < peekPrec` 对赋值 `2<3` 消费、对逗号 `2<2` 不消费。
            // 此前传 ASSIGN(3)→ `3<3` 假 → 赋值不消费,`v=>s+=v`/`forEach(v=>s+=v)` 解析
            // 失败(no prefix parse function for `)`);须加括号 `v=>(s+=v)` 才行。
            body = this.parseExpression(Precedence.COMMA);
            isExpression = true;
        }
        return new AST.ArrowFunctionExpression(params, body, false, isExpression);
    },

    parseObjectPattern(lexical) {
        let pattern = new AST.ObjectPattern();
        if (this.peekTokenIs(TokenType.RBRACE)) {
            this.nextToken();
            return pattern;
        }
        this.nextToken();
        while (!this.curTokenIs(TokenType.RBRACE) && !this.curTokenIs(TokenType.EOF)) {
            // [rest] 对象解构 rest:{a, ...rest} —— 收集其余自有属性成新对象。
            // rest 必须在末位;推入 SpreadElement(Identifier) 后结束。
            if (this.curTokenIs(TokenType.SPREAD)) {
                // 对象 rest 目标必须是标识符(ES:ObjectRestProperty = ...BindingIdentifier,
                // {...{a}} 非法)。数组 rest 才可为模式(见 parseArrayPattern)。
                this.nextToken();
                // [test262 早期错误 A] rest 绑定位:非词形 token(数值/字符串/{/[ 等)一律拒
                // (`var {...123} = o` 此前误收);词形名再按 strict/生成器/异步门控。
                if (!this.isBindingWordToken(this.curToken)) {
                    this.errors.push("expected identifier in object rest pattern");
                    return null;
                }
                this.checkYieldAwaitBinding(this.curToken.literal);   // [test262 S1] {...yield}/{...await}
                this.checkReservedBinding(this.curToken.literal);     // [test262 早期错误 A] {...rest}
                this.checkLexicalLetBinding(this.curToken.literal, lexical);   // [test262 早期错误 A] let/const/catch 下 {...let} 恒拒
                pattern.properties.push(new AST.SpreadElement(new AST.Identifier(this.curToken.literal)));
                break;
            }
            let prop = new AST.AssignmentProperty();
            if (this.curTokenIs(TokenType.LBRACKET)) {
                // [C2] 计算键解构 {[expr]: target}:求值键 expr,必带 `: 目标`(无简写形)。
                prop.computed = true;
                this.nextToken(); // 越过 [,cur = 键表达式首 token
                prop.key = this.parseExpression(Precedence.ASSIGN - 1);
                if (!this.expectPeek(TokenType.RBRACKET)) return null; // cur = ]
                if (!this.expectPeek(TokenType.COLON)) return null;    // cur = :
                this.nextToken();                                      // cur = 目标首 token
                let target = null;
                if (this.curTokenIs(TokenType.LBRACE)) {
                    target = this.parseObjectPattern(lexical);
                } else if (this.curTokenIs(TokenType.LBRACKET)) {
                    target = this.parseArrayPattern(lexical);
                } else if (this.isBindingWordToken(this.curToken)) {
                    // [test262 早期错误 A] 计算键绑定位:`{[k]: eval}` strict 拒,
                    // `{[k]: yield}` 按生成器/strict 门控,`{[k]: if}` 恒拒。
                    this.checkYieldAwaitBinding(this.curToken.literal);
                    this.checkReservedBinding(this.curToken.literal);
                    this.checkLexicalLetBinding(this.curToken.literal, lexical);   // let/const/catch 下 {[k]: let} 恒拒
                    target = new AST.Identifier(this.curToken.literal);
                } else {
                    this.errors.push("expected target in computed object pattern");
                    return null;
                }
                if (this.peekTokenIs(TokenType.ASSIGN)) {
                    this.nextToken();
                    this.nextToken();
                    prop.value = new AST.AssignmentPattern(target, this.parseExpression(Precedence.ASSIGN - 1));
                } else {
                    prop.value = target;
                }
                pattern.properties.push(prop);
                if (this.peekTokenIs(TokenType.COMMA)) {
                    this.nextToken();
                    // 尾逗号:留 cur=, peek=} 给末尾 expectPeek 消费(勿双吞 RBRACE)。
                    if (this.peekTokenIs(TokenType.RBRACE)) {
                        break;
                    }
                    this.nextToken();
                    continue;
                } else {
                    break;
                }
            }
            // 属性名文法是 PropertyName:除标识符外还含字符串/数值字面量与保留字
            // (`{ 0: v }` / `{ 'a-b': v }` / `{ if: v }`)。字面量键无简写形,
            // 必须带 `: 目标`。键统一归一成 Identifier(name=属性字符串),使下游
            // emitBoxedStringKey 走同一条静态键路径(数值按 String(值) 归一:1.0→"1")。
            let keyNeedsColon = false;
            if (this.isBindingWordToken(this.curToken)) {
                // [test262 早期错误 A] 词形键:IDENT 或关键字 token(yield/let/if/async…)。
                // 词形键可落简写绑定位(`{ yield }` sloppy 合法)——键本身不在此查保留字:
                // 带冒号时纯作属性名(`{ if: a }` 合法,永不查);仅简写/简写默认位门控(见下)。
                prop.key = new AST.Identifier(this.curToken.literal);
            } else if (this.curTokenIs(TokenType.STRING)) {
                prop.key = new AST.Identifier(this.curToken.literal);
                keyNeedsColon = true;
            } else if (this.curTokenIs(TokenType.INT) || this.curTokenIs(TokenType.FLOAT)) {
                prop.key = new AST.Identifier(String(this.parseNumberLiteral().value));
                keyNeedsColon = true;
            } else if (this.curTokenIs(TokenType.BIGINT)) {
                // [test262 早期错误 A] BigInt 字面量键:与 INT 键同规——必须带冒号(无简写形,
                // `{1n}` 仍拒),键按数值字符串归一(1n→"1"、0x1n→"1";literal 已去 n 后缀与
                // 分隔符,见 lexer readNumber)。仅属性名位放行;BigInt 不得作绑定目标
                // (`{x: 1n}`/`{...1n}` 仍拒),isBindingWordToken 排除 BIGINT 不变。
                prop.key = new AST.Identifier(String(this.parseBigIntLiteral().value));
                keyNeedsColon = true;
            } else {
                this.errors.push("expected property name in object pattern");
                return null;
            }
            if (keyNeedsColon && !this.peekTokenIs(TokenType.COLON)) {
                this.errors.push("expected : after literal property name in object pattern");
                return null;
            }
            if (this.peekTokenIs(TokenType.COLON)) {
                this.nextToken();
                this.nextToken();
                // [#47] 嵌套解构:值位可为 {..}/[..] 子 pattern(递归),不再限于 Identifier。
                let target = null;
                if (this.curTokenIs(TokenType.LBRACE)) {
                    target = this.parseObjectPattern(lexical);
                } else if (this.curTokenIs(TokenType.LBRACKET)) {
                    target = this.parseArrayPattern(lexical);
                } else if (this.isBindingWordToken(this.curToken)) {
                    // [test262 早期错误 A] 冒号绑定位:`{x: eval}` strict 拒,
                    // `{x: yield}` 按生成器/strict 门控,`{x: if}`/`{x: enum}` 恒拒。
                    this.checkYieldAwaitBinding(this.curToken.literal);
                    this.checkReservedBinding(this.curToken.literal);
                    this.checkLexicalLetBinding(this.curToken.literal, lexical);   // let/const/catch 下 {x: let} 恒拒
                    target = new AST.Identifier(this.curToken.literal);
                } else {
                    this.errors.push("expected identifier in object pattern");
                    return null;
                }
                // 别名/嵌套默认值:{a: b = 9} / {a: {b} = {}}
                if (this.peekTokenIs(TokenType.ASSIGN)) {
                    this.nextToken();
                    this.nextToken();
                    prop.value = new AST.AssignmentPattern(target, this.parseExpression(Precedence.ASSIGN - 1));
                } else {
                    prop.value = target;
                }
            } else if (this.peekTokenIs(TokenType.ASSIGN)) {
                // 简写默认值:{a = 9} —— left 用「新」Identifier 节点(与 key 分离),
                // 使块级改名 pass 只改绑定名(value.left)而不动源键名(prop.key)。
                prop.shorthand = true;
                // [test262 早期错误 A] 简写默认绑定位:`{eval = 1}` strict 拒,`{if = 1}` 恒拒。
                this.checkYieldAwaitBinding(prop.key.name);
                this.checkReservedBinding(prop.key.name);
                this.checkLexicalLetBinding(prop.key.name, lexical);   // let/const/catch 下 {let = 1} 恒拒
                this.nextToken();
                this.nextToken();
                prop.value = new AST.AssignmentPattern(new AST.Identifier(prop.key.name), this.parseExpression(Precedence.ASSIGN - 1));
            } else {
                prop.shorthand = true;
                // [test262 早期错误 A] 简写绑定位:`{eval}` strict 拒,`{if}` 恒拒,
                // `{yield}`/`{await}` 按生成器/异步门控,`{let}`/`{static}` 按 strict 门控。
                this.checkYieldAwaitBinding(prop.key.name);
                this.checkReservedBinding(prop.key.name);
                this.checkLexicalLetBinding(prop.key.name, lexical);   // let/const/catch 下 {let} 恒拒
                prop.value = prop.key;
            }
            pattern.properties.push(prop);
            if (this.peekTokenIs(TokenType.COMMA)) {
                this.nextToken();
                // 尾逗号 {a,}:留 cur=, peek=} 给末尾 expectPeek 消费(勿双吞 RBRACE)。
                if (this.peekTokenIs(TokenType.RBRACE)) {
                    break;
                }
                this.nextToken();
            } else {
                break;
            }
        }
        if (!this.expectPeek(TokenType.RBRACE)) return null;
        return pattern;
    },

    parseArrayPattern(lexical) {
        let pattern = new AST.ArrayPattern();
        if (this.peekTokenIs(TokenType.RBRACKET)) {
            this.nextToken();
            return pattern;
        }
        this.nextToken();
        let restSeen = false;
        while (!this.curTokenIs(TokenType.RBRACKET) && !this.curTokenIs(TokenType.EOF)) {
            if (this.curTokenIs(TokenType.SPREAD)) {
                // [test262 早期错误 G] rest 之前不得再出现 rest([...a, ...b]):rest 必须末位。
                if (restSeen) this.errors.push("Rest element must be last element");
                // [#34] rest 元素 [..., ...rest];[test262 S1] rest 目标可为绑定模式 [...[x]]/[...{a}]
                this.nextToken();
                let restTarget;
                // [test262 早期错误 A] lexical 仅透传给嵌套对象模式;数组绑定位本身无检查(既有缺口)。
                if (this.curTokenIs(TokenType.LBRACE)) restTarget = this.parseObjectPattern(lexical);
                else if (this.curTokenIs(TokenType.LBRACKET)) restTarget = this.parseArrayPattern(lexical);
                else restTarget = new AST.Identifier(this.curToken.literal);
                pattern.elements.push(new AST.SpreadElement(restTarget));
                restSeen = true;   // [test262 S1] rest 必须末位:此后任何元素/空位皆早期错误
                // [test262 S1] BindingRestElement 不得带初值:`[...x = 1]` / `[...[x] = []]` 皆早期错误。
                if (this.peekTokenIs(TokenType.ASSIGN)) {
                    this.errors.push("Rest element may not have a default initializer");
                }
            } else if (this.curTokenIs(TokenType.LBRACE) || this.curTokenIs(TokenType.LBRACKET)) {
                if (restSeen) this.errors.push("Rest element must be last element");
                // [#47] 嵌套解构:元素位可为 {..}/[..] 子 pattern(递归)。
                const sub = this.curTokenIs(TokenType.LBRACE) ? this.parseObjectPattern(lexical) : this.parseArrayPattern(lexical);
                if (this.peekTokenIs(TokenType.ASSIGN)) {
                    this.nextToken();
                    this.nextToken();
                    pattern.elements.push(new AST.AssignmentPattern(sub, this.parseExpression(Precedence.ASSIGN - 1)));
                } else {
                    pattern.elements.push(sub);
                }
            } else if (this.curTokenIs(TokenType.IDENT)) {
                if (restSeen) this.errors.push("Rest element must be last element");
                if (this.peekTokenIs(TokenType.ASSIGN)) {
                    // [#34] 默认值 [a = 9, ...]:ASSIGN-1(=COMMA)防吞逗号(同形参)
                    const did = new AST.Identifier(this.curToken.literal);
                    this.nextToken();
                    this.nextToken();
                    pattern.elements.push(new AST.AssignmentPattern(did, this.parseExpression(Precedence.ASSIGN - 1)));
                } else {
                    pattern.elements.push(new AST.Identifier(this.curToken.literal));
                }
            } else if (this.curTokenIs(TokenType.COMMA)) {
                // [C1] 数组空位 elision:[a,,b] —— 逗号间空元素推 null。此刻 cur 停在
                // 代表空位「之后」的逗号(源自上轮末尾 peek-comma 分隔的二次 nextToken)。
                // cur 本身即分隔逗号,不能再走下方 peek-comma 逻辑;越过它到下一元素后 continue。
                if (restSeen) this.errors.push("Rest element must be last element");   // [test262 S1] [...a,,] rest 后空位
                pattern.elements.push(null);
                if (this.peekTokenIs(TokenType.RBRACKET)) {
                    // [test262 S1] 纯/尾 elision [,]/[a,,]:留 cur=, peek=] 给末尾 expectPeek
                    // 消费(勿在此 nextToken 双吞 RBRACKET,否则 expectPeek 见到 = 报 expected ])。
                    break;
                }
                this.nextToken();
                continue;
            }
            if (this.peekTokenIs(TokenType.COMMA)) {
                this.nextToken();
                // 尾逗号 [a,]:留 cur=, peek=] 给末尾 expectPeek 消费(勿双吞 RBRACKET,
                // 否则 expectPeek 见到 pattern 之后的 token 报 "expected ]")。
                if (this.peekTokenIs(TokenType.RBRACKET)) {
                    break;
                }
                this.nextToken();
            } else {
                break;
            }
        }
        if (!this.expectPeek(TokenType.RBRACKET)) return null;
        return pattern;
    },

    parseArrayLiteral() {
        let elements = [];
        if (this.peekTokenIs(TokenType.RBRACKET)) {
            this.nextToken();
            return new AST.ArrayExpression(elements);
        }
        this.nextToken();
        while (!this.curTokenIs(TokenType.RBRACKET) && !this.curTokenIs(TokenType.EOF)) {
            // 空位 elision [1,,3]/[,,,]:cur 停在代表空位的逗号,推 hole 标记(null),
            // 越过该逗号到下一元素(镜像 parseArrayPattern)。codegen 把 null 元素填 undefined。
            if (this.curTokenIs(TokenType.COMMA)) {
                elements.push(null);
                if (this.peekTokenIs(TokenType.RBRACKET)) {
                    this.nextToken();
                    return new AST.ArrayExpression(elements);
                }
                this.nextToken();
                continue;
            }
            if (this.curTokenIs(TokenType.SPREAD)) {
                this.nextToken();
                elements.push(new AST.SpreadElement(this.parseExpression(Precedence.ASSIGN - 1)));
            } else {
                // 元素是 AssignmentExpression 位:用 ASSIGN-1 使顶层赋值被吞并
                // (`[a = 1]` / 解构赋值默认 `[a, b = 9] = arr`);逗号(COMMA<ASSIGN)仍不吞。
                elements.push(this.parseExpression(Precedence.ASSIGN - 1));
            }
            if (this.peekTokenIs(TokenType.COMMA)) {
                this.nextToken();
                if (this.peekTokenIs(TokenType.RBRACKET)) {
                    this.nextToken();
                    return new AST.ArrayExpression(elements);
                }
                this.nextToken();
            } else {
                break;
            }
        }
        if (!this.expectPeek(TokenType.RBRACKET)) return null;
        return new AST.ArrayExpression(elements);
    },

    parseObjectLiteral() {
        let properties = [];
        let protoCount = 0;   // [test262 早期错误 G] 非计算 `__proto__: 值` 计数(>1 即早期错误)
        if (this.peekTokenIs(TokenType.RBRACE)) {
            this.nextToken();
            return new AST.ObjectExpression(properties);
        }
        this.nextToken();
        while (!this.curTokenIs(TokenType.RBRACE) && !this.curTokenIs(TokenType.EOF)) {
            let computed = false;
            let key;
            if (this.curTokenIs(TokenType.SPREAD)) {
                this.nextToken();
                properties.push(new AST.SpreadElement(this.parseExpression(Precedence.ASSIGN - 1)));
                if (this.peekTokenIs(TokenType.COMMA)) {
                    this.nextToken();
                    if (this.peekTokenIs(TokenType.RBRACE)) break;
                    this.nextToken();
                } else {
                    break;
                }
                continue;
            }
            // async 方法简写 `async m(){}` / `async *m(){}`:仅当 async 后跟方法名/`*`/`[`
            // (非 `(`/`:`/`,`/`}` — 那些是名为 "async" 的方法/键/简写)时当修饰符。
            let isAsyncMethod = false;
            if (this.curTokenIs(TokenType.ASYNC) &&
                !this.peekTokenIs(TokenType.LPAREN) && !this.peekTokenIs(TokenType.COLON) &&
                !this.peekTokenIs(TokenType.COMMA) && !this.peekTokenIs(TokenType.RBRACE)) {
                isAsyncMethod = true;
                this.nextToken(); // cur = 键(或 `*`)
            }
            // 生成器方法简写 `*m(){}`:cur 是 `*`,吞掉后 cur = 真键,标记 isGenMethod。
            let isGenMethod = false;
            if (this.curTokenIs(TokenType.ASTERISK)) {
                isGenMethod = true;
                this.nextToken(); // cur = 键
            }
            // 访问器 get x() {} / set x(v) {}：cur 是 get/set 且 peek 是真键
            // (Identifier 类或 STRING)。peek 为 COMMA/RBRACE(简写)、LPAREN(名叫
            // get 的方法)、COLON({get:1} 普通键)时不误伤——peekTokenIsIdentifier
            // 已排除这四种 token。
            let accessorKind = null;
            if ((this.curTokenIs(TokenType.GET) || this.curTokenIs(TokenType.SET)) &&
                (this.peekTokenIsIdentifier() || this.peekTokenIs(TokenType.STRING) || this.peekTokenIs(TokenType.LBRACKET))) {
                accessorKind = this.curTokenIs(TokenType.GET) ? "get" : "set";
                this.nextToken(); // cur = 真键(或计算键 `[`)
            }
            if (this.curTokenIs(TokenType.LBRACKET)) {
                computed = true;
                this.nextToken();
                key = this.parseExpression(Precedence.ASSIGN - 1);
                if (!this.expectPeek(TokenType.RBRACKET)) return null;
            } else if (this.curTokenIs(TokenType.STRING)) {
                key = new AST.Literal(this.curToken.literal, '"' + this.curToken.literal + '"');
            } else if (this.curTokenIsIdentifier()) {
                key = new AST.Identifier(this.curToken.literal);
            } else {
                this.errors.push("expected property name");
                return null;
            }
            if (accessorKind !== null && !this.peekTokenIs(TokenType.LPAREN)) {
                this.errors.push("expected ( after accessor name");
                return null;
            }
            if (this.peekTokenIs(TokenType.COMMA) || this.peekTokenIs(TokenType.RBRACE)) {
                // [test262 早期错误 A] 简写属性 `{ x }` 的键即绑定引用,须过保留字校验;
                // 带冒号的键 `{ if: 1 }`(PropertyName)走 COLON 分支,不校验(属性名可为保留字)。
                if (!computed && key.type === "Identifier") this.checkReservedBinding(key.name);
                properties.push(new AST.Property(key, key, "init", computed, true));
            } else if (this.peekTokenIs(TokenType.ASSIGN) && !computed && accessorKind === null) {
                // CoverInitializedName `{a = 默认}`:简写属性带默认值,仅在解构目标位合法
                // (`({a = 1} = obj)`)。产出 shorthand Property,value = AssignmentPattern
                // (Identifier, 默认表达式),供 reinterpretAsPattern/emitDestructurePattern 消费。
                if (key.type === "Identifier") this.checkReservedBinding(key.name);   // [test262 早期错误 A]
                this.nextToken(); // cur = '='
                this.nextToken(); // cur = 默认表达式首 token
                const dflt = this.parseExpression(Precedence.ASSIGN - 1);
                const val = new AST.AssignmentPattern(new AST.Identifier(key.name), dflt);
                properties.push(new AST.Property(key, val, "init", computed, true));
            } else if (this.peekTokenIs(TokenType.LPAREN)) {
                this.nextToken();
                // [Wave 8] 对象方法亦为函数/生成器/异步边界:置生成器/异步深度与复位字段上下文。
                if (isGenMethod) this.fnGenDepth++;
                if (isAsyncMethod) this.fnAsyncDepth++;
                const prevInFieldInitM = this._inFieldInit;
                this._inFieldInit = false;
                let params = this.parseFunctionParams();
                if (!this.expectPeek(TokenType.LBRACE)) {
                    if (isGenMethod) this.fnGenDepth--;
                    if (isAsyncMethod) this.fnAsyncDepth--;
                    this._inFieldInit = prevInFieldInitM;
                    return null;
                }
                // [test262 早期错误 B] 对象字面量方法(含 get/set/async/generator 简写)带显式
                // "use strict" 指令时,形参必须是简单形参列表。cur=`{`,peek=体首 token。
                let isStrict = this.peekUseStrictDirective();
                if (isStrict) { this.fnStrictDepth++; this.checkStrictParams(params); }
                this.checkInheritedStrictParams(params, isStrict);   // [test262 早期错误 C] 继承 strict 重参
                let body = this.parseBlockStatement();
                if (isStrict) this.fnStrictDepth--;
                if (isGenMethod) this.fnGenDepth--;
                if (isAsyncMethod) this.fnAsyncDepth--;
                this._inFieldInit = prevInFieldInitM;
                {
                    const mfn = new AST.FunctionExpression(null, params, body, isAsyncMethod, isGenMethod);
                    mfn.async = isAsyncMethod;
                    mfn.generator = isGenMethod;
                    properties.push(new AST.Property(key, mfn, accessorKind !== null ? accessorKind : "init", computed, false));
                }
            } else {
                if (!this.expectPeek(TokenType.COLON)) return null;
                this.nextToken();
                // [test262 早期错误 G] 对象字面量不得含多个非计算 `__proto__: 值`(原型设置器唯一)。
                // 简写 { __proto__ } / 方法 { __proto__(){} } / 访问器 / 计算 { ["__proto__"]: } 不计。
                if (!computed) {
                    let keyName = key.type === "Identifier" ? key.name : (key.type === "Literal" ? String(key.value) : null);
                    if (keyName === "__proto__") {
                        protoCount = protoCount + 1;
                        if (protoCount > 1) this.errors.push("Duplicate '__proto__' property in object literal");
                    }
                }
                properties.push(new AST.Property(key, this.parseExpression(Precedence.ASSIGN - 1), "init", computed, false));
            }
            if (this.peekTokenIs(TokenType.COMMA)) {
                this.nextToken();
                if (this.peekTokenIs(TokenType.RBRACE)) break;
                this.nextToken();
            } else {
                break;
            }
        }
        if (!this.expectPeek(TokenType.RBRACE)) return null;
        return new AST.ObjectExpression(properties);
    },

    parseFunctionExpression() {
        let isAsync = false;
        // [批次D] function* 表达式:吞掉 * 并置 isGenerator
        let isGenerator = false;
        if (this.peekTokenIs(TokenType.ASTERISK)) {
            isGenerator = true;
            this.nextToken();
        }
        // [test262 S1] 生成器深度:yield 作绑定名在此函数体内是早期错误(所有返回路径须配对减)
        if (isGenerator) this.fnGenDepth++;
        // [Wave 8] 函数边界:字段初始化器上下文在函数表达式内复位(自有 arguments / 无
        // home object),所有返回路径须恢复,故每处 return 前配对。
        // [L2-④] _inFormalParams 同理:嵌套函数内 await/yield 在 body 合法。
        const prevInFieldInit = this._inFieldInit;
        const prevInFormalFE = this._inFormalParams;
        this._inFieldInit = false;
        this._inFormalParams = false;
        // 命名函数表达式 function g(...) {}:先看名字。此前先 expectPeek(LPAREN),命名
        // 形式(peek=IDENT)会误 push "expected (" 假错误——虽随后正确解析,残留错误仍致
        // "Syntax errors" 编译失败(named function expression COMPILE_FAIL 根因)。
        if (this.peekTokenIs(TokenType.IDENT)) {
            this.nextToken();
            this.checkReservedBinding(this.curToken.literal);   // [test262 早期错误 A] 函数名保留字
            let id = new AST.Identifier(this.curToken.literal);
            if (!this.expectPeek(TokenType.LPAREN)) { if (isGenerator) this.fnGenDepth--; this._inFieldInit = prevInFieldInit; this._inFormalParams = prevInFormalFE; return null; }
            let params = this.parseFunctionParams();
            if (!this.expectPeek(TokenType.LBRACE)) { if (isGenerator) this.fnGenDepth--; this._inFieldInit = prevInFieldInit; this._inFormalParams = prevInFormalFE; return null; }
            let isStrict = this.peekUseStrictDirective();
            if (isStrict) { this.fnStrictDepth++; this.checkStrictParams(params); }
            this.checkInheritedStrictParams(params, isStrict);   // [test262 早期错误 C] 继承 strict 重参
            let body = this.parseBlockStatement();
            if (isStrict) this.fnStrictDepth--;
            if (isGenerator) this.fnGenDepth--;
            this._inFieldInit = prevInFieldInit;
            this._inFormalParams = prevInFormalFE;
            return new AST.FunctionExpression(id, params, body, isAsync, isGenerator);
        }
        if (!this.expectPeek(TokenType.LPAREN)) { if (isGenerator) this.fnGenDepth--; this._inFieldInit = prevInFieldInit; this._inFormalParams = prevInFormalFE; return null; }
        let params = this.parseFunctionParams();
        if (!this.expectPeek(TokenType.LBRACE)) { if (isGenerator) this.fnGenDepth--; this._inFieldInit = prevInFieldInit; this._inFormalParams = prevInFormalFE; return null; }
        let isStrict = this.peekUseStrictDirective();
        if (isStrict) { this.fnStrictDepth++; this.checkStrictParams(params); }
        this.checkInheritedStrictParams(params, isStrict);   // [test262 早期错误 C] 继承 strict 重参
        let body = this.parseBlockStatement();
        if (isStrict) this.fnStrictDepth--;
        if (isGenerator) this.fnGenDepth--;
        this._inFieldInit = prevInFieldInit;
        this._inFormalParams = prevInFormalFE;
        return new AST.FunctionExpression(null, params, body, isAsync, isGenerator);
    },

    parseAsyncExpression() {
        this.nextToken();
        if (this.curTokenIs(TokenType.FUNCTION)) {
            // [test262 S1] async 深度:await 作绑定名在异步函数内是早期错误
            this.fnAsyncDepth++;
            let func = this.parseFunctionExpression();
            this.fnAsyncDepth--;
            if (func !== null) func.isAsync = true;
            return func;
        }
        if (this.curTokenIs(TokenType.LPAREN)) {
            this.fnAsyncDepth++;   // [test262 S1] async (...) => 形参在异步上下文
            let arrow = this.parseGroupedOrArrow();
            this.fnAsyncDepth--;
            if (arrow !== null && arrow.type === "ArrowFunctionExpression") {
                arrow.isAsync = true;
            }
            return arrow;
        }
        if (this.curTokenIs(TokenType.IDENT)) {
            this.fnAsyncDepth++;   // [test262 S1] async x => 单参在异步上下文
            this.checkYieldAwaitBinding(this.curToken.literal);
            let param = new AST.Identifier(this.curToken.literal);
            if (this.peekTokenIs(TokenType.ARROW)) {
                this.nextToken();
                let arrow = this.parseArrowFunctionBody([param]);
                this.fnAsyncDepth--;
                arrow.isAsync = true;
                return arrow;
            }
            this.fnAsyncDepth--;
        }
        return null;
    },

    parseThisExpression() {
        return new AST.ThisExpression();
    },

    parseSuperExpression() {
        // [Wave 8] 字段初始化器 ContainsSuperCall:init 上下文(穿透箭头)内 `super(...)`
        // 是早期错误;`super.prop` 属性访问合法(Node 对拍)。函数边界已复位 _inFieldInit。
        if (this._inFieldInit && this.peekTokenIs(TokenType.LPAREN)) {
            this.errors.push(`super() is not allowed in a class field initializer at line ${this.curToken.line}`);
        }
        return new AST.SuperExpression();
    },

    parseSpreadExpression() {
        this.nextToken();
        return new AST.SpreadElement(this.parseExpression(Precedence.ASSIGN - 1));
    },

    parseNewExpression() {
        // new.target 元属性:new 后紧跟 `.` 时非 NewExpression,而是元属性(构造器内
        // 取当前构造函数,否则 undefined)。与 import.meta 同法建 MetaProperty 节点。
        if (this.peekTokenIs(TokenType.DOT)) {
            let meta = new AST.Identifier(this.curToken.literal); // "new"
            this.nextToken(); // 到 .
            if (!this.expectPeek(TokenType.IDENT)) return null;
            let property = new AST.Identifier(this.curToken.literal); // "target"
            return new AST.MetaProperty(meta, property);
        }
        this.nextToken();
        // new 的 callee 是 MemberExpression（含 . 和 []），但不含调用括号——
        // 括号内的实参属于 new 本身。用 MEMBER 精度会因 DOT 精度==MEMBER 而
        // 停在第一个标识符（new ns.Foo() 误解析成 (new ns).Foo()）；用 CALL 精度
        // 可吞并成员链 ns.Foo 但在 LPAREN(CALL) 处停下，随后由本函数消费实参。
        let callee = this.parseExpression(Precedence.CALL);
        let args = [];
        if (this.peekTokenIs(TokenType.LPAREN)) {
            this.nextToken();
            args = this.parseCallArguments();
        }
        return new AST.NewExpression(callee, args);
    },

    parseCallExpression(callee) {
        return new AST.CallExpression(callee, this.parseCallArguments());
    },

    parseCallArguments() {
        let args = [];
        if (this.peekTokenIs(TokenType.RPAREN)) {
            this.nextToken();
            return args;
        }
        this.nextToken();
        while (!this.curTokenIs(TokenType.RPAREN) && !this.curTokenIs(TokenType.EOF)) {
            if (this.curTokenIs(TokenType.SPREAD)) {
                this.nextToken();
                args.push(new AST.SpreadElement(this.parseExpression(Precedence.ASSIGN - 1)));
            } else {
                // 实参是 AssignmentExpression 位:用 ASSIGN-1 吞并顶层赋值/逻辑赋值
                // (`f(x = 1)` / `console.log(o.x ||= v)`);逗号(COMMA<ASSIGN)仍作实参分隔。
                args.push(this.parseExpression(Precedence.ASSIGN - 1));
            }
            if (this.peekTokenIs(TokenType.COMMA)) {
                this.nextToken(); // curToken = ,
                // 尾逗号 f(1, 2,):逗号后紧跟 ) → 停止(curToken=,、peek=) 使 expectPeek 正常)。
                if (this.peekTokenIs(TokenType.RPAREN)) break;
                this.nextToken();
            } else {
                break;
            }
        }
        if (!this.expectPeek(TokenType.RPAREN)) return null;
        return args;
    },

    parseMemberExpression(object) {
        this.nextToken();
        // 支持私有字段访问 obj.#field（仅类体内合法，类外是语法错误）
        if (this.curTokenIs(TokenType.HASH) || (this.curToken.literal && this.curToken.literal.startsWith("#"))) {
            let name = this.curToken.literal;
            if (!name.startsWith("#")) {
                this.nextToken();
                name = "#" + this.curToken.literal;
            }
            if (!this.classDepth) {
                this.errors.push(
                    `Private field '${name}' must be declared in an enclosing class (line ${this.curToken.line})`
                );
                return null;
            }
            // [W-P9] 记录私有名引用,供类体收尾统一做未绑定检查。
            this._recordPrivateRef(name);
            return new AST.MemberExpression(object, new AST.PrivateIdentifier(name), false, false);
        }
        return new AST.MemberExpression(object, new AST.Identifier(this.curToken.literal), false, false);
    },

    parseOptionalMemberExpression(object) {
        this.nextToken();

        // 支持可选调用 func?.()
        if (this.curTokenIs(TokenType.LPAREN)) {
            let call = this.parseCallExpression(object);
            call.optional = true;
            return call;
        }

        // [#34] 可选下标 obj?.[expr]:computed MemberExpression + optional
        if (this.curTokenIs(TokenType.LBRACKET)) {
            this.nextToken();
            let index = this.parseExpression(Precedence.LOWEST);
            if (!this.expectPeek(TokenType.RBRACKET)) return null;
            return new AST.MemberExpression(object, index, true, true);
        }

        if (!this.curTokenIsIdentifier()) {
            this.errors.push("expected identifier after ?.");
            return null;
        }
        return new AST.MemberExpression(object, new AST.Identifier(this.curToken.literal), false, true);
    },

    parseIndexExpression(object) {
        this.nextToken();
        let index = this.parseExpression(Precedence.LOWEST);
        if (!this.expectPeek(TokenType.RBRACKET)) return null;
        return new AST.MemberExpression(object, index, true, false);
    },

    parseYieldExpression() {
        // [L2-④] yield 只能在 generator(含 async-gen)内出现;非生成器上下文(类体隐式
        // strict/strict 模式)中 yield 是保留字,恒 SyntaxError。
        if (this.fnGenDepth === 0) {
            this.errors.push("yield expression not allowed outside of a generator");
            // 不回退:即使报错,仍继续解析以收集更多错误,产 null expression
        }
        if (this._inFormalParams && this.fnGenDepth > 0) {
            this.errors.push("yield expression not allowed in formal parameter of generator");
        }
        let delegate = false;
        if (this.peekTokenIs(TokenType.ASTERISK)) {
            delegate = true;
            this.nextToken();
        }
        // 无值 yield:后随 ; } ) ] , : 模板续段 或 EOF 时不消费 argument。
        // 判 peek(不前进),否则会吞掉终结 token 破坏外层解析。
        // [test262 S1] `:` 曾缺席 → `(yield) ? yield : yield` 里三元的中段 yield 会把
        // `: yield` 当实参吞掉,报 "no prefix parse function for :";TEMPLATE_MIDDLE/TAIL
        // 同理(`` `${yield}` ``)。这些 token 都不能起始 AssignmentExpression。
        if (this.peekTokenIs(TokenType.SEMICOLON) || this.peekTokenIs(TokenType.RBRACE) ||
            this.peekTokenIs(TokenType.RPAREN) || this.peekTokenIs(TokenType.RBRACKET) ||
            this.peekTokenIs(TokenType.COMMA) || this.peekTokenIs(TokenType.COLON) ||
            this.peekTokenIs(TokenType.TEMPLATE_MIDDLE) || this.peekTokenIs(TokenType.TEMPLATE_TAIL) ||
            this.peekTokenIs(TokenType.EOF)) {
            return new AST.YieldExpression(null, delegate);
        }
        this.nextToken();
        // ASSIGN-1(=COMMA)级:yield a, b 时 argument 止于逗号(与赋值右侧语义一致),
        // LOWEST 会把逗号当序列运算符吞掉后续实参;ASSIGN(3) 则会漏掉 `yield a = 1`
        // 的赋值(YieldExpression 反被当成赋值左值 → "Invalid left-hand side")。
        let argument = this.parseExpression(Precedence.ASSIGN - 1);
        return new AST.YieldExpression(argument, delegate);
    },
    parseImportExpression() {
        let meta = new AST.Identifier(this.curToken.literal); // "import"
        if (this.peekTokenIs(TokenType.DOT)) {
            this.nextToken(); // .
            if (!this.expectPeek(TokenType.IDENT)) return null;
            let property = new AST.Identifier(this.curToken.literal); // "meta"
            return new AST.MetaProperty(meta, property);
        }
        // 动态 import() - 简单实现为 CallExpression
        if (this.peekTokenIs(TokenType.LPAREN)) {
            this.nextToken();
            this.nextToken();
            let source = this.parseExpression(Precedence.ASSIGN - 1);
            if (!this.expectPeek(TokenType.RPAREN)) return null;
            return new AST.CallExpression(meta, [source]);
        }
        this.errors.push("expected .meta or (source) after import");
        return null;
    },
    parseSequenceExpression(left) {
        let expressions = [];
        if (left.type === "SequenceExpression") {
            expressions = left.expressions;
        } else {
            expressions.push(left);
        }
        this.nextToken(); // consume ,
        expressions.push(this.parseExpression(Precedence.COMMA));
        return new AST.SequenceExpression(expressions);
    },
};
