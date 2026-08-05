// asm.js - JavaScript 词法单元定义
// Token 类型和关键字映射

// Token 类型常量
export const TokenType = {
    // 特殊标记
    ILLEGAL: "ILLEGAL",
    EOF: "EOF",

    // 标识符和字面量
    IDENT: "IDENT",
    INT: "INT",
    BIGINT: "BIGINT", // BigInt literal (e.g., 123n, 0xFFn)
    FLOAT: "FLOAT",
    STRING: "STRING",
    REGEX: "REGEX",
    TEMPLATE_STRING: "TEMPLATE_STRING",
    TEMPLATE_HEAD: "TEMPLATE_HEAD", // `...${
    TEMPLATE_MIDDLE: "TEMPLATE_MIDDLE", // }...${
    TEMPLATE_TAIL: "TEMPLATE_TAIL", // }...`

    // 运算符
    ASSIGN: "=",
    PLUS: "+",
    MINUS: "-",
    BANG: "!",
    ASTERISK: "*",
    SLASH: "/",
    PERCENT: "%",
    POWER: "**",
    POWER_ASSIGN: "**=",

    // 比较运算符
    LT: "<",
    GT: ">",
    EQ: "==",
    NOT_EQ: "!=",
    LTE: "<=",
    GTE: ">=",
    STRICT_EQ: "===",
    STRICT_NOT_EQ: "!==",

    // 逻辑运算符
    AND: "&&",
    OR: "||",
    NULLISH: "??",

    // 位运算符
    BITAND: "&",
    BITOR: "|",
    BITXOR: "^",
    BITNOT: "~",
    LSHIFT: "<<",
    RSHIFT: ">>",
    URSHIFT: ">>>",

    // 复合赋值
    PLUS_ASSIGN: "+=",
    MINUS_ASSIGN: "-=",
    ASTERISK_ASSIGN: "*=",
    SLASH_ASSIGN: "/=",
    PERCENT_ASSIGN: "%=",
    AND_ASSIGN: "&=",
    OR_ASSIGN: "|=",
    XOR_ASSIGN: "^=",
    LSHIFT_ASSIGN: "<<=",
    RSHIFT_ASSIGN: ">>=",

    // 逻辑赋值 (ES2021)
    LOGICAL_AND_ASSIGN: "&&=",
    LOGICAL_OR_ASSIGN: "||=",
    NULLISH_ASSIGN: "??=",

    // 自增自减
    INCREMENT: "++",
    DECREMENT: "--",

    // 分隔符
    COMMA: ",",
    SEMICOLON: ";",
    COLON: ":",
    DOT: ".",
    QUESTION: "?",
    ARROW: "=>",
    SPREAD: "...",
    OPTIONAL: "?.",
    HASH: "#", // 私有字段前缀

    // 括号
    LPAREN: "(",
    RPAREN: ")",
    LBRACE: "{",
    RBRACE: "}",
    LBRACKET: "[",
    RBRACKET: "]",

    // 关键字
    FUNCTION: "FUNCTION",
    LET: "LET",
    CONST: "CONST",
    VAR: "VAR",
    TRUE: "TRUE",
    FALSE: "FALSE",
    IF: "IF",
    ELSE: "ELSE",
    RETURN: "RETURN",
    FOR: "FOR",
    WHILE: "WHILE",
    DO: "DO",
    SWITCH: "SWITCH",
    CASE: "CASE",
    DEFAULT: "DEFAULT",
    BREAK: "BREAK",
    CONTINUE: "CONTINUE",
    NULL: "NULL",
    UNDEFINED: "UNDEFINED",
    THIS: "THIS",
    NEW: "NEW",
    CLASS: "CLASS",
    EXTENDS: "EXTENDS",
    SUPER: "SUPER",
    STATIC: "STATIC",
    GET: "GET",
    SET: "SET",
    IMPORT: "IMPORT",
    EXPORT: "EXPORT",
    FROM: "FROM",
    AS: "AS",
    ASYNC: "ASYNC",
    AWAIT: "AWAIT",
    YIELD: "YIELD",
    TRY: "TRY",
    CATCH: "CATCH",
    FINALLY: "FINALLY",
    THROW: "THROW",
    TYPEOF: "TYPEOF",
    INSTANCEOF: "INSTANCEOF",
    IN: "IN",
    OF: "OF",
    DELETE: "DELETE",
    VOID: "VOID",
    INT_TYPE: "INT_TYPE", // int 类型声明关键字
};

