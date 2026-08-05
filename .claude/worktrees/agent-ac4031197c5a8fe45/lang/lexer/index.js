// asm.js - JavaScript 词法分析器
// 将源代码转换为词法单元流

import { TokenType, newToken, lookupIdent } from "./token.js";

// 词法分析器类
export class Lexer {
    constructor(input) {
        this.input = input;
        this.position = 0;
        this.readPosition = 0;
        this.ch = "";
        this.line = 1;
        this.column = 0;
        this.templateDepth = 0; // 跟踪模板字符串嵌套深度
        this.templateStack = []; // 存储进入插值时的 braceDepth
        this.braceDepth = 0; // 跟踪 {} 嵌套深度
        this.lastTokenType = null; // 用于正则/除法区分
        this.readChar();

        // 跳过 Shebang (#!)
        if (this.ch === "#" && this.peekChar() === "!") {
            while (this.ch !== "\n" && this.ch !== "\0") {
                this.readChar();
            }
            this.skipWhitespace();
        }
    }

    // 读取下一个字符
    readChar() {
        if (this.readPosition >= this.input.length) {
            this.ch = "\0";
        } else {
            this.ch = this.input[this.readPosition];
        }
        this.position = this.readPosition;
        this.readPosition = this.readPosition + 1;
        this.column = this.column + 1;
        if (this.ch === "\n") {
            this.line = this.line + 1;
            this.column = 0;
        }
    }

    // 查看下一个字符
    peekChar() {
        if (this.readPosition >= this.input.length) {
            return "\0";
        }
        return this.input[this.readPosition];
    }

    // 查看后面第 n 个字符
    peekCharN(n) {
        let pos = this.readPosition + n - 1;
        if (pos >= this.input.length) {
            return "\0";
        }
        return this.input[pos];
    }

    // 把码点编码为 UTF-8 字节串(每字节一个 char),供 \u / \x 转义解码。asm.js 字符串是逐字节
    // 的(String.fromCharCode 截为字节),故转义必须**展开成 UTF-8 字节**再拼接——不能
    // fromCharCode(码点) 直接存(g1 截低字节 → mojibake;node 存码点、发射器再 UTF-8 编码 →
    // 两侧字节分歧)。源码本身按 latin1(逐字节)读入,故原始 UTF-8 字符已是字节序列直接透传;
    // 发射器(asm/*.js)逐字节透传,故此处产出的 UTF-8 字节原样进产物,node/g1 一致且正确。
    // cp===0 或 NaN 产空串(A 的 NUL-drop:asm.js C-string 无法承载内嵌 NUL)。
    _cpToUtf8(cp) {
        if (cp === 0 || cp !== cp) return "";
        if (cp < 0x80) return String.fromCharCode(cp);
        if (cp < 0x800) {
            return String.fromCharCode(0xc0 | (cp >> 6)) +
                String.fromCharCode(0x80 | (cp & 0x3f));
        }
        if (cp < 0x10000) {
            return String.fromCharCode(0xe0 | (cp >> 12)) +
                String.fromCharCode(0x80 | ((cp >> 6) & 0x3f)) +
                String.fromCharCode(0x80 | (cp & 0x3f));
        }
        return String.fromCharCode(0xf0 | (cp >> 18)) +
            String.fromCharCode(0x80 | ((cp >> 12) & 0x3f)) +
            String.fromCharCode(0x80 | ((cp >> 6) & 0x3f)) +
            String.fromCharCode(0x80 | (cp & 0x3f));
    }

