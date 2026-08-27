// asm.js 解析器 - 语句解析
// 解析 JavaScript 语句

import { TokenType } from "../lexer/token.js";
import * as AST from "./ast.js";
import { Precedence } from "./precedence.js";
import { collectPatternNames, collectVarDeclarations } from "../analysis/closure.js";

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
        } else if (this.curTokenIs(TokenType.IDENT) && this.curToken.literal === "debugger" && !this.curToken.escaped) {
            // [test262 statements/debugger] debugger 语句(no-op):语句位合法;
            // 表达式位(`(debugger)`)由 parseIdentifier 拒。转义形态按标识符走。
            this.nextToken();
            if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
            return new AST.EmptyStatement();
        } else if (this.curTokenIs(TokenType.LET) || this.curTokenIs(TokenType.CONST) || this.curTokenIs(TokenType.VAR) || this.curTokenIs(TokenType.INT_TYPE)) {
            // [escaped-let] `l\\u0065t a;`:转义拼成的 let 不是词法声明关键词,按表达式标识符
            // 解析(其后 a 自然产生语法错误,或作 ASI 表达式语句)。
            if (this.curTokenIs(TokenType.LET) && this.curToken.escaped) {
                return this.parseExpressionStatement();
            }
            // [test262 ASI] sloppy-mode `let` followed by any token on a new line is ASI:
            // `let` becomes an expression identifier, not a declaration keyword.
            // Covers: `L: let\\n{}`, `for(;;) let\\nx=1`, `if(x) let\\nx=1`, `with(o) let\\nx=1`.
            if (this.curTokenIs(TokenType.LET) && !this.inStrictMode() &&
                this.peekToken.line !== this.curToken.line) {
                return this.parseExpressionStatement();
            }
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
        } else if (this.isAsyncFunctionHead()) {
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
        } else if ((this.curTokenIs(TokenType.IDENT) ||
                    (this.curTokenIs(TokenType.YIELD) && !this._immediateGen) ||
                    (this.curTokenIs(TokenType.AWAIT) && !this._immediateAsync)) &&
                   this.peekTokenIs(TokenType.COLON)) {
            // 标签语句 `label: stmt`。语句起始位置的 `IDENT :` 唯一解为标签
            // （三元的 `:` 前必有 `?`;对象字面量不能作语句首)。
            // [test262 parser-edge] 未转义的 yield/await 由词法归为 YIELD/AWAIT 记号,
            // 非生成器/非异步上下文中可作标识符(包括标签 `yield:`),故一并识别。
            // 生成器/异步体内 yield/await 是关键词,落 parseExpressionStatement → 前缀
            // parseYieldExpression/parseAwaitExpression 正确处理,不误进标签路径。
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
        // [test262 标签重复] 同函数内不得有同名 label,但 Annex B 允许 sloppy 下重复。
        const name = this.curToken.literal;
        // [test262 labeled/value-yield-strict] strict 下 yield/await 是保留字,不可作标签
        // (onlyStrict 旗标把源包进 "use strict";sloppy 仍收,Node 对拍)。
        if (this.inStrictMode() && (name === "yield" || name === "await")) {
            this.errors.push("Cannot use '" + name + "' as a label in strict mode");
        }
        if (this.inStrictMode() && this._usedLabels.has(name)) {
            this.errors.push("Label '" + name + "' has already been declared");
        }
        this._usedLabels.add(name);
        let label = new AST.Identifier(name);
        this.nextToken(); // 越过标识符，当前为 ':'
        this.nextToken(); // 越过 ':'，当前为被标注语句的首 token
        // [break-label] 标签入栈:若体内是迭代/switch,parse 时经 _markBreakableLabels
        // 把本标签记为 break 合法目标;否则 break L 在 parseBreakStatement 报错。
        if (!this._labelStack) this._labelStack = [];
        const rec = { name: name, breakable: false };
        this._labelStack.push(rec);
        let body = this.parseStatement();
        this._labelStack.pop();
        this.checkStatementBody(body);   // [test262 早期错误] label: const/let/function 声明非法
        const stmt = new AST.LabeledStatement(label, body);
        stmt._labelBreakable = rec.breakable;
        return stmt;
    },

    // [break-label] 迭代/switch 解析入口调用:把当前函数内所有在栈标签记为 break 合法目标
    // (ES:break L 的 L 必须标注外层 IterationStatement 或 SwitchStatement)。
    _markBreakableLabels() {
        if (!this._labelStack) return;
        for (let i = 0; i < this._labelStack.length; i++) this._labelStack[i].breakable = true;
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
                // [test262] 词法声明位(let/const)的 "let" 绑定名恒拒(sloppy 亦拒;
                // 与模式路径 lexical 透传口径一致。var 位 sloppy 合法不动)。
                if (lexical && this.curToken.literal === "let") {
                    this.errors.push("'let' is not allowed as a lexical binding name");
                }
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

    // [test262 早期错误] for-in/of 头部词法声明(let/const)的早期错误:
    // 1) BoundNames 含重复(`for (let [x, x] in {})`);
    // 2) 头部绑定名与 body VarDeclaredNames 冲突(`for (let x of []) { var x; }`,
    //    `for (const x in {}) { var x; }`)。仅 let/const 头触发(var 头重复/遮蔽合法)。
    checkForHeadDeclaration(init, body) {
        if (!init || init.type !== "VariableDeclaration") return;
        if (init.kind !== "let" && init.kind !== "const") return;
        // 数组收集(保留重复):Object.keys 会折叠同 key,检测不到单模式内重名
        // `for (let [x, x] in {})`。
        const pn = [];
        const collect = (node) => {
            if (!node) return;
            if (node.type === "Identifier") { pn.push(node.name); return; }
            if (node.type === "ObjectPattern") {
                for (const pr of (node.properties || [])) {
                    if (pr.type === "SpreadElement" || pr.type === "RestElement") collect(pr.argument);
                    else if (pr.value) collect(pr.value);
                    else if (pr.key) collect(pr.key);
                }
                return;
            }
            if (node.type === "ArrayPattern") {
                for (const el of (node.elements || [])) if (el) collect(el);
                return;
            }
            if (node.type === "AssignmentPattern") { collect(node.left); return; }
            if (node.type === "RestElement" || node.type === "SpreadElement") collect(node.argument);
        };
        for (const d of init.declarations) collect(d.id);
        const seen = Object.create(null);
        for (const n of pn) {
            if (seen[n]) {
                this.errors.push("Duplicate binding name '" + n + "' in for-of/in head");
                return;
            }
            seen[n] = 1;
        }
        if (!body) return;
        const bv = {};
        collectVarDeclarations(body, bv);
        for (const n of pn) {
            if (Object.prototype.hasOwnProperty.call(bv, n)) {
                this.errors.push("Var declaration '" + n + "' conflicts with for-of/in head lexical binding");
                return;
            }
        }
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
        // [test262 S1] 进入生成器/异步深度:覆盖形参 + 体内 var 的 yield/await 早期错误校验
        if (isGenerator) this.fnGenDepth++;
        if (isAsync) this.fnAsyncDepth++;
        // 紧邻包围函数生成器/异步标志:yield/await 仅在紧邻函数是 generator/async 时是关键词
        const prevImmediateGen = this._immediateGen;
        const prevImmediateAsync = this._immediateAsync;
        this._immediateGen = isGenerator;
        this._immediateAsync = isAsync;
        // [Wave 8] 函数边界:字段初始化器上下文在函数声明内复位,返回前须恢复。
        // [L2-④] _inFormalParams 同理:嵌套函数内 await/yield 合法,边界复位。
        const prevInFieldInit = this._inFieldInit;
        const prevInFormal = this._inFormalParams;
        this._inFieldInit = false;
        this._inFormalParams = false;
        // [test262 S1] 函数体开始:供 new.target 上下文校验
        this.fnDepth++;
        let params = this.parseFunctionParams();
        if (!this.expectPeek(TokenType.LBRACE)) {
            this.fnDepth--;
            if (isGenerator) this.fnGenDepth--;
            if (isAsync) this.fnAsyncDepth--;
            this._immediateGen = prevImmediateGen;
            this._immediateAsync = prevImmediateAsync;
            this._inFieldInit = prevInFieldInit;
            this._inFormalParams = prevInFormal;
            return null;
        }
        // [test262 S1] strict 探测:"use strict" 指令 → strict 深度 + 回溯形参校验
        let isStrict = this.peekUseStrictDirective();
        if (isStrict) { this.fnStrictDepth++; this.checkStrictParams(params); }
        this.checkInheritedStrictParams(params, isStrict);   // [test262 早期错误 C] 继承 strict 重参
        // [test262 标签重复] 标签按函数作用域隔离:保存外层集、入体前换新集
        const prevLabels = this._usedLabels;
        this._usedLabels = new Set();
        const prevLabelStack = this._labelStack;
        this._labelStack = [];
        let body = this.parseBlockStatement();
        this.checkFormalLexicalConflict(params, body);
        this.checkLexVarConflict(body && body.body);
        this._usedLabels = prevLabels;
        this._labelStack = prevLabelStack;
        if (isStrict) this.fnStrictDepth--;
        if (isGenerator) this.fnGenDepth--;
        if (isAsync) this.fnAsyncDepth--;
        this.fnDepth--;
        this._immediateGen = prevImmediateGen;
        this._immediateAsync = prevImmediateAsync;
        this._inFieldInit = prevInFieldInit;
        this._inFormalParams = prevInFormal;
        return new AST.FunctionDeclaration(id, params, body, isAsync, isGenerator);
    },

    // [test262 S1] yield/await 作绑定标识符(形参/var 名)在生成器/异步函数内是早期错误
    // (作 yield/await 表达式合法,故只在绑定名校验);strict 下 eval/arguments 不可作绑定名。
    checkYieldAwaitBinding(name) {
        if (name === "yield" && this._immediateGen) {
            this.errors.push("Cannot use 'yield' as a binding name inside a generator");
        }
        // [static-block-await] 静态初始化块直属语句是模块上下文,await 是保留字;
        // ContainsAwait 不下钻函数边界,故只拒 fnDepth===staticBlockDepth 的直属绑定
        // (`var await` / `let await`)。嵌套函数的名字/形参(`(function await(await){})`)合法。
        if (name === "await" && (this._immediateAsync ||
            (this._staticBlockDepth && !this._immediateGen && this.fnDepth === this._staticBlockDepth))) {
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
    // [no LineTerminator here] `async` 与 `function` 之间不得换行,否则 `async`
    // 是标识符、后面的 function 是独立声明(`async\nfunction foo(){}`)。
    isAsyncFunctionHead() {
        return this.curTokenIs(TokenType.ASYNC) && !this.curToken.escaped &&
            this.peekTokenIs(TokenType.FUNCTION) &&
            !this.peekToken.lineBreakBefore &&
            this.peekToken.line === this.curToken.line;
    },

    // LexicallyDeclaredNames(不进嵌套函数/类体):let/const/class;strict 下含
    // FunctionDeclaration。供形参冲突与 lex∩var 早期错误。
    _collectLexicalNames(node, out) {
        if (!node || typeof node !== "object") return;
        const t = node.type;
        if (t === "VariableDeclaration") {
            if (node.kind === "let" || node.kind === "const") {
                const decls = node.declarations || [];
                for (let i = 0; i < decls.length; i++) {
                    if (decls[i].id) collectPatternNames(decls[i].id, out);
                }
            }
            return;
        }
        if (t === "ClassDeclaration") {
            if (node.id && node.id.type === "Identifier" && node.id.name) out[node.id.name] = true;
            return;
        }
        if (t === "FunctionDeclaration") {
            if (this.inStrictMode() && node.id && node.id.type === "Identifier" && node.id.name) {
                out[node.id.name] = true;
            }
            return;
        }
        if (t === "FunctionExpression" || t === "ArrowFunctionExpression" || t === "ClassExpression") {
            return;
        }
        if (t === "BlockStatement") {
            const body = node.body || [];
            for (let i = 0; i < body.length; i++) this._collectLexicalNames(body[i], out);
            return;
        }
        if (t === "IfStatement") {
            this._collectLexicalNames(node.consequent, out);
            this._collectLexicalNames(node.alternate, out);
            return;
        }
        if (t === "WhileStatement" || t === "DoWhileStatement" || t === "LabeledStatement" ||
            t === "WithStatement") {
            this._collectLexicalNames(node.body, out);
            return;
        }
        if (t === "ForStatement") {
            this._collectLexicalNames(node.init, out);
            this._collectLexicalNames(node.body, out);
            return;
        }
        if (t === "ForInStatement" || t === "ForOfStatement") {
            this._collectLexicalNames(node.left, out);
            this._collectLexicalNames(node.body, out);
            return;
        }
        if (t === "TryStatement") {
            this._collectLexicalNames(node.block, out);
            if (node.handler) this._collectLexicalNames(node.handler.body, out);
            this._collectLexicalNames(node.finalizer, out);
            return;
        }
        if (t === "SwitchStatement") {
            const cases = node.cases || [];
            for (let i = 0; i < cases.length; i++) {
                const cons = cases[i].consequent || [];
                for (let j = 0; j < cons.length; j++) this._collectLexicalNames(cons[j], out);
            }
            return;
        }
        if (t === "ExportDeclaration" || t === "ExportNamedDeclaration" || t === "ExportDefaultDeclaration") {
            this._collectLexicalNames(node.declaration, out);
        }
    },

    // StatementList 的 LexicallyDeclaredNames ∩ VarDeclaredNames。
    checkLexVarConflict(stmts) {
        if (!stmts) return;
        const lex = Object.create(null);
        const vars = Object.create(null);
        for (let i = 0; i < stmts.length; i++) {
            this._collectLexicalNames(stmts[i], lex);
            collectVarDeclarations(stmts[i], vars);
        }
        for (const n in lex) {
            if (vars[n] === true) {
                this.errors.push("Identifier '" + n + "' has already been declared");
                return;
            }
        }
    },

    // FormalParameters BoundNames ∩ FunctionBody LexicallyDeclaredNames。
    checkFormalLexicalConflict(params, body) {
        if (!params || !body) return;
        const plist = [];
        for (let i = 0; i < params.length; i++) this.collectParamNames(params[i], plist);
        if (plist.length === 0) return;
        const pnames = Object.create(null);
        for (let i = 0; i < plist.length; i++) pnames[plist[i]] = true;
        const lex = Object.create(null);
        if (body.type === "BlockStatement") {
            const stmts = body.body || [];
            for (let i = 0; i < stmts.length; i++) this._collectLexicalNames(stmts[i], lex);
        }
        for (const n in lex) {
            if (pnames[n] === true) {
                this.errors.push("Identifier '" + n + "' has already been declared");
                return;
            }
        }
    },

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
        const seen = Object.create(null);
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
        // [test262 S1] 非简单形参表(含默认值/解构/rest)中遇重名 → SyntaxError(无论 strict)。
        // 规范: FormalParameters 当 IsSimpleParameterList 为 false 时,BoundNames 不得含重复项。
        // 只在 strict 态的 checkInheritedStrictParams 已覆盖简单形参表 strict 重名,此处补 non-simple。
        (() => {
            let simple = true;
            for (const p of params) {
                if (!p) continue;
                if (p.type !== "Identifier") { simple = false; break; }
            }
            if (simple) return;
            const names = [];
            for (const p of params) this.collectParamNames(p, names);
            const seen = Object.create(null);
            for (const n of names) {
                if (seen[n]) this.errors.push("Duplicate parameter name '" + n + "' not allowed in function with default parameter values");
                seen[n] = true;
            }
        })();
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
        // [test262 S12.9_A1_T3/T8] return 仅在函数体内合法(fnDepth>0;顶层/eval 片段
        // fnDepth=0 → 早期错误)。此前不查 → `return 1;` 顶层被静默编译。
        if (!this.fnDepth) {
            this.errors.push("Illegal return statement");
        }
        let stmt = new AST.ReturnStatement(null);
        // 裸 return(无实参):peek 为 } / ; / EOF 时不得越过 return——否则会把块的
        // 收尾 } 当成 return 自身的末 token 吞掉,吃掉其后一条语句(bare-return swallow)。
        // return 与 Identifier_opt 之间有 LineTerminator → ASI,无实参(S12.9_A2)。
        if (!this.peekTokenIs(TokenType.SEMICOLON) && !this.peekTokenIs(TokenType.RBRACE) &&
            !this.peekTokenIs(TokenType.EOF) &&
            !this.peekToken.lineBreakBefore && this.peekToken.line === this.curToken.line) {
            this.nextToken();
            stmt.argument = this.parseExpression(Precedence.LOWEST);
        }
        if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
        return stmt;
    },

    // [test262 早期错误] 检查单语句位置不允许的词法/函数声明。
    // isIfBody: 仅在 if 语句体中 sloppy 普通函数声明按 Annex B 放行;其他位置一律拒。
    checkStatementBody(stmt, isIfBody = false) {
        if (!stmt) return;
        if (stmt.type === "VariableDeclaration") {
            if (stmt.kind === "let" || stmt.kind === "const") {
                this.errors.push("Lexical declaration cannot be used in a single-statement context");
            }
        } else if (stmt.type === "FunctionDeclaration") {
            if (this.inStrictMode()) {
                this.errors.push("Function declaration cannot be used in a single-statement context (strict mode)");
            } else if (stmt.isAsync || stmt.isGenerator) {
                this.errors.push("Async function or generator declaration cannot be used in a single-statement context");
            } else if (!isIfBody) {
                // Annex B: sloppy regular function decls only allowed as if-statement body or top-level/block
                this.errors.push("Function declaration cannot be used in a single-statement context");
            }
        } else if (stmt.type === "ClassDeclaration") {
            // [decl-cls] `for (x in y) class C {}` / `if (a) class C {}`:类声明不在
            // Statement 文法内,单语句位恒非法(此前静默放行 → negative parse 判负)。
            this.errors.push("Class declaration cannot be used in a single-statement context");
        }
    },

    parseIfStatement() {
        if (!this.expectPeek(TokenType.LPAREN)) return null;
        this.nextToken();
        let test = this.parseExpression(Precedence.LOWEST);
        if (!this.expectPeek(TokenType.RPAREN)) return null;
        this.nextToken();
        let consequent = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
        this.checkStatementBody(consequent, true);   // [test262 早期错误] if-body Annex B 放行 sloppy 普通函数
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
                this.checkStatementBody(alternate, true);   // [test262 早期错误] else-body 同 if-body
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
        // [test262 parser-edge] `for (let in {}) {}` (sloppy): let 后即 in → let 是表达式
        // 标识符而非声明关键词。LET token 无表达式前缀处理函数,故在此直接分派:
        // 手动构造 Identifier,消费 in,解析右侧表达式,返回 ForInStatement。
        if (this.curTokenIs(TokenType.LET) || this.curTokenIs(TokenType.CONST) || this.curTokenIs(TokenType.VAR)) {
            if (this.curTokenIs(TokenType.LET) && this.peekTokenIs(TokenType.IN)) {
                init = new AST.Identifier("let");
                this.nextToken(); // 越过 let, cur = IN
                this.nextToken(); // 越过 in, cur = 右侧表达式首 token
                let right = this.parseExpression(Precedence.LOWEST);
                if (!this.expectPeek(TokenType.RPAREN)) return null;
                this.nextToken();
                this.loopDepth++;
                this._markBreakableLabels();
                let body = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
                this.checkStatementBody(body);   // [test262 早期错误] for-body 单语句位
                this.loopDepth--;
                return new AST.ForInStatement(init, right, body);
            }
            init = this.parseVariableDeclaration();
            if (this.peekTokenIs(TokenType.IN)) {
                this.nextToken();
                this.nextToken();
                let right = this.parseExpression(Precedence.LOWEST);
                if (!this.expectPeek(TokenType.RPAREN)) return null;
                this.nextToken();
                this.loopDepth++;
                this._markBreakableLabels();
                let body = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
                this.checkStatementBody(body);   // [test262 早期错误] for-body 单语句位
                this.checkForHeadDeclaration(init, body); // [test262] 头部词法绑定重名/与 body var 冲突
                this.loopDepth--;
                return new AST.ForInStatement(init, right, body);
            }
            if (this.peekTokenIs(TokenType.OF)) {
                // [escaped-of] `for (x \u006ff y)`:of 关键词不得以转义书写。
                if (this.peekToken.escaped) {
                    this.errors.push("Keyword must not contain escaped characters");
                }
                // [test262 早期错误] for-of 的 ForBinding 不得带初值(`for (var [x] = 1 of [])`
                // SyntaxError);for-await-of 同拒(此前只查 isAwait,漏普通 for-of)。
                if (init && init.type === "VariableDeclaration") {
                    for (const d of init.declarations) {
                        if (d.init) {
                            this.errors.push("Initializer is not allowed in for-of head's ForBinding position");
                            break;
                        }
                    }
                }
                this.nextToken();
                this.nextToken();
                // [test262 head-var-no-expr] for-of 右侧是 AssignmentExpression:顶层逗号
                // 序列非法(`for (var x of [], [])`)。COMMA 优先级停逗号 → expectPeek 报错;
                // `(a, b)` 有 _parenthesized 标志不受影响。
                let right = this.parseExpression(Precedence.COMMA);
                if (!this.expectPeek(TokenType.RPAREN)) return null;
                this.nextToken();
                this.loopDepth++;
                this._markBreakableLabels();
                let body = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
                this.checkStatementBody(body);   // [test262 早期错误] for-body 单语句位
                this.checkForHeadDeclaration(init, body); // [test262] 头部词法绑定重名/与 body var 冲突
                this.loopDepth--;
                return new AST.ForOfStatement(init, right, body, isAwait);
            }
        } else if (!this.curTokenIs(TokenType.SEMICOLON)) {
            init = this.parseExpression(Precedence.LOWEST);
            // [test262 conditional/in-condition] for-init 是 Expression[~In]:
            // 除 for-in 头形态(顶层 BinaryExpression('in') 且后随 `)`)外,头部含
            // `in`(如三元条件内 `'' in {} ? 0 : 0`)是早期错误。AST 后验避免在
            // 解析期误伤 for-in 的 `in`(head-lhs-let 族)。
            {
                const topIn = init && init.type === "BinaryExpression" && init.operator === "in" &&
                    this.peekTokenIs(TokenType.RPAREN);
                if (!topIn) {
                    // [~In] 只沿**顶层表达式链**传播:进括号、方括号(计算键/下标)、实参、
                    // 数组/对象字面量、模板替换、函数/类体、三元的两个分支后,语法参数按
                    // 规范复位为 [+In](CoverParenthesizedExpression / ComputedPropertyName /
                    // ArgumentList …)。此前是无差别全树搜索,把 `class { get ['x' in o](){} }`
                    // 这类合法写法误判为早期错误(整份源码 COMPILE_FAIL)。
                    const findIn = (node) => {
                        if (!node || typeof node !== "object") return false;
                        if (node._parenthesized) return false; // ( Expression[+In] )
                        const t = node.type;
                        if (t === "BinaryExpression") {
                            if (node.operator === "in") return true;
                            return findIn(node.left) || findIn(node.right);
                        }
                        if (t === "LogicalExpression") return findIn(node.left) || findIn(node.right);
                        if (t === "SequenceExpression") {
                            const xs = node.expressions || [];
                            for (let k = 0; k < xs.length; k++) if (findIn(xs[k])) return true;
                            return false;
                        }
                        if (t === "AssignmentExpression") return findIn(node.left) || findIn(node.right);
                        if (t === "ConditionalExpression") return findIn(node.test); // 分支为 [+In]
                        if (t === "UnaryExpression" || t === "UpdateExpression" ||
                            t === "AwaitExpression" || t === "YieldExpression" ||
                            t === "SpreadElement") return findIn(node.argument);
                        if (t === "MemberExpression" || t === "OptionalMemberExpression") {
                            // 下标/计算键内为 [+In];静态属性名不含表达式
                            return findIn(node.object);
                        }
                        if (t === "CallExpression" || t === "NewExpression" ||
                            t === "OptionalCallExpression") return findIn(node.callee); // 实参 [+In]
                        if (t === "TaggedTemplateExpression") return findIn(node.tag);
                        return false; // 字面量/函数/类/数组/对象/模板等:内部一律 [+In]
                    };
                    if (findIn(init)) {
                        this.errors.push("'in' is not allowed in for-loop initialization");
                    }
                }
            }
            // [test262 S1] 非声明式 for-of/in 左值:for (a of x) / for ([a,b] of x) / for (a in x) /
            // for ([a,b] in obj)。左值为表达式(标识符/成员/数组-对象表达式);数组-对象表达式由
            // 编译器 reinterpretAsPattern 重解释为赋值形 pattern。修 ~90 个 "expected ;, got OF" COMPILE_FAIL。
            if (this.peekTokenIs(TokenType.OF)) {
                // [escaped-of] `for (x \u006ff y)`:of 关键词不得以转义书写。
                if (this.peekToken.escaped) {
                    this.errors.push("Keyword must not contain escaped characters");
                }
                // [test262 S1] 头部左值内层目标位校验(只拒逗号序列):`for ([(x, y)] of []) {}`。
                this.checkPatternTargets(init);
                // for-of:of 非运算符,parseExpression 在其前已停。
                this.nextToken();
                this.nextToken();
                let right = this.parseExpression(Precedence.COMMA); // [test262 head-var-no-expr] 顶层逗号非法
                if (!this.expectPeek(TokenType.RPAREN)) return null;
                this.nextToken();
                this.loopDepth++;
                this._markBreakableLabels();
                let body = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
                this.checkStatementBody(body);   // [test262 早期错误] for-body 单语句位
                this.loopDepth--;
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
                this.loopDepth++;
                this._markBreakableLabels();
                let body = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
                this.checkStatementBody(body);   // [test262 早期错误] for-body 单语句位
                this.loopDepth--;
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
        } else if (this.peekTokenIs(TokenType.RPAREN)) {
            this.nextToken();
        }
        this.nextToken();
        this.loopDepth++;
                this._markBreakableLabels();
        let body = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
        this.checkStatementBody(body);   // [test262 早期错误] while/do-body 单语句位
        this.loopDepth--;
        return new AST.ForStatement(init, test, update, body);
    },

    parseWhileStatement() {
        if (!this.expectPeek(TokenType.LPAREN)) return null;
        this.nextToken();
        let test = this.parseExpression(Precedence.LOWEST);
        if (!this.expectPeek(TokenType.RPAREN)) return null;
        this.nextToken();
        this.loopDepth++;
                this._markBreakableLabels();
        let body = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
        this.checkStatementBody(body);   // [test262 早期错误] while/do-body 单语句位
        this.loopDepth--;
        return new AST.WhileStatement(test, body);
    },

    parseWithStatement() {
        // `with` 是保留字,词法当 IDENT;语句首 `with (` 唯一解为 with 语句(非调用)。
        // [test262 早期错误] strict 模式下 with 语句是 SyntaxError。
        if (this.inStrictMode()) {
            this.errors.push("'with' statement is not allowed in strict mode");
        }
        if (!this.expectPeek(TokenType.LPAREN)) return null;
        this.nextToken();
        let object = this.parseExpression(Precedence.LOWEST);
        if (!this.expectPeek(TokenType.RPAREN)) return null;
        this.nextToken();
        let body = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
        this.checkStatementBody(body);   // [test262 早期错误] with-body 单语句位
        return new AST.WithStatement(object, body);
    },

    parseDoWhileStatement() {
        this.nextToken();
        this.loopDepth++;
                this._markBreakableLabels();
        // [test262] 体为表达式语句时,同行 `while` 是文法豁免(parseExpressionStatement
        // 的终结符校验据此放行)。
        this._allowWhileTerm = true;
        let body = this.curTokenIs(TokenType.LBRACE) ? this.parseBlockStatement() : this.parseStatement();
        this._allowWhileTerm = false;
        this.checkStatementBody(body);   // [test262 早期错误] while/do-body 单语句位
        this.loopDepth--;
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
        this.switchDepth++;
        this._markBreakableLabels();
        let cases = [];
        this.nextToken();
        let sawDefault = false;
        while (!this.curTokenIs(TokenType.RBRACE) && !this.curTokenIs(TokenType.EOF)) {
            let test = null;
            if (this.curTokenIs(TokenType.CASE)) {
                this.nextToken();
                test = this.parseExpression(Precedence.LOWEST);
            } else if (this.curTokenIs(TokenType.DEFAULT)) {
                if (sawDefault) this.errors.push("More than one default clause in switch statement");
                sawDefault = true;
            } else {
                this.errors.push("Unexpected token in switch statement");
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
        this.switchDepth--;
        return new AST.SwitchStatement(discriminant, cases);
    },

    parseBreakStatement() {
        let label = null;
        if (this.peekTokenIs(TokenType.IDENT)) {
            this.nextToken();
            label = new AST.Identifier(this.curToken.literal);
            // [break-label] break L 的 L 必须标注外层迭代/switch(ES 13.8.1):普通语句
            // 标签(`LABEL: x=3.14; break LABEL;`)是 SyntaxError。查栈上同名词法最近条目。
            let found = false;
            if (this._labelStack) {
                for (let li = this._labelStack.length - 1; li >= 0; li--) {
                    if (this._labelStack[li].name === label.name) {
                        if (this._labelStack[li].breakable) found = true;
                        break;
                    }
                }
            }
            if (!found) {
                this.errors.push("Illegal break statement");
            }
        } else {
            // [test262 early error] break (unlabelled) must be inside a loop or switch.
            if (this.loopDepth === 0 && this.switchDepth === 0) {
                this.errors.push("Illegal break statement");
            }
        }
        if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
        return new AST.BreakStatement(label);
    },

    parseContinueStatement() {
        let label = null;
        if (this.peekTokenIs(TokenType.IDENT)) {
            this.nextToken();
            label = new AST.Identifier(this.curToken.literal);
            // [test262 早期错误] 带标签的 continue 也必须在循环内部;
            // 标签必须引用外层 IterationStatement(switch 不可)。
            if (this.loopDepth === 0) {
                this.errors.push("Illegal continue statement");
            }
        } else {
            // [test262 早期错误] continue(无标签)必须在循环内部(switch 内不可)。
            if (this.loopDepth === 0) {
                this.errors.push("Illegal continue statement");
            }
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
                // [test262 early-catch-duplicates] catch pattern 的 BoundNames 不得重复
                // (`catch ([x, x])`)。数组收集保留重复(与 for-head 同口径)。
                if (param && (param.type === "ObjectPattern" || param.type === "ArrayPattern")) {
                    const cpn = [];
                    const ccollect = (node) => {
                        if (!node) return;
                        if (node.type === "Identifier") { cpn.push(node.name); return; }
                        if (node.type === "ObjectPattern") {
                            for (const pr of (node.properties || [])) {
                                if (pr.type === "SpreadElement" || pr.type === "RestElement") ccollect(pr.argument);
                                else if (pr.value) ccollect(pr.value);
                                else if (pr.key) ccollect(pr.key);
                            }
                            return;
                        }
                        if (node.type === "ArrayPattern") {
                            for (const el of (node.elements || [])) if (el) ccollect(el);
                            return;
                        }
                        if (node.type === "AssignmentPattern") { ccollect(node.left); return; }
                        if (node.type === "RestElement" || node.type === "SpreadElement") ccollect(node.argument);
                    };
                    ccollect(param);
                    const cseen = Object.create(null);
                    for (const n of cpn) {
                        if (cseen[n]) { this.errors.push("Duplicate binding name '" + n + "' in catch parameter"); break; }
                        cseen[n] = 1;
                    }
                }
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
        // [test262 cover-initialized-name] CoverInitializedName(`{a = 1}`)仅在解构
        // 目标位合法:表达式位(裸对象/实参等)是早期错误。AssignmentExpression 的
        // LHS 是目标位(跳过);其余位置出现 _coverInit 属性即报。
        // 绝大多数表达式语句无 CoverInitializedName:由对象字面量解析置
        // _seenCoverInit,未置则跳过整树扫描(gen1 上每条表达式语句的 for-in 很贵)。
        this._seenCoverInit = false;
        let expr = this.parseExpression(Precedence.LOWEST);
        if (this._seenCoverInit) {
            const hasCover = (node) => {
                if (!node || typeof node !== "object") return false;
                if (Array.isArray(node)) {
                    for (let k = 0; k < node.length; k++) if (hasCover(node[k])) return true;
                    return false;
                }
                const t = node.type;
                // 嵌套函数/类有各自的表达式语句检查,不得把体内 for-of 解构
                // (`iter = (function*(){ for ({ x = yield } of …) })()`)误判成
                // 外层赋值表达式位的 CoverInitializedName。
                if (t === "FunctionExpression" || t === "FunctionDeclaration" ||
                    t === "ArrowFunctionExpression" || t === "ClassExpression" ||
                    t === "ClassDeclaration") return false;
                // 叶子:无对象字面量
                if (t === "Identifier" || t === "Literal" || t === "ThisExpression" ||
                    t === "Super" || t === "PrivateIdentifier" || t === "MetaProperty" ||
                    t === "EmptyStatement") return false;
                // 解构目标位:赋值左、for-of/in 左、声明绑定。只扫表达式位。
                if (t === "AssignmentExpression") return hasCover(node.right);
                if (t === "ForOfStatement" || t === "ForInStatement") {
                    return hasCover(node.right) || hasCover(node.body);
                }
                if (t === "VariableDeclarator") return hasCover(node.init);
                if (t === "ObjectExpression") {
                    const prs = node.properties || [];
                    for (let k = 0; k < prs.length; k++) {
                        if (prs[k] && prs[k]._coverInit) return true;
                        if (prs[k] && hasCover(prs[k].value)) return true;
                    }
                    return false;
                }
                // 类型化下钻(避免 Identifier 上的 for-in)
                if (t === "MemberExpression") {
                    return hasCover(node.object) || (node.computed && hasCover(node.property));
                }
                if (t === "CallExpression" || t === "NewExpression") {
                    if (hasCover(node.callee)) return true;
                    const args = node.arguments;
                    if (args) for (let i = 0; i < args.length; i++) if (hasCover(args[i])) return true;
                    return false;
                }
                if (t === "BinaryExpression" || t === "LogicalExpression") {
                    return hasCover(node.left) || hasCover(node.right);
                }
                if (t === "UnaryExpression" || t === "UpdateExpression" ||
                    t === "AwaitExpression" || t === "YieldExpression" ||
                    t === "ThrowStatement" || t === "ReturnStatement") {
                    return hasCover(node.argument);
                }
                if (t === "ConditionalExpression") {
                    return hasCover(node.test) || hasCover(node.consequent) || hasCover(node.alternate);
                }
                if (t === "SequenceExpression" || t === "TemplateLiteral") {
                    const xs = node.expressions;
                    if (xs) for (let i = 0; i < xs.length; i++) if (hasCover(xs[i])) return true;
                    return false;
                }
                if (t === "ArrayExpression") {
                    const els = node.elements;
                    if (els) for (let i = 0; i < els.length; i++) if (hasCover(els[i])) return true;
                    return false;
                }
                if (t === "Property" || t === "PropertyDefinition") {
                    return hasCover(node.value);
                }
                if (t === "BlockStatement" || t === "Program") {
                    const body = node.body;
                    if (body) for (let i = 0; i < body.length; i++) if (hasCover(body[i])) return true;
                    return false;
                }
                if (t === "ExpressionStatement") return hasCover(node.expression);
                for (const key in node) {
                    if (key === "type" || key === "loc" || key === "range" ||
                        key === "start" || key === "end") continue;
                    if (key.length > 0 && key.charCodeAt(0) === 95) continue;
                    if (hasCover(node[key])) return true;
                }
                return false;
            };
            if (hasCover(expr)) {
                this.errors.push("Invalid shorthand property initializer outside destructuring");
            }
        }
        if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
        else {
            // [test262 let-newline-await-in-normal-function] 表达式语句必须由
            // ;/}/EOF/换行(ASI)终结;do-while 体的同行 `while` 为文法豁免。此前
            // 不查 → `x 0;` / `let\nawait 0` 被静默接受(await 落标识符引用)。
            const lineBreak = this.peekToken.line !== this.curToken.line;
            const okWhile = this._allowWhileTerm && this.peekTokenIs(TokenType.WHILE);
            if (!lineBreak && !okWhile &&
                !this.peekTokenIs(TokenType.RBRACE) && !this.peekTokenIs(TokenType.EOF) &&
                !this.peekTokenIs(TokenType.TEMPLATE_MIDDLE) && !this.peekTokenIs(TokenType.TEMPLATE_TAIL)) {
                this.errors.push("Unexpected token after expression statement at line " + this.curToken.line + ":" + this.curToken.column + " lit=" + JSON.stringify(this.peekToken.literal));
            }
        }
        return new AST.ExpressionStatement(expr);
    },
};
