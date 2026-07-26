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
            id = new AST.Identifier(this.curToken.literal);
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
        this.classDepth = this.classDepth - 1;
        return body;
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
            return this.parsePrivateFieldOrMethod(isStatic, kind);
        }

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
        let params = this.parseFunctionParams();
        if (!this.expectPeek(TokenType.LBRACE)) {
            if (isGenerator) this.fnGenDepth--;
            if (isAsyncMethod) this.fnAsyncDepth--;
            return null;
        }
        // [test262 S1] strict 探测(显式 "use strict" 指令;类体隐式 strict 待后续)
        let isStrict = this.peekUseStrictDirective();
        if (isStrict) { this.fnStrictDepth++; this.checkStrictParams(params); }
        let methodBody = this.parseBlockStatement();
        if (isStrict) this.fnStrictDepth--;
        if (isGenerator) this.fnGenDepth--;
        if (isAsyncMethod) this.fnAsyncDepth--;
        let value = new AST.FunctionExpression(null, params, methodBody, isAsyncMethod, isGenerator);
        value.generator = isGenerator;
        value.async = isAsyncMethod;
        return new AST.MethodDefinition(key, value, kind, isStatic, computed);
    },

    parseClassField(isStatic, isPrivate, existingKey = null, computed = false) {
        let key = existingKey;
        if (!key) {
            let name = this.curToken.literal;
            key = isPrivate ? new AST.PrivateIdentifier(name) : new AST.Identifier(name);
        }

        let init = null;
        if (this.peekTokenIs(TokenType.ASSIGN)) {
            this.nextToken();
            this.nextToken();
            init = this.parseExpression(Precedence.ASSIGN - 1);
        }
        if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
        return new AST.PropertyDefinition(key, init, computed, isStatic);
    },

    parsePrivateFieldOrMethod(isStatic, kind = "method") {
        // 获取私有名称
        let name = this.curToken.literal;
        if (!name.startsWith("#")) {
            this.nextToken();
            name = "#" + this.curToken.literal;
        }
        let key = new AST.PrivateIdentifier(name);

        // 检查是否是方法 (有括号)
        if (this.peekTokenIs(TokenType.LPAREN)) {
            this.nextToken();
            let params = this.parseFunctionParams();
            if (!this.expectPeek(TokenType.LBRACE)) return null;
            let methodBody = this.parseBlockStatement();
            let value = new AST.FunctionExpression(null, params, methodBody, false);
            return new AST.MethodDefinition(key, value, kind, isStatic, false);
        }

        // 私有字段
        let init = null;
        if (this.peekTokenIs(TokenType.ASSIGN)) {
            this.nextToken();
            this.nextToken();
            init = this.parseExpression(Precedence.ASSIGN - 1);
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
