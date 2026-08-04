// asm.js 解析器 - 语句解析
// 解析 JavaScript 语句

import { TokenType } from "../lexer/token.js";
import * as AST from "./ast.js";
import { Precedence } from "./precedence.js";

// rest 形参绑定模式(`function f(...[a,b])`)的临时 rest 局部名序号。仅在该语法出现时
// 自增,故不影响任何既有产物(编译器自身源码不用该语法,自举逐字节不变)。
let restPatSeq = 0;

// [test262 早期错误 A] 保留字表(按 StringValue 判定)。转义标识符已在词法解码成字面值并经
// lookupIdent 重分类(lexer/index.js readIdentifier → lookupIdent),故字面字符串判定即覆盖
// `var \u{69}f` 之类转义形态(拼成 ReservedWord 非法)。
// 恒保留(任何模式都不可作绑定标识符):核心关键字 + enum + null/true/false。
// 刻意不含:get/set/from/as/of/async(上下文关键字,可作标识符)、undefined/int(合法标识符)、
// let/static/yield(严格模式保留,见 STRICT_RESERVED)、await(仅模块/async 保留,模块测试已被
// harness 排除、async 由 checkYieldAwaitBinding 覆盖)。
const ALWAYS_RESERVED = {
    "break": 1, "case": 1, "catch": 1, "class": 1, "const": 1, "continue": 1, "debugger": 1,
    "default": 1, "delete": 1, "do": 1, "else": 1, "enum": 1, "export": 1, "extends": 1,
    "finally": 1, "for": 1, "function": 1, "if": 1, "import": 1, "in": 1, "instanceof": 1,
    "new": 1, "return": 1, "super": 1, "switch": 1, "this": 1, "throw": 1, "try": 1,
    "typeof": 1, "var": 1, "void": 1, "while": 1, "with": 1,
    "null": 1, "true": 1, "false": 1,
};
// 严格模式保留(future-reserved + let/static/yield):仅 strict(inStrictMode)下不可作绑定标识符。
const STRICT_RESERVED = {
    "implements": 1, "interface": 1, "package": 1, "private": 1, "protected": 1, "public": 1,
    "let": 1, "static": 1, "yield": 1,
};
// [test262 早期错误 A] 上下文词:任何模式下皆可作绑定名,但词法各自独立成 token 类型
// (AWAIT/ASYNC/GET/SET/FROM/AS/OF/UNDEFINED/INT_TYPE)。对象模式绑定位靠本表识别
// 「词形 token」;yield/await 的生成器/异步门控由 checkYieldAwaitBinding 负责,不在此表。
const CONTEXTUAL_WORD = {
    "await": 1, "async": 1, "get": 1, "set": 1, "from": 1, "as": 1, "of": 1,
    "undefined": 1, "int": 1,
};