    _isHex(ch) {
        return (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
    }

    // 前瞻(不消费)当前 this.ch(必须是 'x' 或 'u',即反斜杠后的字符)所引导的十六进制转义:
    // \xNN / \uNNNN / \u{...} / 高代理+紧邻低代理。返回 { cook, extra }:
    //   cook  = UTF-8 字节串(转义合法时),或 null(不合法 → 调用方按字面 'x'/'u' 宽松处理);
    //   extra = 合法时需在 this.ch 之后再消费的字符数(供调用方 readChar,并在模板里补 raw)。
    // **只在确认合法(且十六进制齐全、在串/模板边界内)才返回 cook≠null**,故绝不越过结束引号/
    // 反引号(peekCharN 越界返 "\0",_isHex 拒之)——修 tagged template `String.raw`C:\x`` 类
    // 无效转义把边界消费掉的 COMPILE_FAIL。字符串/模板共用,行为一致。
    _peekHexEscape() {
        if (this.ch === "x") {
            let d1 = this.peekCharN(1), d2 = this.peekCharN(2);
            if (this._isHex(d1) && this._isHex(d2)) {
                return { cook: this._cpToUtf8(parseInt(d1 + d2, 16)), extra: 2 };
            }
            return { cook: null, extra: 0 };
        }
        // 'u'
        if (this.peekCharN(1) === "{") {
            let k = 2;
            let hex = "";
            while (true) {
                let c = this.peekCharN(k);
                if (c === "}") { break; }
                if (!this._isHex(c)) { return { cook: null, extra: 0 }; }
                hex = hex + c;
                k = k + 1;
                if (k > 9) { return { cook: null, extra: 0 }; }
            }
            if (hex.length === 0) { return { cook: null, extra: 0 }; }
            return { cook: this._cpToUtf8(parseInt(hex, 16)), extra: k };
        }
        let d1 = this.peekCharN(1), d2 = this.peekCharN(2), d3 = this.peekCharN(3), d4 = this.peekCharN(4);
        if (!(this._isHex(d1) && this._isHex(d2) && this._isHex(d3) && this._isHex(d4))) {
            return { cook: null, extra: 0 };
        }
        let cu = parseInt(d1 + d2 + d3 + d4, 16);
        // 代理对:高代理(D800-DBFF)+ 紧邻 \uNNNN 低代理(DC00-DFFF)→ 合成 astral 码点
        if (cu >= 0xd800 && cu <= 0xdbff &&
            this.peekCharN(5) === "\\" && this.peekCharN(6) === "u") {
            let l1 = this.peekCharN(7), l2 = this.peekCharN(8), l3 = this.peekCharN(9), l4 = this.peekCharN(10);
            if (this._isHex(l1) && this._isHex(l2) && this._isHex(l3) && this._isHex(l4)) {
                let lo = parseInt(l1 + l2 + l3 + l4, 16);
                if (lo >= 0xdc00 && lo <= 0xdfff) {
                    cu = 0x10000 + ((cu - 0xd800) << 10) + (lo - 0xdc00);
                    return { cook: this._cpToUtf8(cu), extra: 10 };
                }
            }
        }
        return { cook: this._cpToUtf8(cu), extra: 4 };
    }

    // 跳过空白字符
    skipWhitespace() {
        while (this.ch === " " || this.ch === "\t" || this.ch === "\n" || this.ch === "\r") {
            this.readChar();
        }
    }

    // 跳过注释
    skipComment() {
        while (true) {
            if (this.ch === "/") {
                if (this.peekChar() === "/") {
                    // 单行注释
                    while (this.ch !== "\n" && this.ch !== "\0") {
                        this.readChar();
                    }
                    this.skipWhitespace();
                } else if (this.peekChar() === "*") {
                    // 多行注释
                    this.readChar();
                    this.readChar();
                    while (!(this.ch === "*" && this.peekChar() === "/") && this.ch !== "\0") {
                        this.readChar();
                    }
                    if (this.ch !== "\0") {
                        this.readChar();
                        this.readChar();
                    }
                    this.skipWhitespace();
                } else {
                    break;
                }
            } else {
                break;
            }
        }
    }

    // 读取标识符（支持内嵌 Unicode 转义 \u{...} / \uNNNN，解码成 UTF-8 字节并入标识符值，
    // 与裸非 ASCII 标识符的字节表示一致。[test262 S1] 修 ~215 个标识符转义 COMPILE_FAIL）
    readIdentifier() {
        let startPos = this.position;
        // 快路：无转义直接 slice（绝大多数标识符；自编译词法零额外开销）
        while (this.isLetter(this.ch) || this.isDigit(this.ch)) {
            this.readChar();
        }
        if (this.ch !== "\\") {
            return this.input.slice(startPos, this.position);
        }
        // 慢路：含 \u 转义 → 在已读片段后解码续接（\x 在标识符里非法，不处理，留给下轮 ILLEGAL）。
        // 解码后经 lookupIdent 照常判关键字（ES:转义拼成 ReservedWord 非法，`var \u{69}f` 应拒）。
        let result = this.input.slice(startPos, this.position);
        while (this.ch === "\\" && this.peekChar() === "u") {
            this.readChar();                 // 消费 '\'，this.ch = 'u'
            let _esc = this._peekHexEscape();
            if (_esc.cook === null) break;   // 非法转义 → 停读（交 parser 报错）
            let _z = 0;
            while (_z < _esc.extra) { this.readChar(); _z = _z + 1; }
            result = result + _esc.cook;
            this.readChar();                 // 越过转义末字符（镜像 readString 逐步进）
            while (this.isLetter(this.ch) || this.isDigit(this.ch)) {
                result = result + this.ch;
                this.readChar();
            }
        }
        return result;
    }

    // 读取数字
    readNumber() {
        let startPos = this.position;
        let hasPrefix = false; // 是否已处理进制前缀

        // 处理十六进制、八进制、二进制
        if (this.ch === "0") {
            let next = this.peekChar();
            if (next === "x" || next === "X") {
                this.readChar();
                this.readChar();
                while (this.isHexDigit(this.ch) || this.ch === "_") {
                    this.readChar();
                }
                hasPrefix = true;
            } else if (next === "b" || next === "B") {
                this.readChar();
                this.readChar();
                while (this.ch === "0" || this.ch === "1" || this.ch === "_") {
                    this.readChar();
                }
                hasPrefix = true;
            } else if (next === "o" || next === "O") {
                this.readChar();
                this.readChar();
                while ((this.ch >= "0" && this.ch <= "7") || this.ch === "_") {
                    this.readChar();
                }
                hasPrefix = true;
            }
        }

        // 如果没有进制前缀，处理十进制整数部分
        if (!hasPrefix) {
            // 整数部分 (支持数字分隔符 _)
            while (this.isDigit(this.ch) || this.ch === "_") {
                this.readChar();
            }

            // 小数部分:小数点后跟数字(255.5)**或尾随小数点**(255. = 255.0)。
            // 尾随点须并入数字——否则 `255..toString(16)`(第一点=小数点、第二点=成员访问)
            // 被切成 `255 . . toString` → 双点语法错。合法 JS 中 `数字.标识符` 本就是语法错,
            // 故无条件并入首个小数点不改变既有有效代码的分词(数字后随点恒为小数点)。
            if (this.ch === ".") {
                this.readChar();
                while (this.isDigit(this.ch) || this.ch === "_") {
                    this.readChar();
                }
            }

            // 指数部分
            if (this.ch === "e" || this.ch === "E") {
                this.readChar();
                if (this.ch === "+" || this.ch === "-") {
                    this.readChar();
                }
                while (this.isDigit(this.ch) || this.ch === "_") {
                    this.readChar();
                }
            }
        }

        // 检查 BigInt 后缀 n
        if (this.ch === "n") {
            this.readChar();
        }

        // 移除数字分隔符后返回
        return this.input.slice(startPos, this.position).split("_").join("");
    }

    // 读取字符串
    readString(quote) {
        let result = "";
        this.readChar(); // 跳过开始引号

        while (this.ch !== quote && this.ch !== "\0") {
            if (this.ch === "\\") {
                this.readChar();
                if (this.ch === "n") {
                    result = result + "\n";
                } else if (this.ch === "t") {
                    result = result + "\t";
                } else if (this.ch === "r") {
                    result = result + "\r";
                } else if (this.ch === "\\") {
                    result = result + "\\";
                } else if (this.ch === '"') {
                    result = result + '"';
                } else if (this.ch === "'") {
                    result = result + "'";
                } else if (this.ch === "0") {
                    // [layout-determinism] \0 转义产出空串,不产 NUL 字符。asm.js 的字符串是
                    // C-string(NUL 结尾)语义,拼接 NUL 会截断整串 → node(保留 NUL)与 asm.js
                    // (截断)对含 \0 的串字面量产不同字节 → 自举 g1≠g2 残差(雷区最后根因)。
                    // 两端一致丢弃 NUL(asm.js 本就无法承载)→ 确定性。需要真 NUL 字节的二进制
                    // 写入(ELF/Mach-O 串表)改用字节数组构建,不依赖串内 NUL。
                    result = result + "";
                } else if (this.ch === "b") {
                    result = result + String.fromCharCode(8);
                } else if (this.ch === "f") {
                    result = result + String.fromCharCode(12);
                } else if (this.ch === "v") {
                    result = result + String.fromCharCode(11);
                } else if (this.ch === "x" || this.ch === "u") {
                    // \xNN / \uNNNN / \u{...} / 代理对 → 码点 → UTF-8 字节(_peekHexEscape 前瞻校验,
                    // 合法才消费,绝不越过结束引号)。不合法(缺十六进制)→ 宽松按字面 'x'/'u'。
                    let _esc = this._peekHexEscape();
                    if (_esc.cook !== null) {
                        let _z = 0;
                        while (_z < _esc.extra) { this.readChar(); _z = _z + 1; }
                        result = result + _esc.cook;
                    } else {
                        result = result + this.ch;
                    }
                } else {
                    result = result + this.ch;
                }
            } else {
                result = result + this.ch;
            }
            this.readChar();
        }

        this.readChar(); // 跳过结束引号
        return result;
    }

    // 读取模板字符串内容（从当前位置读到 ` 或 ${）
    // 返回 { value, isEnd } 其中 isEnd 为 true 表示遇到 `，false 表示遇到 ${
    readTemplateContent() {
        let result = ""; // cooked（转义已 cook）
        let raw = "";    // raw（源文本原样,转义反斜杠保留;供 tagged template / String.raw）

        while (this.ch !== "`" && this.ch !== "\0") {
            // 检查 ${
            if (this.ch === "$" && this.peekChar() === "{") {
                this.readChar(); // 跳过 $
                this.readChar(); // 跳过 {
                return { value: result, raw: raw, isEnd: false };
            }

            if (this.ch === "\\") {
                raw = raw + "\\"; // raw 保留反斜杠
                this.readChar();
                raw = raw + this.ch; // raw 保留被转义字符原样
                if (this.ch === "n") {
                    result = result + "\n";
                } else if (this.ch === "t") {
                    result = result + "\t";
                } else if (this.ch === "r") {
                    result = result + "\r";
                } else if (this.ch === "\\") {
                    result = result + "\\";
                } else if (this.ch === "`") {
                    result = result + "`";
                } else if (this.ch === "$") {
                    result = result + "$";
                } else if (this.ch === "x" || this.ch === "u") {
                    // \xNN / \uNNNN / \u{...} / 代理对 → cook 成 UTF-8 字节;raw 保留原样(String.raw/
                    // tagged)。raw 已含 "\\x"/"\\u"(见上);合法时补消费的字符到 raw。_peekHexEscape
                    // 前瞻校验,不合法(如 String.raw`C:\x`)→ 宽松字面,不越反引号边界。
                    let _esc = this._peekHexEscape();
                    if (_esc.cook !== null) {
                        let _z = 0;
                        while (_z < _esc.extra) { this.readChar(); raw = raw + this.ch; _z = _z + 1; }
                        result = result + _esc.cook;
                    } else {
                        result = result + this.ch;
                    }
                } else {
                    result = result + this.ch;
                }
            } else {
                raw = raw + this.ch;
                result = result + this.ch;
            }
            this.readChar();
        }

        this.readChar(); // 跳过结束的反引号
        return { value: result, raw: raw, isEnd: true };
    }

    // 读取模板字符串（从 ` 开始）
    // 返回 { type, value }
    // type: TEMPLATE_STRING (无插值) 或 TEMPLATE_HEAD (有插值)
    readTemplateString() {
        this.readChar(); // 跳过开始的反引号
        let { value, raw, isEnd } = this.readTemplateContent();

        if (isEnd) {
            return { type: TokenType.TEMPLATE_STRING, value, raw };
        } else {
            this.templateDepth = this.templateDepth + 1;
            // 进入插值，记录当前的 braceDepth
            this.templateStack.push(this.braceDepth);
            this.braceDepth = 0; // 重置插值内部的深度
            return { type: TokenType.TEMPLATE_HEAD, value, raw };
        }
    }

    // 从 } 继续读取模板字符串（在表达式之后）
    // 返回 { type, value }
    // type: TEMPLATE_TAIL (遇到 `) 或 TEMPLATE_MIDDLE (遇到另一个 ${)
    // 从 } 继续读取模板字符串（在表达式之后）
    // 返回 { type, value }
    // type: TEMPLATE_TAIL (遇到 `) 或 TEMPLATE_MIDDLE (遇到另一个 ${)
    readTemplateMiddle() {
        let { value, raw, isEnd } = this.readTemplateContent();

        if (isEnd) {
            this.templateDepth = this.templateDepth - 1;
            return { type: TokenType.TEMPLATE_TAIL, value, raw };
        } else {
            // 开始另一个插值
            this.templateStack.push(this.braceDepth);
            this.braceDepth = 0;
            return { type: TokenType.TEMPLATE_MIDDLE, value, raw };
        }
    }

    // 判断是否为字母 (ASCII字母或非ASCII Unicode字母)
    isLetter(ch) {
        let code = ch.charCodeAt(0);
        // ASCII字母: a-z, A-Z
        // 下划线和美元符: _, $
        // 非ASCII (多字节字符，如中文等)
        if (code > 127) return true;
        return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95 || code === 36;
    }

    // 判断是否为数字
    isDigit(ch) {
        let code = ch.charCodeAt(0);
        return code >= 48 && code <= 57;
    }

    // 判断是否为十六进制数字
    isHexDigit(ch) {
        let code = ch.charCodeAt(0);
        return this.isDigit(ch) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70);
    }

