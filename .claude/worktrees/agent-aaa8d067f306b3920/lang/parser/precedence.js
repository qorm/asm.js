// asm.js 解析器 - 运算符优先级定义

import { TokenType } from "../lexer/token.js";

// 运算符优先级
export const Precedence = {
    LOWEST: 1,
    COMMA: 2,
    ASSIGN: 3,
    TERNARY: 4,
    OR: 5,
    NULLISH: 6,
    AND: 7,
    BITOR: 8,
    BITXOR: 9,
    BITAND: 10,
    EQUALS: 11,
    COMPARE: 12,
    SHIFT: 13,
    SUM: 14,
    PRODUCT: 15,
    POWER: 16,
    PREFIX: 17,
    POSTFIX: 18,
    CALL: 19,
    MEMBER: 20,
};

// Token 到优先级的映射
export const precedences = {};
precedences[TokenType.COMMA] = Precedence.COMMA;
precedences[TokenType.ASSIGN] = Precedence.ASSIGN;
precedences[TokenType.PLUS_ASSIGN] = Precedence.ASSIGN;
precedences[TokenType.MINUS_ASSIGN] = Precedence.ASSIGN;
precedences[TokenType.ASTERISK_ASSIGN] = Precedence.ASSIGN;
precedences[TokenType.SLASH_ASSIGN] = Precedence.ASSIGN;
precedences[TokenType.PERCENT_ASSIGN] = Precedence.ASSIGN;
precedences[TokenType.AND_ASSIGN] = Precedence.ASSIGN;
precedences[TokenType.OR_ASSIGN] = Precedence.ASSIGN;
precedences[TokenType.XOR_ASSIGN] = Precedence.ASSIGN;
precedences[TokenType.LSHIFT_ASSIGN] = Precedence.ASSIGN;
precedences[TokenType.RSHIFT_ASSIGN] = Precedence.ASSIGN;
precedences[TokenType.LOGICAL_AND_ASSIGN] = Precedence.ASSIGN;
precedences[TokenType.LOGICAL_OR_ASSIGN] = Precedence.ASSIGN;
precedences[TokenType.NULLISH_ASSIGN] = Precedence.ASSIGN;
precedences[TokenType.QUESTION] = Precedence.TERNARY;
precedences[TokenType.OR] = Precedence.OR;
precedences[TokenType.NULLISH] = Precedence.NULLISH;
precedences[TokenType.AND] = Precedence.AND;
precedences[TokenType.BITOR] = Precedence.BITOR;
precedences[TokenType.BITXOR] = Precedence.BITXOR;
precedences[TokenType.BITAND] = Precedence.BITAND;
precedences[TokenType.EQ] = Precedence.EQUALS;
precedences[TokenType.NOT_EQ] = Precedence.EQUALS;
precedences[TokenType.STRICT_EQ] = Precedence.EQUALS;
precedences[TokenType.STRICT_NOT_EQ] = Precedence.EQUALS;
precedences[TokenType.LT] = Precedence.COMPARE;
precedences[TokenType.GT] = Precedence.COMPARE;
precedences[TokenType.LTE] = Precedence.COMPARE;
precedences[TokenType.GTE] = Precedence.COMPARE;
precedences[TokenType.INSTANCEOF] = Precedence.COMPARE;
precedences[TokenType.IN] = Precedence.COMPARE;
precedences[TokenType.LSHIFT] = Precedence.SHIFT;
precedences[TokenType.RSHIFT] = Precedence.SHIFT;
precedences[TokenType.URSHIFT] = Precedence.SHIFT;
precedences[TokenType.PLUS] = Precedence.SUM;
precedences[TokenType.MINUS] = Precedence.SUM;
precedences[TokenType.ASTERISK] = Precedence.PRODUCT;
precedences[TokenType.SLASH] = Precedence.PRODUCT;
precedences[TokenType.PERCENT] = Precedence.PRODUCT;
precedences[TokenType.POWER] = Precedence.POWER;
precedences[TokenType.POWER_ASSIGN] = Precedence.ASSIGN;
precedences[TokenType.LPAREN] = Precedence.CALL;
precedences[TokenType.LBRACKET] = Precedence.MEMBER;
precedences[TokenType.DOT] = Precedence.MEMBER;
precedences[TokenType.OPTIONAL] = Precedence.MEMBER;
precedences[TokenType.INCREMENT] = Precedence.POSTFIX;
precedences[TokenType.DECREMENT] = Precedence.POSTFIX;

precedences[TokenType.TEMPLATE_STRING] = Precedence.CALL;
precedences[TokenType.TEMPLATE_HEAD] = Precedence.CALL;