// 语句解析混入
export const StatementParser = {
    // ============ 解析语句 ============

    parseStatement() {
        // [安全] 递归深度守卫(见 parser/index.js 构造器):深层嵌套块/if/while 会耗尽原生栈。
        this.parseDepth = this.parseDepth + 1;
        if (this.parseDepth > this.maxParseDepth) {
            this.parseDepth = this.parseDepth - 1;
            this.errors.push(`SyntaxError: Maximum parse depth exceeded at line ${this.curToken.line}:${this.curToken.column}`);
            return null;
        }
        const stmt = this.parseStatementInner();
        this.parseDepth = this.parseDepth - 1;
        return stmt;
    },

    parseStatementInner() {
        if (this.curTokenIs(TokenType.SEMICOLON)) {
            // 空语句 `;`(#68):裸 `;`、`;;`、`class B{};`、`if(x);` 等。
            // for 循环头的 `;` 由 parseForStatement 单独消费,不经此路径。
            return new AST.EmptyStatement();
        } else if (this.curTokenIs(TokenType.LET) || this.curTokenIs(TokenType.CONST) || this.curTokenIs(TokenType.VAR) || this.curTokenIs(TokenType.INT_TYPE)) {
            const decl = this.parseVariableDeclaration();
            // [test262 S1 早期错误] 语句级 const 必须带初值(for-of/in 的 const 无初值合法,
            // 走 parseForStatement 直调 parseVariableDeclaration,不经此路径,无误拒)。
            if (decl && decl.kind === "const") {
                for (const d of decl.declarations) {
                    if (!d.init) this.errors.push("Missing initializer in const declaration");
                }
            }
            return decl;
        } else if (this.curTokenIs(TokenType.FUNCTION)) {
            return this.parseFunctionDeclaration();
        } else if (this.curTokenIs(TokenType.ASYNC) && this.peekTokenIs(TokenType.FUNCTION)) {
            return this.parseFunctionDeclaration();
        } else if (this.curTokenIs(TokenType.CLASS)) {
            return this.parseClassDeclaration();
        } else if (this.curTokenIs(TokenType.RETURN)) {
            return this.parseReturnStatement();
        } else if (this.curTokenIs(TokenType.IF)) {
            return this.parseIfStatement();
        } else if (this.curTokenIs(TokenType.FOR)) {
            return this.parseForStatement();
        } else if (this.curTokenIs(TokenType.WHILE)) {
            return this.parseWhileStatement();
        } else if (this.curTokenIs(TokenType.DO)) {
            return this.parseDoWhileStatement();
        } else if (this.curTokenIs(TokenType.IDENT) && this.curToken.literal === "with" && this.peekTokenIs(TokenType.LPAREN)) {
            // `with (obj) stmt` —— with 是保留字(词法归 IDENT),语句首 `with (` 唯一解。
            return this.parseWithStatement();
        } else if (this.curTokenIs(TokenType.SWITCH)) {
            return this.parseSwitchStatement();
        } else if (this.curTokenIs(TokenType.BREAK)) {
            return this.parseBreakStatement();
        } else if (this.curTokenIs(TokenType.CONTINUE)) {
            return this.parseContinueStatement();
        } else if (this.curTokenIs(TokenType.TRY)) {
            return this.parseTryStatement();
        } else if (this.curTokenIs(TokenType.THROW)) {
            return this.parseThrowStatement();
        } else if (this.curTokenIs(TokenType.IMPORT)) {
            // 语句首的 `import(` = 动态 import 表达式语句、`import.meta` = meta 属性,
            // 均非静态 import 声明(那需 `import ... from`)。按表达式语句解析,
            // 交给 parseImportExpression(IMPORT 的前缀解析函数)。
            if (this.peekTokenIs(TokenType.LPAREN) || this.peekTokenIs(TokenType.DOT)) {
                return this.parseExpressionStatement();
            }
            return this.parseImportDeclaration();
        } else if (this.curTokenIs(TokenType.EXPORT)) {
            return this.parseExportDeclaration();
        } else if (this.curTokenIs(TokenType.LBRACE)) {
            return this.parseBlockStatement();
        } else if (this.curTokenIs(TokenType.IDENT) && this.curToken.literal === "js" &&
                   this.peekTokenIs(TokenType.IDENT) &&
                   this.peekToken.line === this.curToken.line) {
            // [方言] `js f(x)` 协程派发语句:语句首标识符 js + **同行**标识符起始的调用。
            // 两个相邻标识符在标准 JS 中不可能合法,语法空间干净;js 在其它位置
            // (const js=1 / js(x) / js.m() / js\nf())仍是普通标识符(上下文关键字,同 async)。
            return this.parseSpawnStatement();
        } else if (this.curTokenIs(TokenType.IDENT) && this.peekTokenIs(TokenType.COLON)) {
            // 标签语句 `label: stmt`。语句起始位置的 `IDENT :` 唯一解为标签
            // （三元的 `:` 前必有 `?`;对象字面量不能作语句首)。
            return this.parseLabeledStatement();
        } else {
            return this.parseExpressionStatement();
        }
    },

    // [方言] js <CallExpression>:被派发的调用必须是调用表达式(js foo / js a+b 报错)。
    parseSpawnStatement() {
        this.nextToken(); // 越过 js,cur = 调用表达式首 token
        const expr = this.parseExpression(Precedence.LOWEST);
        if (!expr || expr.type !== "CallExpression") {
            this.errors.push("js-spawn: expected call expression after 'js'");
            return null;
        }
        if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
        return new AST.SpawnStatement(expr);
    },

    parseLabeledStatement() {
        let label = new AST.Identifier(this.curToken.literal);
        this.nextToken(); // 越过标识符，当前为 ':'
        this.nextToken(); // 越过 ':'，当前为被标注语句的首 token
        let body = this.parseStatement();
        return new AST.LabeledStatement(label, body);
    },

    parseVariableDeclaration() {
        let decl = new AST.VariableDeclaration(this.curToken.literal);
        // [test262 早期错误 A] 词法声明(let/const)下模式绑定位的 let 名恒拒(sloppy 亦拒);
        // var 位 sloppy 收。lexical 经 parseObjectPattern/parseArrayPattern 透传嵌套模式
        // (for-of/in 头经本函数解析,同样覆盖)。
        const lexical = decl.kind === "let" || decl.kind === "const";
        do {
            this.nextToken();
            let id;
            if (this.curTokenIs(TokenType.LBRACE)) {
                id = this.parseObjectPattern(lexical);
            } else if (this.curTokenIs(TokenType.LBRACKET)) {
                id = this.parseArrayPattern(lexical);
            } else if (this.curTokenIsIdentifier()) {
                this.checkYieldAwaitBinding(this.curToken.literal);   // [test262 S1] var yield/await
                this.checkReservedBinding(this.curToken.literal);     // [test262 早期错误 A] 保留字
                id = new AST.Identifier(this.curToken.literal);
            } else {
                this.errors.push("expected identifier");
                return null;
            }
            let init = null;
            if (this.peekTokenIs(TokenType.ASSIGN)) {
                this.nextToken();
                this.nextToken();
                // ASSIGN-1(=COMMA 优先级)而非 ASSIGN:允许 init 内嵌赋值 `var x = o.p = 10`
                // (`=` 优先级 ASSIGN=3 > 2 故被消费),但仍在 `,` 处停(多声明符 `var a=1,b=2`
                // 的 COMMA=2 不 <2 → 不消费)。与 parseAssignmentExpression 的 RHS 优先级取齐。
                // 普通 `var x = expr`(无尾随 =)AST 逐字节不变 → 自举定点保持。
                init = this.parseExpression(Precedence.ASSIGN - 1);
            }
            decl.declarations.push(new AST.VariableDeclarator(id, init));
        } while (this.peekTokenIs(TokenType.COMMA) && (this.nextToken(), true));
        if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
        return decl;
    },

    parseFunctionDeclaration(defaultName) {
        let isAsync = false;
        let isGenerator = false;
        if (this.curTokenIs(TokenType.ASYNC)) {
            isAsync = true;
            this.nextToken();
        }
        if (this.peekTokenIs(TokenType.ASTERISK)) {
            isGenerator = true;
            this.nextToken();
        }
        // 匿名 default export:无名函数(peek 是 `(`)时赋合成名,不消费名字 token。
        let id;
        // 真值判定(而非 != null):自举运行时 `!= null` 语义与 node 有别,truthy 更稳。
        // defaultName 只可能是非空合成名字符串(truthy)或未传(undefined,falsy)。
        if (defaultName && this.peekTokenIs(TokenType.LPAREN)) {
            id = new AST.Identifier(defaultName);
        } else {
            if (!this.expectIdentifier()) return null;
            this.checkReservedBinding(this.curToken.literal);   // [test262 早期错误 A] 函数名保留字
            id = new AST.Identifier(this.curToken.literal);
        }
        if (!this.expectPeek(TokenType.LPAREN)) return null;
        // [test262 S1] 进入生成器/异步深度:覆盖形参 + 体内 var 绑定的 yield/await 早期错误校验
        if (isGenerator) this.fnGenDepth++;
        if (isAsync) this.fnAsyncDepth++;
        // [Wave 8] 函数边界:字段初始化器上下文在函数声明内复位,返回前须恢复。
        // [L2-④] _inFormalParams 同理:嵌套函数内 await/yield 合法,边界复位。
        const prevInFieldInit = this._inFieldInit;
        const prevInFormal = this._inFormalParams;
        this._inFieldInit = false;
        this._inFormalParams = false;
        let params = this.parseFunctionParams();
        if (!this.expectPeek(TokenType.LBRACE)) {
            if (isGenerator) this.fnGenDepth--;
            if (isAsync) this.fnAsyncDepth--;
            this._inFieldInit = prevInFieldInit;
            this._inFormalParams = prevInFormal;
            return null;
        }
        // [test262 S1] strict 探测:"use strict" 指令 → strict 深度 + 回溯形参校验
        let isStrict = this.peekUseStrictDirective();
        if (isStrict) { this.fnStrictDepth++; this.checkStrictParams(params); }
        this.checkInheritedStrictParams(params, isStrict);   // [test262 早期错误 C] 继承 strict 重参
        let body = this.parseBlockStatement();
        if (isStrict) this.fnStrictDepth--;
        if (isGenerator) this.fnGenDepth--;
        if (isAsync) this.fnAsyncDepth--;
        this._inFieldInit = prevInFieldInit;
        this._inFormalParams = prevInFormal;
        return new AST.FunctionDeclaration(id, params, body, isAsync, isGenerator);
    },

    // [test262 S1] yield/await 作绑定标识符(形参/var 名)在生成器/异步函数内是早期错误
    // (作 yield/await 表达式合法,故只在绑定名校验);strict 下 eval/arguments 不可作绑定名。
    checkYieldAwaitBinding(name) {
        if (name === "yield" && this.fnGenDepth > 0) {
            this.errors.push("Cannot use 'yield' as a binding name inside a generator");
        }
        if (name === "await" && this.fnAsyncDepth > 0) {
            this.errors.push("Cannot use 'await' as a binding name inside an async function");
        }
        if (this.fnStrictDepth > 0 && (name === "eval" || name === "arguments")) {
            this.errors.push("Cannot use '" + name + "' as a binding name in strict mode");
        }
    },

    // [test262 早期错误 A] 绑定标识符的保留字校验:Identifier = IdentifierName but not ReservedWord。
    // 仅在「绑定/形参/声明名」位调用(绝不在属性名/方法名/标签位,故 { if:1 } / o.public=1 合法)。
    // 恒保留字任何模式报错;严格保留字仅 inStrictMode 报错(sloppy var let=1 / var public=1 仍合法)。
    // yield 生成器内 / await 异步内由 checkYieldAwaitBinding 另管,此处不重复。
    checkReservedBinding(name) {
        if (typeof name !== "string" || name.length === 0) return;
        // [test262 早期错误 A] strict 模式下 eval/arguments 不得作为绑定标识符。
        if (this.inStrictMode() && (name === "eval" || name === "arguments")) {
            this.errors.push("Cannot declare '" + name + "' as an identifier in strict mode");
            return;
        }
        if (ALWAYS_RESERVED[name] === 1) {
            this.errors.push("Cannot use reserved word '" + name + "' as an identifier");
            return;
        }
        if (STRICT_RESERVED[name] === 1 && this.inStrictMode()) {
            this.errors.push("Cannot use reserved word '" + name + "' as an identifier in strict mode");
        }
    },

    // [test262 早期错误 A] 对象模式绑定位的「词形 token」判定:IDENT,或 literal 命中
    // 保留字表/上下文词表的关键字 token(yield/let/static/await/async/get/set 等,词法
    // 把关键字各自分成独立 token 类型)。curTokenIsIdentifier 是黑名单(运算符/字符串/
    // 正则/模板皆真)过宽:`{x: "if"}` 的 STRING literal 恰为词形,误判为绑定名会误收
    // 非法程序,故字面量类 token 先行排除。命中仅表示「可占绑定位」,保留字/strict/
    // 上下文门控仍由 checkReservedBinding/checkYieldAwaitBinding 在绑定点执行。
    isBindingWordToken(tok) {
        if (!tok) return false;
        const t = tok.type;
        if (t === TokenType.IDENT) return true;
        if (t === TokenType.STRING || t === TokenType.INT || t === TokenType.FLOAT ||
            t === TokenType.BIGINT || t === TokenType.REGEX ||
            t === TokenType.TEMPLATE_STRING || t === TokenType.TEMPLATE_HEAD ||
            t === TokenType.TEMPLATE_MIDDLE || t === TokenType.TEMPLATE_TAIL) return false;
        const lit = tok.literal;
        if (typeof lit !== "string" || lit.length === 0) return false;
        return ALWAYS_RESERVED[lit] === 1 || STRICT_RESERVED[lit] === 1 || CONTEXTUAL_WORD[lit] === 1;
    },

    // [test262 早期错误 A] let 作绑定名在**词法声明**(let/const/catch pattern 参数)下恒拒
    // (sloppy 亦拒,Node:"let is disallowed as a lexically bound name");var 声明与形参位
    // sloppy 收(`var {let} = o` / `function f({let}) {}` 合法,故调用点不传 lexical)。
    // strict 下 var {let} 的拒绝由 checkReservedBinding(STRICT_RESERVED)覆盖,与此正交。
    checkLexicalLetBinding(name, lexical) {
        if (lexical && name === "let") {
            this.errors.push("Cannot use 'let' as a binding name in a lexical declaration");
        }
    },

    // [test262 S1] 函数体首语句是否 "use strict" 指令(curToken 须为 `{`,窥探首 token)。
    // 启发式:体首即字符串字面量 "use strict" 视为指令(覆盖绝大多数情形)。
    peekUseStrictDirective() {
        return this.peekTokenIs(TokenType.STRING) && this.peekToken.literal === "use strict";
    },

    // [test262 S1] 收集形参绑定名(展平解构),供 strict 重参/eval/arguments 回溯校验。
    collectParamNames(param, out) {
        if (!param) return;
        const t = param.type;
        if (t === "Identifier") { out.push(param.name); return; }
        if (t === "AssignmentPattern") { this.collectParamNames(param.left, out); return; }
        if (t === "SpreadElement") { this.collectParamNames(param.argument, out); return; }
        if (t === "ObjectPattern") {
            for (const p of (param.properties || [])) {
                if (p.type === "SpreadElement") this.collectParamNames(p.argument, out);
                else this.collectParamNames(p.value, out);
            }
            return;
        }
        if (t === "ArrayPattern") {
            for (const e of (param.elements || [])) this.collectParamNames(e, out);
            return;
        }
    },

    // [test262 S1] strict 形参回溯校验:函数体带**显式** "use strict" 指令时,形参不得为非简单
    // 形参(默认值/剩余/解构)——Node 抛 SyntaxError。checkStrictParams 仅在显式指令处调用
    // (peekUseStrictDirective 命中)。注意:非简单形参禁令是「函数体内指令」专属——继承 strict
    // (程序级指令/类体隐式)下 `"use strict"; function f(a=1){}` 仍合法,故此检查不随继承 strict 触发。
    // 显式指令既已使函数 strict,形参名约束(重名/eval/arguments)经 checkStrictParamNames 一并校验。
    checkStrictParams(params) {
        for (const p of (params || [])) {
            if (p && p.type !== "Identifier") {
                this.errors.push("Illegal 'use strict' directive in function with non-simple parameter list");
                break;
            }
        }
        this.checkStrictParamNames(params);
    },

    // [test262 早期错误 C] strict 形参**名**校验:重名 + eval/arguments 不可作形参。凡函数处于
    // strict(显式指令 或 继承)即触发,不含非简单形参检查(那是显式指令专属)。
    checkStrictParamNames(params) {
        const names = [];
        for (const p of (params || [])) this.collectParamNames(p, names);
        const seen = {};
        for (const n of names) {
            if (n === "eval" || n === "arguments") {
                this.errors.push("Cannot use '" + n + "' as a parameter name in strict mode");
            }
            if (seen[n]) this.errors.push("Duplicate parameter name '" + n + "' not allowed in strict mode");
            seen[n] = true;
        }
    },

    // [test262 早期错误 C] 继承 strict 下的形参名补查:函数体无自有 "use strict" 指令(ownStrict
    // 为 false)但处于 strict(程序级指令 programStrict / 外层 strict 函数 fnStrictDepth>0 / 类体
    // 隐式 strict classDepth>0)时,补查重名/eval/arguments。自有指令站点已由 checkStrictParams 覆盖,
    // ownStrict 为真时直接返回避免重复报错。sloppy 顶层 `function f(a,a){}` 三gate皆假 → 不触发(仍合法)。
    checkInheritedStrictParams(params, ownStrict) {
        if (ownStrict) return;
        if (this.inStrictMode() || this.classDepth > 0) {
            this.checkStrictParamNames(params);
        }
    },

    parseFunctionParams() {
        const prevInFormal = this._inFormalParams;
        this._inFormalParams = true;
        let params = [];
        if (this.peekTokenIs(TokenType.RPAREN)) {
            this.nextToken();
            this._inFormalParams = prevInFormal;
            return params;
        }
        this.nextToken();
        let firstParam = this.parseFunctionParam(true);
        // [test262 早期错误 D] rest 形参必须末位且不得带尾逗号:`(...a, b)` / `(...a,)` 皆
        // SyntaxError。rest 形参产出 SpreadElement;其后紧跟逗号(COMMA)即非法(无论逗号后
        // 是形参还是 `)`)。ALWAYS 文法约束,与 strict 无关。
        if (firstParam && firstParam.type === "SpreadElement" && this.peekTokenIs(TokenType.COMMA)) {
            this.errors.push("Rest parameter must be last formal parameter");
        }
        this.pushFunctionParam(params, firstParam);
        while (this.peekTokenIs(TokenType.COMMA)) {
            this.nextToken(); // curToken = ,
            // 尾逗号 function f(a, b,) {}:逗号后紧跟 ) → 停止,别把 ) 当形参解析。
            if (this.peekTokenIs(TokenType.RPAREN)) break;
            this.nextToken();
            let nextParam = this.parseFunctionParam(true);
            if (nextParam && nextParam.type === "SpreadElement" && this.peekTokenIs(TokenType.COMMA)) {
                this.errors.push("Rest parameter must be last formal parameter");
            }
            this.pushFunctionParam(params, nextParam);
        }
        if (!this.expectPeek(TokenType.RPAREN)) { this._inFormalParams = prevInFormal; return null; }
        this._inFormalParams = prevInFormal;
        return params;
    },

    // rest 形参的绑定模式 `function f(...[a, b])`:parseFunctionParam 返回
    // `SpreadElement(Identifier(__restpat_N))` 并把模式挂在 .restPattern 上,这里把模式
    // 展成紧随其后的**影子形参**。codegen 侧无须改动四处形参循环:SpreadElement 分支照旧
    // 在正确时机(实参寄存器未被踩)把 rest 收进局部 __restpat_N,影子形参走既有解构形参
    // 分支延后解构,由 emitParamDestructure 按 .restSource 取回该局部(见
    // compiler/functions/statements.js)。展开后清掉 .restPattern,免得同一节点在 AST 里
    // 被两处引用(遍历器重复下钻)。
    pushFunctionParam(params, param) {
        params.push(param);
        if (!param || !param.restPattern) return;
        const pat = param.restPattern;
        param.restPattern = null;
        // rest 落在第 6 个形参位起(实参寄存器只有 A0..A4)时,影子形参会越过 codegen 的
        // 形参循环上界而静默不解构 —— 宁可明确报错。
        if (params.length > 5) {
            this.errors.push("Unsupported rest parameter binding pattern beyond the 5th parameter");
            return;
        }
        params.push(pat);
    },

    // allowRestPattern:仅 parseFunctionParams 传 true。箭头形参(parser/expressions.js)
    // 逐个 push parseFunctionParam 的返回值,无法接住影子形参,故那条路径继续拒绝
    // `(...[a, b]) => …`(明确报错,不静默少绑定)。
    parseFunctionParam(allowRestPattern) {
        if (this.curTokenIs(TokenType.SPREAD)) {
            // rest 形参目标按 ES 是 BindingElement,可为绑定模式(`function f(...[a, b])`)。
            this.nextToken();
            if (this.curTokenIs(TokenType.LBRACE) || this.curTokenIs(TokenType.LBRACKET)) {
                const pat = this.curTokenIs(TokenType.LBRACE) ? this.parseObjectPattern() : this.parseArrayPattern();
                if (!allowRestPattern) {
                    this.errors.push("Unsupported rest parameter binding pattern in arrow function parameters");
                    return pat;
                }
                restPatSeq = restPatSeq + 1;
                const restName = "__restpat_" + restPatSeq;
                const sp = new AST.SpreadElement(new AST.Identifier(restName));
                pat.restSource = restName;   // codegen 据此取回收集好的 rest 数组
                sp.restPattern = pat;        // 由 pushFunctionParam 展成影子形参
                return sp;
            }
            this.checkYieldAwaitBinding(this.curToken.literal);   // [test262 S1] ...yield/...await
            this.checkReservedBinding(this.curToken.literal);     // [test262 早期错误 A] 保留字
            return new AST.SpreadElement(new AST.Identifier(this.curToken.literal));
        }
        // [#47] 解构形参:function f({a,b})/f([a,b])/({a}={})。子 pattern 递归解析,
        // 消费到闭合 }/] 后再看默认值 ASSIGN(与 Identifier 形参同构)。
        let id;
        if (this.curTokenIs(TokenType.LBRACE)) {
            id = this.parseObjectPattern();
        } else if (this.curTokenIs(TokenType.LBRACKET)) {
            id = this.parseArrayPattern();
        } else {
            this.checkYieldAwaitBinding(this.curToken.literal);   // [test262 S1] yield/await 形参
            this.checkReservedBinding(this.curToken.literal);     // [test262 早期错误 A] 保留字
            id = new AST.Identifier(this.curToken.literal);
        }
        if (this.peekTokenIs(TokenType.ASSIGN)) {
            this.nextToken();
            this.nextToken();
            // 默认值是 **AssignmentExpression** 位,须用 ASSIGN-1(=COMMA=2)解析:
            // LOWEST(1) 会让逗号(COMMA=2)被当作序列运算符吞掉后续形参
            // (f(a=9,b,c) 被解析成单个形参 a=(9,b,c)),导致 b/c 从不入槽、恒读 0;
            // 而 ASSIGN(3) 又太高 —— Pratt 循环 `3 < 3` 假使 `f(a = q += 1)` 里的
            // `+=` 不被消费,报 "expected ), got +="。ASSIGN-1 两者兼顾。
            return new AST.AssignmentPattern(id, this.parseExpression(Precedence.ASSIGN - 1));
        }
        return id;
    },

    parseBlockStatement() {
        let block = new AST.BlockStatement([]);
        this.nextToken();
        while (!this.curTokenIs(TokenType.RBRACE) && !this.curTokenIs(TokenType.EOF)) {
            let stmt = this.parseStatement();
            if (stmt !== null) block.body.push(stmt);
            this.nextToken();
        }
        return block;
    },

    parseReturnStatement() {
        let stmt = new AST.ReturnStatement(null);
        // 裸 return(无实参):peek 为 } / ; / EOF 时不得越过 return——否则会把块的
        // 收尾 } 当成 return 自身的末 token 吞掉,吃掉其后一条语句(bare-return swallow)。
        if (!this.peekTokenIs(TokenType.SEMICOLON) && !this.peekTokenIs(TokenType.RBRACE) && !this.peekTokenIs(TokenType.EOF)) {
            this.nextToken();
            stmt.argument = this.parseExpression(Precedence.LOWEST);
        }
        if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
        return stmt;
    },

    parseIfStatement() {
        if (!this.expectPeek(TokenType.LPAREN)) return null;
        this.nextToken();
        let test = this.parseExpression(Precedence.LOWEST);
        if (!this.expectPeek(TokenType.RPAREN)) return null;
        this.nextToken();
        let consequent = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
        let alternate = null;
        if (this.peekTokenIs(TokenType.ELSE)) {
            this.nextToken();
            this.nextToken();
            if (this.curTokenIs(TokenType.IF)) {
                alternate = this.parseIfStatement();
            } else if (this.curTokenIs(TokenType.LBRACE)) {
                alternate = this.parseBlockStatement();
            } else {
                alternate = this.parseStatement();
            }
        }
        return new AST.IfStatement(test, consequent, alternate);
    },

    parseForStatement() {
        // for await (BINDING of ASYNC-ITERABLE):await 在 for 之后、( 之前。
        let isAwait = false;
        if (this.peekTokenIs(TokenType.AWAIT)) {
            this.nextToken(); // 越过 await
            isAwait = true;
        }
        if (!this.expectPeek(TokenType.LPAREN)) return null;
        this.nextToken();
        let init = null;
        if (this.curTokenIs(TokenType.LET) || this.curTokenIs(TokenType.CONST) || this.curTokenIs(TokenType.VAR)) {
            init = this.parseVariableDeclaration();
            if (this.peekTokenIs(TokenType.IN)) {
                this.nextToken();
                this.nextToken();
                let right = this.parseExpression(Precedence.LOWEST);
                if (!this.expectPeek(TokenType.RPAREN)) return null;
                this.nextToken();
                let body = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
                return new AST.ForInStatement(init, right, body);
            }
            if (this.peekTokenIs(TokenType.OF)) {
                this.nextToken();
                this.nextToken();
                let right = this.parseExpression(Precedence.LOWEST);
                if (!this.expectPeek(TokenType.RPAREN)) return null;
                this.nextToken();
                let body = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
                return new AST.ForOfStatement(init, right, body, isAwait);
            }
        } else if (!this.curTokenIs(TokenType.SEMICOLON)) {
            init = this.parseExpression(Precedence.LOWEST);
            // [test262 S1] 非声明式 for-of/in 左值:for (a of x) / for ([a,b] of x) / for (a in x) /
            // for ([a,b] in obj)。左值为表达式(标识符/成员/数组-对象表达式);数组-对象表达式由
            // 编译器 reinterpretAsPattern 重解释为赋值形 pattern。修 ~90 个 "expected ;, got OF" COMPILE_FAIL。
            if (this.peekTokenIs(TokenType.OF)) {
                // [test262 S1] 头部左值内层目标位校验(只拒逗号序列):`for ([(x, y)] of []) {}`。
                this.checkPatternTargets(init);
                // for-of:of 非运算符,parseExpression 在其前已停。
                this.nextToken();
                this.nextToken();
                let right = this.parseExpression(Precedence.LOWEST);
                if (!this.expectPeek(TokenType.RPAREN)) return null;
                this.nextToken();
                let body = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
                return new AST.ForOfStatement(init, right, body, isAwait);
            }
            if (init && init.type === "BinaryExpression" && init.operator === "in" &&
                this.peekTokenIs(TokenType.RPAREN)) {
                // for-in:`a in x` 被 parseExpression 当二元 in 吞掉 → 顶层 in 且后随 `)` 即 for-in,
                // 拆 left/right。区别于 `for((a in x);b;c)` 常规 for(其后随 `;` 不命中此分支)。
                let right = init.right;
                let left = init.left;
                this.checkPatternTargets(left);   // [test262 S1] 同 for-of:头部左值只拒逗号序列
                if (!this.expectPeek(TokenType.RPAREN)) return null;   // 移到 )
                this.nextToken();   // 移到 body
                let body = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
                return new AST.ForInStatement(left, right, body);
            }
        }
        if (!this.curTokenIs(TokenType.SEMICOLON)) {
            if (!this.expectPeek(TokenType.SEMICOLON)) return null;
        }
        this.nextToken();
        let test = null;
        if (!this.curTokenIs(TokenType.SEMICOLON)) {
            test = this.parseExpression(Precedence.LOWEST);
        }
        // test 段空(for(;;) / for(a;;c))时 curToken 已是第二个 `;`,直接消费;
        // 非空时 curToken 是 test 末 token,expectPeek 移到 `;`。镜像上方 init 分隔符处理,
        // 否则空 test 段对 peek=`)` 做 expectPeek(SEMICOLON) 失败 → for(;;) COMPILE_FAIL。
        if (!this.curTokenIs(TokenType.SEMICOLON)) {
            if (!this.expectPeek(TokenType.SEMICOLON)) return null;
        }
        this.nextToken();
        let update = null;
        if (!this.curTokenIs(TokenType.RPAREN)) {
            update = this.parseExpression(Precedence.LOWEST);
        }
        // update 段空(for(;;) / for(;test;))时 curToken 已是 `)`,直接消费;非空时
        // curToken 是 update 末 token,expectPeek 移到 `)`。同 test 段,否则空 update 段崩。
        if (!this.curTokenIs(TokenType.RPAREN)) {
            if (!this.expectPeek(TokenType.RPAREN)) return null;
        }
        this.nextToken();
        let body = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
        return new AST.ForStatement(init, test, update, body);
    },

    parseWhileStatement() {
        if (!this.expectPeek(TokenType.LPAREN)) return null;
        this.nextToken();
        let test = this.parseExpression(Precedence.LOWEST);
        if (!this.expectPeek(TokenType.RPAREN)) return null;
        this.nextToken();
        let body = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
        return new AST.WhileStatement(test, body);
    },

    parseWithStatement() {
        // `with` 是保留字,词法当 IDENT;语句首 `with (` 唯一解为 with 语句(非调用)。
        if (!this.expectPeek(TokenType.LPAREN)) return null;
        this.nextToken();
        let object = this.parseExpression(Precedence.LOWEST);
        if (!this.expectPeek(TokenType.RPAREN)) return null;
        this.nextToken();
        let body = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
        return new AST.WithStatement(object, body);
    },

    parseDoWhileStatement() {
        this.nextToken();
        let body = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
        if (!this.expectPeek(TokenType.WHILE)) return null;
        if (!this.expectPeek(TokenType.LPAREN)) return null;
        this.nextToken();
        let test = this.parseExpression(Precedence.LOWEST);
        if (!this.expectPeek(TokenType.RPAREN)) return null;
        if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
        return new AST.DoWhileStatement(body, test);
    },

    parseSwitchStatement() {
        if (!this.expectPeek(TokenType.LPAREN)) return null;
        this.nextToken();
        let discriminant = this.parseExpression(Precedence.LOWEST);
        if (!this.expectPeek(TokenType.RPAREN)) return null;
        if (!this.expectPeek(TokenType.LBRACE)) return null;
        let cases = [];
        this.nextToken();
        while (!this.curTokenIs(TokenType.RBRACE) && !this.curTokenIs(TokenType.EOF)) {
            let test = null;
            if (this.curTokenIs(TokenType.CASE)) {
                this.nextToken();
                test = this.parseExpression(Precedence.LOWEST);
            } else if (!this.curTokenIs(TokenType.DEFAULT)) {
                this.nextToken();
                continue;
            }
            if (!this.expectPeek(TokenType.COLON)) return null;
            let consequent = [];
            this.nextToken();
            while (!this.curTokenIs(TokenType.CASE) && !this.curTokenIs(TokenType.DEFAULT) && !this.curTokenIs(TokenType.RBRACE) && !this.curTokenIs(TokenType.EOF)) {
                let stmt = this.parseStatement();
                if (stmt !== null) consequent.push(stmt);
                this.nextToken();
            }
            cases.push(new AST.SwitchCase(test, consequent));
        }
        return new AST.SwitchStatement(discriminant, cases);
    },

    parseBreakStatement() {
        let label = null;
        if (this.peekTokenIs(TokenType.IDENT)) {
            this.nextToken();
            label = new AST.Identifier(this.curToken.literal);
        }
        if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
        return new AST.BreakStatement(label);
    },

    parseContinueStatement() {
        let label = null;
        if (this.peekTokenIs(TokenType.IDENT)) {
            this.nextToken();
            label = new AST.Identifier(this.curToken.literal);
        }
        if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
        return new AST.ContinueStatement(label);
    },

    parseTryStatement() {
        if (!this.expectPeek(TokenType.LBRACE)) return null;
        let block = this.parseBlockStatement();
        let handler = null;
        let finalizer = null;
        if (this.peekTokenIs(TokenType.CATCH)) {
            this.nextToken();
            let param = null;
            if (this.peekTokenIs(TokenType.LPAREN)) {
                this.nextToken();
                this.nextToken();
                // catch 头解构 catch([i,j])/catch({a,b}):param 可为数组/对象 pattern。
                // [test262 早期错误 A] catch pattern 绑定位属词法声明:{let} 恒拒
                // (裸标识符 catch (let) sloppy 收,走下 else 分支不经 pattern,不受影响)。
                if (this.curTokenIs(TokenType.LBRACE)) {
                    param = this.parseObjectPattern(true);
                } else if (this.curTokenIs(TokenType.LBRACKET)) {
                    param = this.parseArrayPattern(true);
                } else {
                    param = new AST.Identifier(this.curToken.literal);
                }
                if (!this.expectPeek(TokenType.RPAREN)) return null;
            }
            if (!this.expectPeek(TokenType.LBRACE)) return null;
            let catchBody = this.parseBlockStatement();
            handler = new AST.CatchClause(param, catchBody);
        }
        if (this.peekTokenIs(TokenType.FINALLY)) {
            this.nextToken();
            if (!this.expectPeek(TokenType.LBRACE)) return null;
            finalizer = this.parseBlockStatement();
        }
        return new AST.TryStatement(block, handler, finalizer);
    },

    parseThrowStatement() {
        this.nextToken();
        let argument = this.parseExpression(Precedence.LOWEST);
        if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
        return new AST.ThrowStatement(argument);
    },

    parseExpressionStatement() {
        let expr = this.parseExpression(Precedence.LOWEST);
        if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
        return new AST.ExpressionStatement(expr);
    },
};
