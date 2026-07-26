// asm.js - JavaScript 语法解析器
// 将词法单元流转换为抽象语法树
// 模块化重构版本

import { TokenType } from "../lexer/token.js";
import { Lexer } from "../lexer/index.js";
import * as AST from "./ast.js";
import { Precedence, precedences } from "./precedence.js";
import { StatementParser } from "./statements.js";
import { ExpressionParser } from "./expressions.js";
import { ClassParser } from "./classes.js";
import { ModuleParser } from "./modules.js";

// 解析器类
export class Parser {
    constructor(lexer) {
        this.lexer = lexer;
        this.curToken = null;
        this.peekToken = null;
        this.errors = [];
        // 类体嵌套深度：#x 私有成员访问仅在类体内合法（>0），类外 obj.#x 报语法错
        this.classDepth = 0;
        // [test262 S1] 生成器/异步函数嵌套深度:yield/await 作绑定标识符(形参/var 名)仅在相应
        // 函数体内是早期错误(作 yield/await 表达式合法)。函数入口 +1、出口 -1。
        this.fnGenDepth = 0;
        this.fnAsyncDepth = 0;
        // [test262 S1] strict 模式深度:函数体首语句为 "use strict" 指令时 +1。strict 下
        // eval/arguments 不可作绑定名、形参不可重名。
        this.fnStrictDepth = 0;
        // [安全] 递归解析深度守卫:嵌套 ( / [ / { / 语句无上限时,几千层即耗尽自举原生
        // 二进制的栈 → 不可捕获 SIGSEGV(DoS)。在核心表达式/语句解析入口 +1、出口 -1,
        // 超过 maxParseDepth 记 SyntaxError 并停止下钻(编译期 parser.errors 非空即抛错)。
        // 上限取远高于编译器自身源码所需(实测嵌套深度 < 100),1000 层留足余量。
        this.parseDepth = 0;
        this.maxParseDepth = 1000;
        // [test262 S1] 程序级 strict:脚本首条 "use strict" 指令 → 顶层 strict(供 delete 裸变量
        // 等早期错误判定;函数级 strict 仍由 fnStrictDepth 跟踪)。parseProgram 起始探测。
        this.programStrict = false;

        this.prefixParseFns = {};
        this.infixParseFns = {};

        this.registerParseFns();
        this.nextToken();
        this.nextToken();
    }