// 关键字映射
const keywords = {
    function: TokenType.FUNCTION,
    let: TokenType.LET,
    const: TokenType.CONST,
    var: TokenType.VAR,
    true: TokenType.TRUE,
    false: TokenType.FALSE,
    if: TokenType.IF,
    else: TokenType.ELSE,
    return: TokenType.RETURN,
    for: TokenType.FOR,
    while: TokenType.WHILE,
    do: TokenType.DO,
    switch: TokenType.SWITCH,
    case: TokenType.CASE,
    default: TokenType.DEFAULT,
    break: TokenType.BREAK,
    continue: TokenType.CONTINUE,
    null: TokenType.NULL,
    undefined: TokenType.UNDEFINED,
    this: TokenType.THIS,
    new: TokenType.NEW,
    class: TokenType.CLASS,
    extends: TokenType.EXTENDS,
    super: TokenType.SUPER,
    static: TokenType.STATIC,
    get: TokenType.GET,
    set: TokenType.SET,
    import: TokenType.IMPORT,
    export: TokenType.EXPORT,
    from: TokenType.FROM,
    as: TokenType.AS,
    async: TokenType.ASYNC,
    await: TokenType.AWAIT,
    yield: TokenType.YIELD,
    try: TokenType.TRY,
    catch: TokenType.CATCH,
    finally: TokenType.FINALLY,
    throw: TokenType.THROW,
    typeof: TokenType.TYPEOF,
    instanceof: TokenType.INSTANCEOF,
    in: TokenType.IN,
    of: TokenType.OF,
    delete: TokenType.DELETE,
    void: TokenType.VOID,
    int: TokenType.INT_TYPE,
};

// 查找标识符是否为关键字
// inTemplateExpression: 当在模板字符串表达式 ${...} 内部时，关键字应作为标识符处理
export function lookupIdent(ident, inTemplateExpression = false) {
    // 用 keywords[ident] 直接查 + typeof 判定，替代
    // Object.prototype.hasOwnProperty.call(keywords, ident)：后者依赖 .call/原型访问，
    // 编译产物（gen1）里 Object.prototype 访问与 Function.prototype.call 都会崩。
    // keywords 值都是 TokenType 字符串；若 ident 恰为继承方法名（constructor 等），
    // keywords[ident] 是函数而非字符串，typeof 检查将其正确排除为普通标识符。
    let type = keywords[ident];
    if (typeof type === "string") {
        // In template expressions, most keywords can be used as identifiers (e.g., obj.type)
        // BUT keywords that start / operate on an expression MUST remain keywords so the
        // interpolation `${...}` parses as an expression. This includes operator keywords
        // (typeof/void/delete/instanceof/in/async/await/yield) AND expression-form keywords
        // (new/function/class/this/super/true/false/null) — otherwise `${new M()}`,
        // `${function(){}()}`, `${this.x}` etc. were lexed as bare identifiers and failed
        // to parse ("unexpected IDENT").
        if (inTemplateExpression &&
            type !== TokenType.TYPEOF &&
            type !== TokenType.VOID &&
            type !== TokenType.DELETE &&
            type !== TokenType.INSTANCEOF &&
            type !== TokenType.IN &&
            type !== TokenType.ASYNC &&
            type !== TokenType.AWAIT &&
            type !== TokenType.YIELD &&
            type !== TokenType.NEW &&
            type !== TokenType.FUNCTION &&
            type !== TokenType.CLASS &&
            type !== TokenType.THIS &&
            type !== TokenType.SUPER &&
            type !== TokenType.TRUE &&
            type !== TokenType.FALSE &&
            type !== TokenType.NULL
        ) {
            return TokenType.IDENT;
        }
        return type;
    }
    return TokenType.IDENT;
}

// Token 类
export class Token {
    constructor(type, literal, line, column) {
        this.type = type;
        this.literal = literal;
        this.line = line;
        this.column = column;
    }
}

// 创建 Token
export function newToken(type, literal, line, column) {
    return new Token(type, literal, line, column);
}
