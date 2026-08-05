// asm.js - JavaScript 语言前端
// 提供词法分析、语法分析和语义分析功能

// 词法分析
export { Lexer, newLexer } from "./lexer/index.js";
export { TokenType, Token, newToken, lookupIdent } from "./lexer/token.js";

// 语法分析
export { Parser, newParser, parse } from "./parser/index.js";
export * as AST from "./parser/ast.js";

// 语义分析
export { isBuiltinOrGlobal, analyzeCapturedVariables, collectLocalDeclarations, collectReferencedVariables, collectNestedFunctionReferences, analyzeSharedVariables } from "./analysis/closure.js";
