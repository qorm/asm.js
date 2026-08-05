// asm.js 解析器 - 模块解析
// 解析 import/export 声明

import { TokenType } from "../lexer/token.js";
import * as AST from "./ast.js";
import { Precedence } from "./precedence.js";

// 模块解析混入
export const ModuleParser = {
    parseImportDeclaration() {
        let specifiers = [];
        let source = null;
        this.nextToken();

        // import "module" (副作用导入)
        if (this.curTokenIs(TokenType.STRING)) {
            let libPath = this.curToken.literal;
            source = new AST.Literal(libPath, '"' + libPath + '"');
            // 检查是否是 jslib 文件
            if (libPath.endsWith(".jslib")) {
                if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
                return new AST.ImportLibDeclaration(libPath, []);
            }
            if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
            return new AST.ImportDeclaration(specifiers, source);
        }

        // import * as name from "module"
        if (this.curTokenIs(TokenType.ASTERISK)) {
            if (this.peekTokenIs(TokenType.FROM)) {
                this.nextToken();
                if (!this.expectPeek(TokenType.STRING)) return null;
                let libPath = this.curToken.literal;
                if (libPath.endsWith(".jslib")) {
                    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
                    return new AST.ImportLibDeclaration(libPath, []);
                }
                this.errors.push("import * from requires .jslib file or use 'import * as name from'");
                return null;
            }
            if (!this.expectPeek(TokenType.AS)) return null;
            this.nextToken();
            let local = new AST.Identifier(this.curToken.literal);
            specifiers.push(new AST.ImportSpecifier(local, null, false, true));
        }
        // import { a, b as c } from "module"
        else if (this.curTokenIs(TokenType.LBRACE)) {
            this.nextToken();
            while (!this.curTokenIs(TokenType.RBRACE) && !this.curTokenIs(TokenType.EOF)) {
                let imported = new AST.Identifier(this.curToken.literal);
                let local = imported;
                if (this.peekTokenIs(TokenType.AS)) {
                    this.nextToken();
                    this.nextToken();
                    local = new AST.Identifier(this.curToken.literal);
                }
                specifiers.push(new AST.ImportSpecifier(local, imported, false, false));
                if (this.peekTokenIs(TokenType.COMMA)) {
                    this.nextToken();
                    this.nextToken();
                } else {
                    break;
                }
            }
            if (!this.expectPeek(TokenType.RBRACE)) return null;
        }
        // import defaultExport from "module"
        else if (this.curTokenIs(TokenType.IDENT)) {
            let local = new AST.Identifier(this.curToken.literal);
            specifiers.push(new AST.ImportSpecifier(local, null, true, false));
            // import defaultExport, { named } from "module"
            if (this.peekTokenIs(TokenType.COMMA)) {
                this.nextToken();
                this.nextToken();
                if (this.curTokenIs(TokenType.LBRACE)) {
                    this.nextToken();
                    while (!this.curTokenIs(TokenType.RBRACE) && !this.curTokenIs(TokenType.EOF)) {
                        let imported = new AST.Identifier(this.curToken.literal);
                        let local2 = imported;
                        if (this.peekTokenIs(TokenType.AS)) {
                            this.nextToken();
                            this.nextToken();
                            local2 = new AST.Identifier(this.curToken.literal);
                        }
                        specifiers.push(new AST.ImportSpecifier(local2, imported, false, false));
                        if (this.peekTokenIs(TokenType.COMMA)) {
                            this.nextToken();
                            this.nextToken();
                        } else {
                            break;
                        }
                    }
                    if (!this.expectPeek(TokenType.RBRACE)) return null;
                }
            }
        }

        if (!this.expectPeek(TokenType.FROM)) return null;
        if (!this.expectPeek(TokenType.STRING)) return null;
        source = new AST.Literal(this.curToken.literal, '"' + this.curToken.literal + '"');
        if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
        return new AST.ImportDeclaration(specifiers, source);
    },

    parseExportDeclaration() {
        this.nextToken();
        let isDefault = false;
        let declaration = null;
        let specifiers = [];
        let source = null;

        // export default ...
        if (this.curTokenIs(TokenType.DEFAULT)) {
            isDefault = true;
            this.nextToken();
            // 匿名 default export:`export default function(){}` / `export default class {}`
            // 允许无名声明,赋合成名 __default__,复用具名 default export 通道。
            if (this.curTokenIs(TokenType.FUNCTION)) {
                declaration = this.parseFunctionDeclaration("__default__");
            } else if (this.curTokenIs(TokenType.ASYNC) && this.peekTokenIs(TokenType.FUNCTION)) {
                declaration = this.parseFunctionDeclaration("__default__");
            } else if (this.curTokenIs(TokenType.CLASS)) {
                declaration = this.parseClassDeclaration("__default__");
            } else {
                declaration = this.parseExpression(Precedence.LOWEST);
            }
        }
        // export function/class/const/let/var
        else if (this.curTokenIs(TokenType.FUNCTION)) {
            declaration = this.parseFunctionDeclaration();
        } else if (this.curTokenIs(TokenType.ASYNC) && this.peekTokenIs(TokenType.FUNCTION)) {
            declaration = this.parseFunctionDeclaration();
        } else if (this.curTokenIs(TokenType.CLASS)) {
            declaration = this.parseClassDeclaration();
        } else if (this.curTokenIs(TokenType.CONST) || this.curTokenIs(TokenType.LET) || this.curTokenIs(TokenType.VAR)) {
            declaration = this.parseVariableDeclaration();
        }
        // export { a, b as c }
        else if (this.curTokenIs(TokenType.LBRACE)) {
            this.nextToken();
            while (!this.curTokenIs(TokenType.RBRACE) && !this.curTokenIs(TokenType.EOF)) {
                let local = new AST.Identifier(this.curToken.literal);
                let exported = local;
                if (this.peekTokenIs(TokenType.AS)) {
                    this.nextToken();
                    this.nextToken();
                    exported = new AST.Identifier(this.curToken.literal);
                }
                specifiers.push(new AST.ExportSpecifier(local, exported));
                if (this.peekTokenIs(TokenType.COMMA)) {
                    this.nextToken();
                    this.nextToken();
                } else {
                    break;
                }
            }
            // 尾逗号 `export { a, b, }` 或空 `export {}`:循环末 curToken 已是 `}`
            // (逗号推进消费到闭括号),不再 expectPeek,否则误报 "expected }, got ;"。
            if (!this.curTokenIs(TokenType.RBRACE)) {
                if (!this.expectPeek(TokenType.RBRACE)) return null;
            }
            // export { ... } from "module"
            if (this.peekTokenIs(TokenType.FROM)) {
                this.nextToken();
                if (!this.expectPeek(TokenType.STRING)) return null;
                source = new AST.Literal(this.curToken.literal, '"' + this.curToken.literal + '"');
            }
        }
        // export * from "module"
        else if (this.curTokenIs(TokenType.ASTERISK)) {
            // export * as name from "module"
            if (this.peekTokenIs(TokenType.AS)) {
                this.nextToken();
                this.nextToken();
                let exported = new AST.Identifier(this.curToken.literal);
                specifiers.push(new AST.ExportSpecifier(null, exported, true));
            }
            if (!this.expectPeek(TokenType.FROM)) return null;
            if (!this.expectPeek(TokenType.STRING)) return null;
            source = new AST.Literal(this.curToken.literal, '"' + this.curToken.literal + '"');
        }

        if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
        return new AST.ExportDeclaration(declaration, specifiers, source, isDefault);
    },
};
