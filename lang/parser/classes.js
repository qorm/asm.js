// asm.js 解析器 - 类解析
// 解析 class 声明、方法、私有字段等

import { TokenType } from "../lexer/token.js";
import * as AST from "./ast.js";
import { Precedence } from "./precedence.js";

// 类解析混入
export const ClassParser = {
    parseClassDeclaration(defaultName) {
        this.nextToken();
        // 匿名 default export:`class {}` / `class extends B {}` 无名,赋合成名。
        // 匿名时当前 token 已是 `extends` 或 `{`(具名时是名字 token)。
        let id;
        let anonymous = false;
        // 匿名 default:当前 token 已是 `extends` 或 `{`(无名字)。须先判此,
        // 因 curTokenIsIdentifier() 会把关键字 `extends` 也当标识符。
        if (defaultName && (this.curTokenIs(TokenType.EXTENDS) || this.curTokenIs(TokenType.LBRACE))) {
            id = new AST.Identifier(defaultName);
            anonymous = true;
        } else if (this.curTokenIsIdentifier()) {
            this.checkReservedBinding(this.curToken.literal);   // [test262 早期错误 A] 类名保留字
            // [L2-④] 类体隐式 strict:类名不可用 strict 保留字(Early Errors 12.1.1)
            // classDepth 此时尚未递增,故在此直查(ES 规范的 strict reserved words)。
            const cn = this.curToken.literal;
            if (cn === "let" || cn === "static" || cn === "yield" ||
                cn === "implements" || cn === "interface" || cn === "package" ||
                cn === "private" || cn === "protected" || cn === "public") {
                this.errors.push("Cannot use reserved word '" + cn + "' as a class name");
            }
            id = new AST.Identifier(cn);
        } else {
            return null;
        }
        let superClass = null;
        if (anonymous) {
            if (this.curTokenIs(TokenType.EXTENDS)) {
                this.nextToken();
                // 父类是 LeftHandSideExpression:标识符 `Base`、成员 `ns.Base`、调用
                // `mixin(Base)`、括号 `(cond?A:B)` 等。CALL-1 优先级吞并成员/调用链但在
                // 类体 `{` 处停(LBRACE 无中缀优先级)。裸标识符仍产出 Identifier 节点,
                // 与旧 `new AST.Identifier` 同形 → 名字快路径与自举字节不变。
                superClass = this.parseExpression(Precedence.CALL - 1);
                if (!this.expectPeek(TokenType.LBRACE)) return null;
            } else if (!this.curTokenIs(TokenType.LBRACE)) {
                return null;
            }
        } else {
            if (this.peekTokenIs(TokenType.EXTENDS)) {
                this.nextToken();
                this.nextToken();
                superClass = this.parseExpression(Precedence.CALL - 1);
            }
            if (!this.expectPeek(TokenType.LBRACE)) return null;
        }
        let body = this.parseClassBody();
        return new AST.ClassDeclaration(id, superClass, body);
    },

    parseClassBody() {
        let body = [];
        this.classDepth = this.classDepth + 1; // #x 访问仅类体内合法
        const depth = this.classDepth;
        // [test262 早期错误 E] 私有名查重栈:嵌套类各有独立 ClassBody 作用域,进体压新表、出体弹出。
        // [W-P9 未绑定私有名] 并行维护「各层私有名表」与「本顶层类子树全部私有名引用」:
        // 每个类体把自己的名表登记到 _privateNamesByDepth[depth];引用按所在层深度记录到
        // _privateRefs。待最外层类体(depth===1)收尾统一校验:depth i 的引用须在 names[1..i]
        // 中(声明顺序无关,Node 对拍 `class C { m(){ class B { n(){ this.#x } } } #x; }` 合法)。
        // 顶层类之间互不干扰:每次 depth===1 进入重置两张表。
        if (depth === 1) {
            this._privateNamesByDepth = {};
            this._privateRefs = [];
        }
        const prevPrivateNames = this._curPrivateNames;
        this._privateNamesByDepth[depth] = [];
        this._curPrivateNames = this._privateNamesByDepth[depth];
        this.nextToken();
        while (!this.curTokenIs(TokenType.RBRACE) && !this.curTokenIs(TokenType.EOF)) {
            // 类体内可选/杂散分号 `class C { ; method(){}; }`:跳过,不当成员解析。
            if (this.curTokenIs(TokenType.SEMICOLON)) {
                this.nextToken();
                continue;
            }
            let member = this.parseClassMember();
            if (member !== null) {
                body.push(member);
            }
            this.nextToken();
        }
        this._checkDuplicatePrivateNames(this._curPrivateNames);
        if (depth === 1) {
            this._validatePrivateRefs();
        }
        this._curPrivateNames = prevPrivateNames;
        this.classDepth = this.classDepth - 1;
        return body;
    },

    // [W-P9] 记录一条私有名引用(所在类体深度),供最外层类体收尾统一校验。
    _recordPrivateRef(name) {
        if (this.classDepth > 0) {
            if (!this._privateRefs) this._privateRefs = [];
            this._privateRefs.push({ name: name, depth: this.classDepth, line: this.curToken.line });
        }
    },

    // [W-P9] 未绑定私有名早期错误:depth i 处引用的私有名必须在本层或任一外层声明
    // (声明顺序无关)。Node 对拍:`class C { m(){ this.#x } }` 拒;`class A { #x; m(){
    // class B { n(){ this.#x } } } }` 收。零误拒:仅在确定无任何外层声明时记错。
    _validatePrivateRefs() {
        const refs = this._privateRefs || [];
        for (let i = 0; i < refs.length; i++) {
            const ref = refs[i];
            let found = false;
            for (let d = 1; d <= ref.depth; d++) {
                const names = this._privateNamesByDepth[d];
                if (names) {
                    for (let j = 0; j < names.length; j++) {
                        if (names[j].name === ref.name) { found = true; break; }
                    }
                }
                if (found) break;
            }
            if (!found) {
                this.errors.push(
                    `Private field '${ref.name}' must be declared in an enclosing class (line ${ref.line})`
                );
            }
        }
    },

    // [test262 早期错误 E] 同一 ClassBody 内私有名不得重复绑定,唯一例外是同名 get+set 各一。
    // 跳过非法/已单独报错的名("#" 空白分隔、"#constructor")。private name 恒带 '#' 前缀,
    // 不会与 Object.prototype 继承键碰撞,可直接以对象作映射(同 checkStrictParams 模式)。
    _checkDuplicatePrivateNames(entries) {
        const map = {};
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (!e.name || e.name === "#" || e.name === "#constructor") continue;
            let rec = map[e.name];
            if (!rec) { rec = { get: 0, set: 0, other: 0 }; map[e.name] = rec; }
            if (e.category === "get") rec.get = rec.get + 1;
            else if (e.category === "set") rec.set = rec.set + 1;
            else rec.other = rec.other + 1;
        }
        const keys = Object.keys(map);
        for (let i = 0; i < keys.length; i++) {
            const rec = map[keys[i]];
            const total = rec.get + rec.set + rec.other;
            if (rec.get > 1 || rec.set > 1 || (rec.other > 0 && total > 1)) {
                this.errors.push("Duplicate private name '" + keys[i] + "'");
            }
        }
    },

    parseClassMember() {
        let isStatic = false;
        let isPrivate = false;

        // 检查 static 修饰符
        if (this.curTokenIs(TokenType.STATIC)) {
            isStatic = true;
            this.nextToken();
            // [ES2022] 静态初始化块 static { ... }:static 后紧跟 `{`(非方法名/字段)。
            if (this.curTokenIs(TokenType.LBRACE)) {
                const block = this.parseBlockStatement();
                return new AST.StaticBlock(block ? block.body : []);
            }
        }

        // 检查私有字段 (#name)
        if (this.curTokenIs(TokenType.HASH) || (this.curToken.literal && this.curToken.literal.startsWith("#"))) {
            return this.parsePrivateFieldOrMethod(isStatic);
        }

        // 检查 getter/setter
        let kind = "method";
        if (this.curTokenIs(TokenType.GET)) {
            // 检查是否真的是 getter (后面跟着标识符/私有名/计算键 `[` 和括号)
            if (this.peekTokenIs(TokenType.IDENT) || this.peekTokenIs(TokenType.HASH) || this.peekTokenIs(TokenType.LBRACKET)) {
                kind = "get";
                this.nextToken();
            }
        } else if (this.curTokenIs(TokenType.SET)) {
            if (this.peekTokenIs(TokenType.IDENT) || this.peekTokenIs(TokenType.HASH) || this.peekTokenIs(TokenType.LBRACKET)) {
                kind = "set";
                this.nextToken();
            }
        }

        // async 方法修饰符:`async m(){}` / `async *m(){}`。仅当 async 后跟方法名(非
        // `(`/`=`/`;`/`}` — 那些是名为 "async" 的方法/字段)时才当修饰符,消费 async。
        let isAsyncMethod = false;
        if (this.curTokenIs(TokenType.ASYNC) &&
            !this.peekTokenIs(TokenType.LPAREN) && !this.peekTokenIs(TokenType.ASSIGN) &&
            !this.peekTokenIs(TokenType.SEMICOLON) && !this.peekTokenIs(TokenType.RBRACE)) {
            isAsyncMethod = true;
            this.nextToken();
        }

        // 检查是否是私有成员
        if (this.curTokenIs(TokenType.HASH) || (this.curToken.literal && this.curToken.literal.startsWith("#"))) {
            // [W-P9] 私有 async 方法 `async #m(){}`:把 async 修饰符传下去。
            return this.parsePrivateFieldOrMethod(isStatic, kind, false, isAsyncMethod);
        }

        // [test262 早期错误 F] 记录方法是否以访问器(get/set)声明:下面的 constructor 判定会
        // 把 kind 覆写成 "constructor",丢失访问器信息;SpecialMethod 校验需要它。
        const isAccessorMethod = (kind === "get" || kind === "set");
        // 检查 constructor
        if (this.curToken.literal === "constructor") {
            kind = "constructor";
        }

        // 检查是否是字段 (没有括号)
        if (this.peekTokenIs(TokenType.ASSIGN) || this.peekTokenIs(TokenType.SEMICOLON) || this.peekTokenIs(TokenType.RBRACE)) {
            return this.parseClassField(isStatic, false);
        }

        // 普通方法
        let isGenerator = false;
        if (this.curTokenIs(TokenType.ASTERISK)) {
            isGenerator = true;
            this.nextToken();
        }

        // [W-P9 解析缺口修复] 私有生成器/异步生成器方法 `*#m(){}` / `async *#m(){}`:
        // 此前 `*` 先行消费、私有名被当公共方法名解析,`#m` 从不进 _curPrivateNames,
        // 导致后续未绑定私有名检查对这类声明误拒。此处补路由到 parsePrivateFieldOrMethod。
        if (this.curTokenIs(TokenType.HASH) || (this.curToken.literal && this.curToken.literal.startsWith("#"))) {
            return this.parsePrivateFieldOrMethod(isStatic, kind, isGenerator, isAsyncMethod);
        }

        let key = new AST.Identifier(this.curToken.literal);
        let computed = false;

        // 计算属性名 [expr]
        if (this.curTokenIs(TokenType.LBRACKET)) {
            this.nextToken();
            key = this.parseExpression(Precedence.ASSIGN - 1);
            if (!this.expectPeek(TokenType.RBRACKET)) return null;
            computed = true;
        }

        // `(` → 方法;否则字段(含计算键字段 `[k] = v`)。用 peek 判别而非 expectPeek——
        // 后者对字段会记下"expected (, got ="的假语法错误(字段本身仍能解析但整体编译失败)。
        if (!this.peekTokenIs(TokenType.LPAREN)) {
            return this.parseClassField(isStatic, false, key, computed);
        }
        this.nextToken(); // curToken = `(`
        // [test262 S1] 类方法生成器/异步深度:覆盖形参 + 体内 var 的 yield/await 早期错误校验
        if (isGenerator) this.fnGenDepth++;
        if (isAsyncMethod) this.fnAsyncDepth++;
        // 紧邻包围函数生成器/异步标志:yield/await 仅在紧邻函数是 generator/async 时是关键词
        const prevImmediateGen = this._immediateGen;
        const prevImmediateAsync = this._immediateAsync;
        this._immediateGen = isGenerator;
        this._immediateAsync = isAsyncMethod;
        // [Wave 8] 方法边界:方法有自有 arguments 与 home object(super 合法),复位字段上下文。
        const prevInFieldInit = this._inFieldInit;
        this._inFieldInit = false;
        let params = this.parseFunctionParams();
        // [L2-④] getter 不得有形参,setter 必须恰 1 个非 rest 形参
        if (kind === "get" && params.length > 0) {
            this.errors.push("getter must not have formal parameters");
        }
        if (kind === "set" && params.length !== 1) {
            this.errors.push("setter must have exactly one formal parameter");
        }
        if (!this.expectPeek(TokenType.LBRACE)) {
            if (isGenerator) this.fnGenDepth--;
            if (isAsyncMethod) this.fnAsyncDepth--;
            this._immediateGen = prevImmediateGen;
            this._immediateAsync = prevImmediateAsync;
            this._inFieldInit = prevInFieldInit;
            return null;
        }
        // [test262 S1] strict 探测(显式 "use strict" 指令)
        let isStrict = this.peekUseStrictDirective();
        if (isStrict) { this.fnStrictDepth++; this.checkStrictParams(params); }
        // [test262 早期错误 C] 类体隐式 strict(classDepth>0):方法形参不可重名/eval/arguments,
        // 即使方法体无自有 "use strict" 指令。
        this.checkInheritedStrictParams(params, isStrict);
        let methodBody = this.parseBlockStatement();
        if (isStrict) this.fnStrictDepth--;
        if (isGenerator) this.fnGenDepth--;
        if (isAsyncMethod) this.fnAsyncDepth--;
        this._immediateGen = prevImmediateGen;
        this._immediateAsync = prevImmediateAsync;
        this._inFieldInit = prevInFieldInit;
        let value = new AST.FunctionExpression(null, params, methodBody, isAsyncMethod, isGenerator);
        value.generator = isGenerator;
        value.async = isAsyncMethod;
        // [test262 早期错误 F] SpecialMethod:非 static、名为 "constructor" 的 MethodDefinition
        // 不得是生成器/get/set/async(static constructor 方法是普通方法,合法)。static prototype
        // 方法亦禁。用解析后的属性名判定(生成器的 `*` 在 constructor 探测之后才消费,kind 仍是
        // "method",故不能只看 kind)。计算键无法静态判定,跳过。
        let methodName = this._classPropName(key, computed);
        if (!isStatic && methodName === "constructor" && (isGenerator || isAsyncMethod || isAccessorMethod)) {
            this.errors.push("Class constructor may not be a generator, accessor, or async method");
        }
        if (isStatic && methodName === "prototype") {
            this.errors.push("Classes may not have a static property named 'prototype'");
        }
        return new AST.MethodDefinition(key, value, kind, isStatic, computed);
    },

    // [test262 早期错误 F/E] 解析类成员属性名字符串:Identifier/PrivateIdentifier 取 name,
    // 字符串·数值字面量键取 String(value)(PropName 按值比较,含 'constructor' 字符串键)。
    // 计算键/其它形态返回 null(无法静态判定,调用方跳过校验)。
    _classPropName(key, computed) {
        if (computed || !key) return null;
        if (key.type === "Identifier" || key.type === "PrivateIdentifier") return key.name;
        if (key.type === "Literal") return String(key.value);
        return null;
    },

    parseClassField(isStatic, isPrivate, existingKey = null, computed = false) {
        let key = existingKey;
        if (!key) {
            let name = this.curToken.literal;
            key = isPrivate ? new AST.PrivateIdentifier(name) : new AST.Identifier(name);
        }

        // [test262 早期错误 F] FieldDefinition 的 PropName 不得为 "constructor"(含字符串键);
        // static 字段不得名为 "prototype"。ALWAYS 文法约束,与 strict 无关。
        let fieldName = this._classPropName(key, computed);
        if (fieldName === "constructor") {
            this.errors.push("Classes may not have a field named 'constructor'");
        }
        if (isStatic && fieldName === "prototype") {
            this.errors.push("Classes may not have a static property named 'prototype'");
        }

        let init = null;
        if (this.peekTokenIs(TokenType.ASSIGN)) {
            this.nextToken();
            this.nextToken();
            // [Wave 8] 字段初始化器上下文:ContainsArguments/ContainsSuperCall 早期错误
            // (穿透箭头、函数边界复位)。嵌套类字段各自置真,互不串扰。
            const prevInFieldInit = this._inFieldInit;
            this._inFieldInit = true;
            init = this.parseExpression(Precedence.ASSIGN - 1);
            this._inFieldInit = prevInFieldInit;
        }
        if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
        return new AST.PropertyDefinition(key, init, computed, isStatic);
    },

    parsePrivateFieldOrMethod(isStatic, kind = "method", isGenerator = false, isAsyncMethod = false) {
        // 获取私有名称。词法上 `#x`(# 紧邻名字)合成单个 IDENT("#x");`# x`(# 与名字间有
        // 空白/换行)则产出裸 HASH token + 独立标识符。ES 要求 # 紧邻 IdentifierName,故见到
        // 裸 HASH 必为早期错误(此前会静默把 `# x` 当两个成员编译)。
        let name;
        if (this.curTokenIs(TokenType.HASH)) {
            this.errors.push("Private name '#' must be immediately followed by an identifier (no whitespace)");
            if (this.peekTokenIsIdentifier()) {
                this.nextToken();
                name = "#" + this.curToken.literal;
            } else {
                name = "#";
            }
        } else {
            name = this.curToken.literal;   // 形如 "#x"(词法已合并)
        }
        let key = new AST.PrivateIdentifier(name);

        // [test262 早期错误 F] "#constructor" 不是合法私有名(私有构造器无意义)。
        if (name === "#constructor") {
            this.errors.push("Classes may not have a private field or method named '#constructor'");
        }

        // [test262 早期错误 E] 记录私有名及类别(get/set/其它),供 parseClassBody 收尾查重:
        // 字段与非 get/set 方法归 "other";同名 get+set 各一合法,其余重复皆早期错误。
        if (this._curPrivateNames) {
            let category = (this.peekTokenIs(TokenType.LPAREN) && (kind === "get" || kind === "set")) ? kind : "other";
            this._curPrivateNames.push({ name: name, category: category });
        }

        // 检查是否是方法 (有括号)
        if (this.peekTokenIs(TokenType.LPAREN)) {
            this.nextToken();
            // [Wave 8] 私有方法同属方法边界:复位字段初始化器上下文。
            // [W-P9] 私有生成器/异步方法同样计入 yield/await 深度(与公共方法路径一致)。
            const prevInFieldInit = this._inFieldInit;
            this._inFieldInit = false;
            if (isGenerator) this.fnGenDepth++;
            if (isAsyncMethod) this.fnAsyncDepth++;
            // 紧邻包围函数生成器/异步标志
            const prevImmediateGenP = this._immediateGen;
            const prevImmediateAsyncP = this._immediateAsync;
            this._immediateGen = isGenerator;
            this._immediateAsync = isAsyncMethod;
            let params = this.parseFunctionParams();
            if (!this.expectPeek(TokenType.LBRACE)) {
                if (isGenerator) this.fnGenDepth--;
                if (isAsyncMethod) this.fnAsyncDepth--;
                this._immediateGen = prevImmediateGenP;
                this._immediateAsync = prevImmediateAsyncP;
                this._inFieldInit = prevInFieldInit;
                return null;
            }
            let methodBody = this.parseBlockStatement();
            if (isGenerator) this.fnGenDepth--;
            if (isAsyncMethod) this.fnAsyncDepth--;
            this._immediateGen = prevImmediateGenP;
            this._immediateAsync = prevImmediateAsyncP;
            this._inFieldInit = prevInFieldInit;
            let value = new AST.FunctionExpression(null, params, methodBody, isAsyncMethod, isGenerator);
            value.generator = isGenerator;
            value.async = isAsyncMethod;
            return new AST.MethodDefinition(key, value, kind, isStatic, false);
        }

        // 私有字段
        let init = null;
        if (this.peekTokenIs(TokenType.ASSIGN)) {
            this.nextToken();
            this.nextToken();
            // [Wave 8] 私有字段初始化器同样受 ContainsArguments/ContainsSuperCall 约束。
            const prevInFieldInit = this._inFieldInit;
            this._inFieldInit = true;
            init = this.parseExpression(Precedence.ASSIGN - 1);
            this._inFieldInit = prevInFieldInit;
        }
        if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
        return new AST.PropertyDefinition(key, init, false, isStatic);
    },

    parseClassExpression() {
        // 类表达式:匿名 `class {}` 须合成名字(否则 parseClassDeclaration 对匿名返回 null →
        // 语法错误)。具名 `class D {}` 的当前 token 是标识符,defaultName 被忽略、用真名。
        this._classExprCounter = (this._classExprCounter || 0) + 1;
        return this.parseClassDeclaration("__classexpr" + this._classExprCounter);
    },
};