    registerParseFns() {
        // 前缀解析函数
        this.prefixParseFns[TokenType.IDENT] = () => this.parseIdentifier();
        this.prefixParseFns[TokenType.INT] = () => this.parseNumberLiteral();
        this.prefixParseFns[TokenType.FLOAT] = () => this.parseNumberLiteral();
        this.prefixParseFns[TokenType.BIGINT] = () => this.parseBigIntLiteral();
        this.prefixParseFns[TokenType.STRING] = () => this.parseStringLiteral();
        this.prefixParseFns[TokenType.REGEX] = () => this.parseRegexLiteral();
        this.prefixParseFns[TokenType.TEMPLATE_STRING] = () => this.parseTemplateLiteral();
        this.prefixParseFns[TokenType.TEMPLATE_HEAD] = () => this.parseTemplateLiteralWithExpressions();
        // [#34] tagged template:表达式后跟模板 → 解析期脱糖 tag([...strs], ...exprs)
        this.infixParseFns[TokenType.TEMPLATE_STRING] = (left) => this.parseTaggedTemplate(left);
        this.infixParseFns[TokenType.TEMPLATE_HEAD] = (left) => this.parseTaggedTemplate(left);
        this.prefixParseFns[TokenType.TRUE] = () => this.parseBooleanLiteral();
        this.prefixParseFns[TokenType.FALSE] = () => this.parseBooleanLiteral();
        this.prefixParseFns[TokenType.NULL] = () => this.parseNullLiteral();
        this.prefixParseFns[TokenType.UNDEFINED] = () => this.parseUndefinedLiteral();
        this.prefixParseFns[TokenType.BANG] = () => this.parsePrefixExpression();
        this.prefixParseFns[TokenType.MINUS] = () => this.parsePrefixExpression();
        this.prefixParseFns[TokenType.PLUS] = () => this.parsePrefixExpression();
        this.prefixParseFns[TokenType.BITNOT] = () => this.parsePrefixExpression();
        this.prefixParseFns[TokenType.INCREMENT] = () => this.parsePrefixUpdateExpression();
        this.prefixParseFns[TokenType.DECREMENT] = () => this.parsePrefixUpdateExpression();
        this.prefixParseFns[TokenType.TYPEOF] = () => this.parsePrefixExpression();
        this.prefixParseFns[TokenType.VOID] = () => this.parsePrefixExpression();
        this.prefixParseFns[TokenType.DELETE] = () => this.parsePrefixExpression();
        this.prefixParseFns[TokenType.LPAREN] = () => this.parseGroupedOrArrow();
        this.prefixParseFns[TokenType.LBRACKET] = () => this.parseArrayLiteral();
        this.prefixParseFns[TokenType.LBRACE] = () => this.parseObjectLiteral();
        this.prefixParseFns[TokenType.CLASS] = () => this.parseClassExpression();
        this.prefixParseFns[TokenType.THIS] = () => this.parseThisExpression();
        this.prefixParseFns[TokenType.SUPER] = () => this.parseSuperExpression();
        this.prefixParseFns[TokenType.NEW] = () => this.parseNewExpression();
        this.prefixParseFns[TokenType.ASYNC] = () => this.parseAsyncExpression();
        this.prefixParseFns[TokenType.AWAIT] = () => this.parseAwaitExpression();
        this.prefixParseFns[TokenType.SPREAD] = () => this.parseSpreadExpression();
        this.prefixParseFns[TokenType.FUNCTION] = () => this.parseFunctionExpression();
        this.prefixParseFns[TokenType.YIELD] = () => this.parseYieldExpression();
        this.prefixParseFns[TokenType.IMPORT] = () => this.parseImportExpression();

        this.prefixParseFns[TokenType.STATIC] = () => new AST.Identifier(this.curToken.literal);
        this.prefixParseFns[TokenType.GET] = () => new AST.Identifier(this.curToken.literal);
        this.prefixParseFns[TokenType.SET] = () => new AST.Identifier(this.curToken.literal);
        this.prefixParseFns[TokenType.FROM] = () => new AST.Identifier(this.curToken.literal);
        this.prefixParseFns[TokenType.AS] = () => new AST.Identifier(this.curToken.literal);
        this.prefixParseFns[TokenType.OF] = () => new AST.Identifier(this.curToken.literal);
        this.prefixParseFns[TokenType.EXTENDS] = () => new AST.Identifier(this.curToken.literal);
        this.prefixParseFns[TokenType.TEMPLATE_MIDDLE] = () => {
            this.errors.push(`unexpected TEMPLATE_MIDDLE at ${this.curToken.line}:${this.curToken.column}`);
            return null;
        };
        this.prefixParseFns[TokenType.TEMPLATE_TAIL] = () => {
            this.errors.push(`unexpected TEMPLATE_TAIL at ${this.curToken.line}:${this.curToken.column}`);
            return null;
        };

        // 中缀解析函数
        this.infixParseFns[TokenType.PLUS] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.MINUS] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.ASTERISK] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.SLASH] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.PERCENT] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.POWER] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.POWER_ASSIGN] = (left) => this.parseAssignmentExpression(left);
        this.infixParseFns[TokenType.EQ] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.NOT_EQ] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.STRICT_EQ] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.STRICT_NOT_EQ] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.LT] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.GT] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.LTE] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.GTE] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.AND] = (left) => this.parseLogicalExpression(left);
        this.infixParseFns[TokenType.OR] = (left) => this.parseLogicalExpression(left);
        this.infixParseFns[TokenType.NULLISH] = (left) => this.parseLogicalExpression(left); // [#33] ?? 是 Logical,误注册 Binary 致整条空值合并失效
        this.infixParseFns[TokenType.BITAND] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.BITOR] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.BITXOR] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.LSHIFT] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.RSHIFT] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.URSHIFT] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.INSTANCEOF] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.IN] = (left) => this.parseBinaryExpression(left);
        this.infixParseFns[TokenType.LPAREN] = (left) => this.parseCallExpression(left);
        this.infixParseFns[TokenType.LBRACKET] = (left) => this.parseIndexExpression(left);
        this.infixParseFns[TokenType.DOT] = (left) => this.parseMemberExpression(left);
        this.infixParseFns[TokenType.OPTIONAL] = (left) => this.parseOptionalMemberExpression(left);
        this.infixParseFns[TokenType.ASSIGN] = (left) => this.parseAssignmentExpression(left);
        this.infixParseFns[TokenType.PLUS_ASSIGN] = (left) => this.parseAssignmentExpression(left);
        this.infixParseFns[TokenType.MINUS_ASSIGN] = (left) => this.parseAssignmentExpression(left);
        this.infixParseFns[TokenType.ASTERISK_ASSIGN] = (left) => this.parseAssignmentExpression(left);
        this.infixParseFns[TokenType.SLASH_ASSIGN] = (left) => this.parseAssignmentExpression(left);
        this.infixParseFns[TokenType.PERCENT_ASSIGN] = (left) => this.parseAssignmentExpression(left);
        this.infixParseFns[TokenType.AND_ASSIGN] = (left) => this.parseAssignmentExpression(left);
        this.infixParseFns[TokenType.OR_ASSIGN] = (left) => this.parseAssignmentExpression(left);
        this.infixParseFns[TokenType.XOR_ASSIGN] = (left) => this.parseAssignmentExpression(left);
        this.infixParseFns[TokenType.LSHIFT_ASSIGN] = (left) => this.parseAssignmentExpression(left);
        this.infixParseFns[TokenType.RSHIFT_ASSIGN] = (left) => this.parseAssignmentExpression(left);
        this.infixParseFns[TokenType.URSHIFT_ASSIGN] = (left) => this.parseAssignmentExpression(left);
        this.infixParseFns[TokenType.LOGICAL_AND_ASSIGN] = (left) => this.parseAssignmentExpression(left);
        this.infixParseFns[TokenType.LOGICAL_OR_ASSIGN] = (left) => this.parseAssignmentExpression(left);
        this.infixParseFns[TokenType.NULLISH_ASSIGN] = (left) => this.parseAssignmentExpression(left);
        this.infixParseFns[TokenType.QUESTION] = (left) => this.parseConditionalExpression(left);
        this.infixParseFns[TokenType.INCREMENT] = (left) => this.parsePostfixUpdateExpression(left);
        this.infixParseFns[TokenType.DECREMENT] = (left) => this.parsePostfixUpdateExpression(left);
        this.infixParseFns[TokenType.COMMA] = (left) => this.parseSequenceExpression(left);
    }

    nextToken() {
        this.curToken = this.peekToken;
        this.peekToken = this.lexer.nextToken();
    }

    // 词法+语法状态快照/恢复:用于有限的试探式前瞻(如判别 `({a})=>` 解构参数箭头
    // vs 括号对象字面量)。捕获 lexer 全部游标 + 双 token + 错误水位,恢复即回到快照点。
    saveState() {
        return {
            p: this.lexer.position, rp: this.lexer.readPosition, ch: this.lexer.ch,
            ln: this.lexer.line, col: this.lexer.column,
            cur: this.curToken, peek: this.peekToken, err: this.errors.length,
        };
    }
    restoreState(s) {
        this.lexer.position = s.p; this.lexer.readPosition = s.rp; this.lexer.ch = s.ch;
        this.lexer.line = s.ln; this.lexer.column = s.col;
        this.curToken = s.cur; this.peekToken = s.peek;
        this.errors.length = s.err;
    }

    curTokenIs(t) {
        return this.curToken.type === t;
    }

    peekTokenIs(t) {
        return this.peekToken.type === t;
    }

    curTokenIsIdentifier() {
        const type = this.curToken.type;
        if (type === TokenType.IDENT) return true;
        // 允许作为标识符的关键字 (几乎所有，除了几个核心保留字)
        // 在 JS 中，属性名和非严格模式下的很多地方都可以用关键字
        return type !== TokenType.EOF && 
               type !== TokenType.ILLEGAL &&
               type !== TokenType.SEMICOLON &&
               type !== TokenType.LPAREN &&
               type !== TokenType.RPAREN &&
               type !== TokenType.LBRACE &&
               type !== TokenType.RBRACE &&
               type !== TokenType.LBRACKET &&
               type !== TokenType.RBRACKET &&
               type !== TokenType.COMMA &&
               type !== TokenType.DOT &&
               type !== TokenType.COLON &&
               type !== TokenType.QUESTION;
    }

    peekTokenIsIdentifier() {
        const type = this.peekToken.type;
        if (type === TokenType.IDENT) return true;
        return type !== TokenType.EOF && 
               type !== TokenType.ILLEGAL &&
               type !== TokenType.SEMICOLON &&
               type !== TokenType.LPAREN &&
               type !== TokenType.RPAREN &&
               type !== TokenType.LBRACE &&
               type !== TokenType.RBRACE &&
               type !== TokenType.LBRACKET &&
               type !== TokenType.RBRACKET &&
               type !== TokenType.COMMA &&
               type !== TokenType.DOT &&
               type !== TokenType.COLON &&
               type !== TokenType.QUESTION;
    }

    expectPeek(t) {
        if (this.peekTokenIs(t)) {
            this.nextToken();
            return true;
        }
        this.peekError(t);
        return false;
    }

    expectIdentifier() {
        if (this.peekTokenIsIdentifier()) {
            this.nextToken();
            return true;
        }
        this.peekError(TokenType.IDENT);
        return false;
    }

    peekError(t) {
        this.errors.push("expected " + t + ", got " + this.peekToken.type);
    }

    curPrecedence() {
        return precedences[this.curToken.type] || Precedence.LOWEST;
    }

    peekPrecedence() {
        return precedences[this.peekToken.type] || Precedence.LOWEST;
    }

    // ============ 解析程序 ============

    parseProgram() {
        let program = new AST.Program();
        // [test262 S1] 顶层 "use strict" 指令探测:首 token 为字符串字面量 "use strict"。
        if (this.curTokenIs(TokenType.STRING) && this.curToken.literal === "use strict") {
            this.programStrict = true;
        }
        while (!this.curTokenIs(TokenType.EOF)) {
            let stmt = this.parseStatement();
            if (stmt !== null) {
                program.body.push(stmt);
            }
            this.nextToken();
        }
        return program;
    }
}

// 混入所有解析方法
Object.assign(Parser.prototype, StatementParser);
Object.assign(Parser.prototype, ExpressionParser);
Object.assign(Parser.prototype, ClassParser);
Object.assign(Parser.prototype, ModuleParser);

// 创建解析器
export function newParser(lexer) {
    return new Parser(lexer);
}

// 解析源代码
export function parse(source) {
    let lexer = new Lexer(source);
    let parser = new Parser(lexer);
    return parser.parseProgram();
}