    // 辅助方法：判断下一个 / 是否为正则表达式
    canNextBeRegExp() {
        if (!this.lastTokenType) return true;
        const t = this.lastTokenType;
        const tt = TokenType;
        // 以下 token 之后如果出现 /，通常是正则表达式的开始
        return t === tt.ASSIGN || t === tt.PLUS || t === tt.MINUS || t === tt.ASTERISK ||
               t === tt.SLASH || t === tt.PERCENT || t === tt.BANG || t === tt.COMMA ||
               t === tt.SEMICOLON || t === tt.COLON || t === tt.LPAREN || t === tt.LBRACKET ||
               t === tt.LBRACE || t === tt.QUESTION || t === tt.AND || t === tt.OR ||
               t === tt.RETURN || t === tt.IF || t === tt.ELSE || t === tt.DO ||
               t === tt.WHILE || t === tt.FOR || t === tt.IN || t === tt.OF ||
               t === tt.TYPEOF || t === tt.VOID || t === tt.THROW || t === tt.DELETE ||
               t === tt.CASE || t === tt.DEFAULT || t === tt.STRICT_EQ || t === tt.STRICT_NOT_EQ ||
               t === tt.EQ || t === tt.NOT_EQ || t === tt.LT || t === tt.GT ||
               t === tt.LTE || t === tt.GTE || t === tt.BITAND || t === tt.BITOR ||
               t === tt.BITXOR || t === tt.BITNOT || t === tt.LSHIFT || t === tt.RSHIFT ||
               t === tt.URSHIFT || t === tt.ARROW || t === tt.PLUS_ASSIGN || t === tt.MINUS_ASSIGN;
    }

    readRegexLiteral() {
        const startLine = this.line;
        const startColumn = this.column;
        let result = "";
        this.readChar(); // 跳过第一个 /

        while (this.ch !== "/" && this.ch !== "" && this.ch !== "\n") {
            if (this.ch === "\\") {
                result += this.ch;
                this.readChar();
                result += this.ch;
            } else {
                result += this.ch;
            }
            this.readChar();
        }

        if (this.ch === "/") {
            this.readChar(); // 跳过结束的 /
            // 读取标志
            let flags = "";
            while (this.isLetter(this.ch) || this.isDigit(this.ch)) {
                flags += this.ch;
                this.readChar();
            }
            const fullRegex = "/" + result + "/" + flags;
            return newToken(TokenType.REGEX, fullRegex, startLine, startColumn);
        }

        return newToken(TokenType.ILLEGAL, "/", startLine, startColumn);
    }

    // 获取下一个 Token
    nextToken() {
        const tok = this._nextToken();
        if (tok.type !== TokenType.EOF) {
            this.lastTokenType = tok.type;
        }
        return tok;
    }

    _nextToken() {
        let tok;

        this.skipWhitespace();
        this.skipComment();
        this.skipWhitespace();

        let startLine = this.line;
        let startColumn = this.column;

        if (this.ch === "=") {
            if (this.peekChar() === "=") {
                this.readChar();
                if (this.peekChar() === "=") {
                    this.readChar();
                    tok = newToken(TokenType.STRICT_EQ, "===", startLine, startColumn);
                } else {
                    tok = newToken(TokenType.EQ, "==", startLine, startColumn);
                }
            } else if (this.peekChar() === ">") {
                this.readChar();
                tok = newToken(TokenType.ARROW, "=>", startLine, startColumn);
            } else {
                tok = newToken(TokenType.ASSIGN, "=", startLine, startColumn);
            }
        } else if (this.ch === "+") {
            if (this.peekChar() === "+") {
                this.readChar();
                tok = newToken(TokenType.INCREMENT, "++", startLine, startColumn);
            } else if (this.peekChar() === "=") {
                this.readChar();
                tok = newToken(TokenType.PLUS_ASSIGN, "+=", startLine, startColumn);
            } else {
                tok = newToken(TokenType.PLUS, "+", startLine, startColumn);
            }
        } else if (this.ch === "-") {
            if (this.peekChar() === "-") {
                this.readChar();
                tok = newToken(TokenType.DECREMENT, "--", startLine, startColumn);
            } else if (this.peekChar() === "=") {
                this.readChar();
                tok = newToken(TokenType.MINUS_ASSIGN, "-=", startLine, startColumn);
            } else {
                tok = newToken(TokenType.MINUS, "-", startLine, startColumn);
            }
        } else if (this.ch === "!") {
            if (this.peekChar() === "=") {
                this.readChar();
                if (this.peekChar() === "=") {
                    this.readChar();
                    tok = newToken(TokenType.STRICT_NOT_EQ, "!==", startLine, startColumn);
                } else {
                    tok = newToken(TokenType.NOT_EQ, "!=", startLine, startColumn);
                }
            } else {
                tok = newToken(TokenType.BANG, "!", startLine, startColumn);
            }
        } else if (this.ch === "/") {
            // 尝试区分除法和正则表达式
            // 启发式逻辑：如果前一个 token 是运算符、左括号或开始标记，则可能是正则
            if (this.canNextBeRegExp()) {
                tok = this.readRegexLiteral();
                return tok;
            }
            if (this.peekChar() === "=") {
                this.readChar();
                tok = newToken(TokenType.SLASH_ASSIGN, "/=", startLine, startColumn);
            } else {
                tok = newToken(TokenType.SLASH, "/", startLine, startColumn);
            }
        } else if (this.ch === "*") {
            if (this.peekChar() === "*") {
                this.readChar();
                if (this.peekChar() === "=") {
                    this.readChar();
                    tok = newToken(TokenType.POWER_ASSIGN, "**=", startLine, startColumn);
                } else {
                    tok = newToken(TokenType.POWER, "**", startLine, startColumn);
                }
            } else if (this.peekChar() === "=") {
                this.readChar();
                tok = newToken(TokenType.ASTERISK_ASSIGN, "*=", startLine, startColumn);
            } else {
                tok = newToken(TokenType.ASTERISK, "*", startLine, startColumn);
            }
        } else if (this.ch === "%") {
            if (this.peekChar() === "=") {
                this.readChar();
                tok = newToken(TokenType.PERCENT_ASSIGN, "%=", startLine, startColumn);
            } else {
                tok = newToken(TokenType.PERCENT, "%", startLine, startColumn);
            }
        } else if (this.ch === "<") {
            if (this.peekChar() === "=") {
                this.readChar();
                tok = newToken(TokenType.LTE, "<=", startLine, startColumn);
            } else if (this.peekChar() === "<") {
                this.readChar();
                if (this.peekChar() === "=") {
                    this.readChar();
                    tok = newToken(TokenType.LSHIFT_ASSIGN, "<<=", startLine, startColumn);
                } else {
                    tok = newToken(TokenType.LSHIFT, "<<", startLine, startColumn);
                }
            } else {
                tok = newToken(TokenType.LT, "<", startLine, startColumn);
            }
        } else if (this.ch === ">") {
            if (this.peekChar() === "=") {
                this.readChar();
                tok = newToken(TokenType.GTE, ">=", startLine, startColumn);
            } else if (this.peekChar() === ">") {
                this.readChar();
                if (this.peekChar() === ">") {
                    this.readChar();
                    tok = newToken(TokenType.URSHIFT, ">>>", startLine, startColumn);
                } else if (this.peekChar() === "=") {
                    this.readChar();
                    tok = newToken(TokenType.RSHIFT_ASSIGN, ">>=", startLine, startColumn);
                } else {
                    tok = newToken(TokenType.RSHIFT, ">>", startLine, startColumn);
                }
            } else {
                tok = newToken(TokenType.GT, ">", startLine, startColumn);
            }
        } else if (this.ch === "&") {
            if (this.peekChar() === "&") {
                this.readChar();
                if (this.peekChar() === "=") {
                    this.readChar();
                    tok = newToken(TokenType.LOGICAL_AND_ASSIGN, "&&=", startLine, startColumn);
                } else {
                    tok = newToken(TokenType.AND, "&&", startLine, startColumn);
                }
            } else if (this.peekChar() === "=") {
                this.readChar();
                tok = newToken(TokenType.AND_ASSIGN, "&=", startLine, startColumn);
            } else {
                tok = newToken(TokenType.BITAND, "&", startLine, startColumn);
            }
        } else if (this.ch === "|") {
            if (this.peekChar() === "|") {
                this.readChar();
                if (this.peekChar() === "=") {
                    this.readChar();
                    tok = newToken(TokenType.LOGICAL_OR_ASSIGN, "||=", startLine, startColumn);
                } else {
                    tok = newToken(TokenType.OR, "||", startLine, startColumn);
                }
            } else if (this.peekChar() === "=") {
                this.readChar();
                tok = newToken(TokenType.OR_ASSIGN, "|=", startLine, startColumn);
            } else {
                tok = newToken(TokenType.BITOR, "|", startLine, startColumn);
            }
        } else if (this.ch === "^") {
            if (this.peekChar() === "=") {
                this.readChar();
                tok = newToken(TokenType.XOR_ASSIGN, "^=", startLine, startColumn);
            } else {
                tok = newToken(TokenType.BITXOR, "^", startLine, startColumn);
            }
        } else if (this.ch === "~") {
            tok = newToken(TokenType.BITNOT, "~", startLine, startColumn);
        } else if (this.ch === "?") {
            if (this.peekChar() === ".") {
                this.readChar();
                tok = newToken(TokenType.OPTIONAL, "?.", startLine, startColumn);
            } else if (this.peekChar() === "?") {
                this.readChar();
                if (this.peekChar() === "=") {
                    this.readChar();
                    tok = newToken(TokenType.NULLISH_ASSIGN, "??=", startLine, startColumn);
                } else {
                    tok = newToken(TokenType.NULLISH, "??", startLine, startColumn);
                }
            } else {
                tok = newToken(TokenType.QUESTION, "?", startLine, startColumn);
            }
        } else if (this.ch === ",") {
            tok = newToken(TokenType.COMMA, ",", startLine, startColumn);
        } else if (this.ch === ";") {
            tok = newToken(TokenType.SEMICOLON, ";", startLine, startColumn);
        } else if (this.ch === ":") {
            tok = newToken(TokenType.COLON, ":", startLine, startColumn);
        } else if (this.ch === ".") {
            if (this.peekChar() === "." && this.peekCharN(2) === ".") {
                this.readChar();
                this.readChar();
                tok = newToken(TokenType.SPREAD, "...", startLine, startColumn);
            } else {
                tok = newToken(TokenType.DOT, ".", startLine, startColumn);
            }
        } else if (this.ch === "(") {
            tok = newToken(TokenType.LPAREN, "(", startLine, startColumn);
        } else if (this.ch === ")") {
            tok = newToken(TokenType.RPAREN, ")", startLine, startColumn);
        } else if (this.ch === "{") {
            if (this.templateDepth > 0) {
                this.braceDepth = this.braceDepth + 1;
            }
            tok = newToken(TokenType.LBRACE, "{", startLine, startColumn);
        } else if (this.ch === "}") {
            // 检查是否在模板字符串插值结束处
            if (this.templateDepth > 0 && this.braceDepth === 0) {
                this.readChar(); // 跳过 }
                let { type, value, raw } = this.readTemplateMiddle();
                // 恢复进入插值前的深度
                this.braceDepth = this.templateStack.pop() || 0;
                let tmid = newToken(type, value, startLine, startColumn);
                tmid.templateRaw = raw; // tagged template / String.raw 用的原始文本
                return tmid;
            }
            if (this.templateDepth > 0 && this.braceDepth > 0) {
                this.braceDepth = this.braceDepth - 1;
            }
            tok = newToken(TokenType.RBRACE, "}", startLine, startColumn);
        } else if (this.ch === "[") {
            tok = newToken(TokenType.LBRACKET, "[", startLine, startColumn);
        } else if (this.ch === "]") {
            tok = newToken(TokenType.RBRACKET, "]", startLine, startColumn);
        } else if (this.ch === "#") {
            // 私有字段: #name
            this.readChar(); // 跳过 #
            if (this.isLetter(this.ch) || (this.ch === "\\" && this.peekChar() === "u")) {
                let ident = this.readIdentifier();
                return newToken(TokenType.IDENT, "#" + ident, startLine, startColumn);
            }
            tok = newToken(TokenType.HASH, "#", startLine, startColumn);
        } else if (this.ch === '"' || this.ch === "'") {
            let str = this.readString(this.ch);
            return newToken(TokenType.STRING, str, startLine, startColumn);
        } else if (this.ch === "`") {
            let { type, value, raw } = this.readTemplateString();
            let ttok = newToken(type, value, startLine, startColumn);
            ttok.templateRaw = raw; // tagged template / String.raw 用的原始文本
            return ttok;
        } else if (this.ch === "\0") {
            tok = newToken(TokenType.EOF, "", startLine, startColumn);
        } else if (this.isLetter(this.ch) || (this.ch === "\\" && this.peekChar() === "u")) {
            let ident = this.readIdentifier();
            // When inside template expression (templateDepth > 0), treat keywords as identifiers
            let type = lookupIdent(ident, this.templateDepth > 0);
            return newToken(type, ident, startLine, startColumn);
        } else if (this.isDigit(this.ch)) {
            let num = this.readNumber();
            let type = TokenType.INT;
            // 进制前缀（0x/0b/0o）恒为整数：其中 e/E/. 是十六进制数字或不合法，
            // 不能当浮点指数/小数点。否则如 0x9e670000 含 'e' 被误判为 FLOAT →
            // parseFloat 解析成 0 → 汇编器大量 hex 编码常量塌成 0 → gen1 发 0 指令(udf)崩。
            const isRadix = num.startsWith("0x") || num.startsWith("0X") ||
                            num.startsWith("0b") || num.startsWith("0B") ||
                            num.startsWith("0o") || num.startsWith("0O");
            if (num.endsWith("n")) {
                type = TokenType.BIGINT;
                num = num.slice(0, -1); // Remove the 'n' suffix for the literal
            } else if (!isRadix && (num.includes(".") || num.includes("e") || num.includes("E"))) {
                type = TokenType.FLOAT;
            }
            return newToken(type, num, startLine, startColumn);
        } else {
            tok = newToken(TokenType.ILLEGAL, this.ch, startLine, startColumn);
        }

        this.readChar();
        return tok;
    }
}

// 创建词法分析器
export function newLexer(input) {
    return new Lexer(input);
}
