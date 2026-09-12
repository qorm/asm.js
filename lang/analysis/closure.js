// asm.js - 闭包分析模块
// 分析函数表达式中捕获的外部变量

import { parse } from "../parser/index.js";
// 检查是否是内置函数或全局对象。
// 用 {name:1} 而非 Set:gen1 上 Set.has 偏贵(见 skipAstKey 注释);===1 避开原型链。
const BUILTIN_OR_GLOBAL_NAMES = {
    print: 1, console: 1, Promise: 1, Uint8Array: 1, Buffer: 1, Math: 1, sleep: 1, Array: 1,
    Object: 1, String: 1, Number: 1, Boolean: 1, Date: 1, RegExp: 1, JSON: 1, Error: 1,
    undefined: 1, null: 1, NaN: 1, Infinity: 1, globalThis: 1, queueMicrotask: 1,
    __asmjs_setTimeout: 1, __asmjs_setTimeoutUnref: 1, __asmjs_setImmediate: 1,
    __asmjs_queueMicrotask: 1, __asmjs_clearTimer: 1,
};

export function isBuiltinOrGlobal(name) {
    return BUILTIN_OR_GLOBAL_NAMES[name] === 1;
}

// 标志字典(只写 true)的自有判定:=== true 天然避开 Object.prototype 污染。
function flagOwn(o, name) {
    return o[name] === true;
}

function copyFlags(from, into) {
    for (const name in from) into[name] = true;
}

function skipAstKey(key) {
    // gen1 上 Set.has 偏贵;_* 与常见元字段直接分支
    if (key.length > 0 && key.charCodeAt(0) === 95) return true;
    return key === "type" || key === "loc" || key === "range" ||
        key === "start" || key === "end" || key === "filename";
}

// 捕获分析缓存代数:块级改名后 bump,使改名前写入的 _rv/_or 失效(O(1))。
let ANALYSIS_CACHE_GEN = 1;
export function bumpAnalysisCacheGen() {
    ANALYSIS_CACHE_GEN = ANALYSIS_CACHE_GEN + 1;
}
function analysisCacheValid(node, genKey) {
    return node[genKey] === ANALYSIS_CACHE_GEN;
}
function copyRefNames(from, into) {
    for (const name in from) into[name] = true;
}

function visitAstNode(node, visit) {
    if (node && typeof node === "object") visit(node);
}

function visitAstList(list, visit) {
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (item && typeof item === "object") visit(item);
    }
}

// 一次扫描建立嵌套函数/_cc 索引 + 直属 eval 标记,供 analyzeSharedVariables /
// analyzeCapturedVariables / analyzeDirectEvalBoxedVars 复用,避免每函数重复整树 for-in。
export function ensureFunctionNestedIndex(func) {
    if (!func || func._nf) return;
    const nested = [];
    const classes = [];
    let hasEval = false;
    function visit(node) {
        if (!node || typeof node !== "object") return;
        const t = node.type;
        if (!t) return;
        if (t === "FunctionExpression" || t === "ArrowFunctionExpression" || t === "FunctionDeclaration") {
            nested.push(node);
            return;
        }
        if (t === "CallExpression" && node.callee &&
            node.callee.type === "Identifier" && node.callee.name === "eval") {
            hasEval = true;
        }
        if (t === "ClassDeclaration" || t === "ClassExpression") {
            classes.push(node);
        }
        if (t === "Identifier" || t === "Literal" || t === "ThisExpression" ||
            t === "Super" || t === "PrivateIdentifier" || t === "EmptyStatement" ||
            t === "DebuggerStatement" || t === "MetaProperty") {
            return;
        }
        for (const key in node) {
            if (skipAstKey(key)) continue;
            const child = node[key];
            if (child && typeof child === "object") {
                if (Array.isArray(child)) {
                    for (let i = 0; i < child.length; i++) visit(child[i]);
                } else {
                    visit(child);
                }
            }
        }
    }
    visit(func.body);
    const params = func.params;
    if (params) {
        for (let i = 0; i < params.length; i++) visit(params[i]);
    }
    func._nf = nested;
    func._cc = classes;
    if (func.body && typeof func.body === "object") {
        func.body._he = hasEval ? 1 : 0;
    }
}

function walkAstChildrenGeneric(node, visit) {
    for (const key in node) {
        if (skipAstKey(key)) continue;
        const child = node[key];
        if (child && typeof child === "object") {
            if (Array.isArray(child)) visitAstList(child, visit);
            else visit(child);
        }
    }
}

// 按节点类型走已知子字段,避开 Identifier/Literal 上的 for-in(自编译图里占绝大多数)。
// 未列出的类型回退通用遍历,避免漏捕获。
function walkAstChildren(node, visit) {
    const t = node.type;
    if (t === "Identifier" || t === "Literal" || t === "ThisExpression" ||
        t === "SuperExpression" || t === "EmptyStatement" || t === "DebuggerStatement" ||
        t === "PrivateIdentifier" || t === "TemplateElement") return;
    if (t === "MemberExpression") {
        visitAstNode(node.object, visit);
        visitAstNode(node.property, visit);
        return;
    }
    if (t === "CallExpression" || t === "NewExpression") {
        visitAstNode(node.callee, visit);
        visitAstList(node.arguments, visit);
        return;
    }
    if (t === "BinaryExpression" || t === "LogicalExpression" || t === "AssignmentExpression") {
        visitAstNode(node.left, visit);
        visitAstNode(node.right, visit);
        return;
    }
    if (t === "UnaryExpression" || t === "UpdateExpression" ||
        t === "YieldExpression" || t === "AwaitExpression" ||
        t === "SpreadElement" || t === "RestElement" || t === "ThrowStatement" ||
        t === "ExpressionStatement") {
        visitAstNode(node.argument || node.expression, visit);
        return;
    }
    if (t === "VariableDeclarator") {
        visitAstNode(node.id, visit);
        visitAstNode(node.init, visit);
        return;
    }
    if (t === "VariableDeclaration") {
        visitAstList(node.declarations, visit);
        return;
    }
    if (t === "Property" || t === "PropertyDefinition" || t === "MethodDefinition") {
        visitAstNode(node.key, visit);
        visitAstNode(node.value, visit);
        return;
    }
    if (t === "FunctionExpression" || t === "ArrowFunctionExpression" ||
        t === "FunctionDeclaration") {
        visitAstNode(node.id, visit);
        visitAstList(node.params, visit);
        visitAstNode(node.body, visit);
        return;
    }
    if (t === "BlockStatement" || t === "Program") {
        visitAstList(node.body, visit);
        return;
    }
    if (t === "IfStatement") {
        visitAstNode(node.test, visit);
        visitAstNode(node.consequent, visit);
        visitAstNode(node.alternate, visit);
        return;
    }
    if (t === "ReturnStatement") {
        visitAstNode(node.argument, visit);
        return;
    }
    if (t === "ArrayExpression" || t === "ArrayPattern") {
        visitAstList(node.elements, visit);
        return;
    }
    if (t === "ObjectExpression" || t === "ObjectPattern") {
        visitAstList(node.properties, visit);
        return;
    }
    if (t === "ConditionalExpression") {
        visitAstNode(node.test, visit);
        visitAstNode(node.consequent, visit);
        visitAstNode(node.alternate, visit);
        return;
    }
    if (t === "SequenceExpression" || t === "TemplateLiteral") {
        visitAstList(node.expressions, visit);
        if (t === "TemplateLiteral") visitAstList(node.quasis, visit);
        return;
    }
    if (t === "AssignmentPattern") {
        visitAstNode(node.left, visit);
        visitAstNode(node.right, visit);
        return;
    }
    walkAstChildrenGeneric(node, visit);
}

// 递归收集解构 pattern 绑定的所有标识符名(参数或声明目标)。
// 覆盖 Identifier / ObjectPattern / ArrayPattern / AssignmentPattern(默认值)/
// RestElement / SpreadElement。**默认值表达式(AssignmentPattern.right)只是引用外层、
// 不绑定新名,故不收入** —— 保证 `({x=a})=>x` 里的外层 `a` 仍被正确捕获。
export function collectPatternNames(node, out) {
    if (!node) return;
    if (node.type === "Identifier") {
        out[node.name] = true;
    } else if (node.type === "ObjectPattern") {
        const props = node.properties || [];
        for (let i = 0; i < props.length; i++) {
            const prop = props[i];
            if (prop.type === "SpreadElement" || prop.type === "RestElement") {
                collectPatternNames(prop.argument, out);
            } else if (prop.value) {
                collectPatternNames(prop.value, out); // {k: target} 绑 target(含简写 {a})
            } else if (prop.key) {
                collectPatternNames(prop.key, out);
            }
        }
    } else if (node.type === "ArrayPattern") {
        const els = node.elements || [];
        for (let i = 0; i < els.length; i++) {
            if (els[i]) collectPatternNames(els[i], out); // null = 空洞
        }
    } else if (node.type === "AssignmentPattern") {
        collectPatternNames(node.left, out); // 只收目标,默认值 right 是引用
    } else if (node.type === "RestElement" || node.type === "SpreadElement") {
        collectPatternNames(node.argument, out);
    }
}

// FunctionDeclarationInstantiation:有默认值/解构形参时,默认值环境看不见函数体绑定。
function paramsHaveExpressions(params) {
    if (!params) return false;
    for (let i = 0; i < params.length; i++) {
        const p = params[i];
        if (!p) continue;
        if (p.type === "AssignmentPattern") return true;
        if (p.type === "ObjectPattern" || p.type === "ArrayPattern") return true;
        if ((p.type === "SpreadElement" || p.type === "RestElement") &&
            p.argument && (p.argument.type === "ArrayPattern" || p.argument.type === "ObjectPattern")) {
            return true;
        }
    }
    return false;
}

// outerLocals 可能是 {} 或 Map(CompileContext.locals)。Map 无自有枚举键,
// hasOwnProperty/下标均看不到条目 —— 必须走 .has/.get。
// 判定必须用 instanceof Map：gen1 下嵌套帧里 `typeof map.get` 常为 undefined
//（原型方法未落到 _object_get；.has/.get 调用靠编译器 Map 特化仍可用），
// 旧 `typeof .get === "function"` 会误判成普通对象 → 捕获表永远为空。
function outerLocalsHas(outerLocals, name) {
    if (!outerLocals) return false;
    if (outerLocals instanceof Map) {
        return outerLocals.has(name);
    }
    // 调用方可能传标志 {}(true)或偏移表(number);二者皆避开原型污染。
    const v = outerLocals[name];
    return v === true || typeof v === "number";
}

export function outerLocalsGet(outerLocals, name) {
    if (!outerLocals) return undefined;
    if (outerLocals instanceof Map) {
        return outerLocals.get(name);
    }
    return outerLocals[name];
}

// 分析函数表达式中捕获的外部变量
// 返回需要捕获的变量名数组
export function analyzeCapturedVariables(funcExpr, outerLocals, functions) {
    // 树遍历只依赖 AST+缓存代数;outerLocals/functions 在调用点过滤。
    // analyzeSharedVariables 与 compileClassDeclaration 会对同一 ClassDeclaration
    // 各走一遍,缓存避免类方法体双扫。
    let candidates = funcExpr._capCand;
    if (!candidates || !analysisCacheValid(funcExpr, "_capCandG")) {
        const params = funcExpr.params || [];
        const paramNames = {};
        for (let i = 0; i < params.length; i++) {
            collectPatternNames(params[i], paramNames);
        }

        const localVars = {};
        collectLocalDeclarations(funcExpr.body, localVars);
        collectDirectFunctionDeclNames(funcExpr.body, localVars);
        if (funcExpr.id && funcExpr.id.name) localVars[funcExpr.id.name] = true;

        const referenced = {};
        collectReferencedVariables(funcExpr.body, referenced);
        const bodyLocalScope = {};
        copyFlags(paramNames, bodyLocalScope);
        copyFlags(localVars, bodyLocalScope);
        collectNestedFunctionReferences(funcExpr.body, referenced, bodyLocalScope);
        const paramRefs = {};
        const paramOnlyScope = {};
        copyFlags(paramNames, paramOnlyScope);
        if (funcExpr.id && funcExpr.id.name) paramOnlyScope[funcExpr.id.name] = true;
        for (let i = 0; i < params.length; i++) {
            collectReferencedVariables(params[i], paramRefs);
            collectNestedFunctionReferences(params[i], paramRefs, paramOnlyScope);
        }
        for (const name in paramRefs) referenced[name] = true;

        candidates = [];
        const hasParamExpr = paramsHaveExpressions(params);
        for (const name in referenced) {
            if (flagOwn(paramNames, name)) continue;
            // hasParameterExpressions:默认值里的自由名解析到外层,不是体 var/let。
            if (flagOwn(localVars, name) && !(hasParamExpr && flagOwn(paramRefs, name))) continue;
            if (isBuiltinOrGlobal(name)) continue;
            candidates.push(name);
        }
        funcExpr._capCand = candidates;
        funcExpr._capCandG = ANALYSIS_CACHE_GEN;
    }

    const captured = [];
    for (let i = 0; i < candidates.length; i++) {
        const name = candidates[i];
        // Function declarations keep a stable identity via _funcclosure_ /
        // hasFunction; class names are mutable lexical bindings and must be
        // captured when nested functions close over them.
        if (functions && typeof functions[name] === "object" && functions[name] &&
            functions[name].type === "FunctionDeclaration") continue;
        if (outerLocalsHas(outerLocals, name)) captured.push(name);
    }
    return captured;
}

// 函数体**直接子级** FunctionDeclaration 是函数级绑定(与 compileFunctionBody
// hoist 对齐)。collectLocalDeclarations 刻意跳过 FunctionDeclaration(早退),
// 导致 IIFE/嵌套函数里 sibling `function a(){ return b(); } function b(){}`
// 的 b 不入 boxedVars,a 把 b 当全局 → undefined。只收直接子级,不管块级声明。
export function collectDirectFunctionDeclNames(body, vars) {
    if (!body || body.type !== "BlockStatement" || !vars) return;
    const stmts = body.body || [];
    for (let i = 0; i < stmts.length; i++) {
        const s = stmts[i];
        if (s && s.type === "FunctionDeclaration" && s.id && s.id.name) {
            vars[s.id.name] = true;
        }
    }
}

// 收集函数体中声明的局部变量
export function collectLocalDeclarations(node, vars) {
    if (!node) return;

    const t = node.type;
    // 热路径早退：ExpressionStatement 等从不引入绑定，却占 walker 访问量绝大部分。
    // 原先落到 if-else 链末尾才返回，自编译多付约二十万次字符串比较。
    if (t === "ExpressionStatement" || t === "ReturnStatement" ||
        t === "BreakStatement" || t === "ContinueStatement" ||
        t === "ThrowStatement" || t === "EmptyStatement" ||
        t === "DebuggerStatement" || t === "FunctionDeclaration" ||
        t === "ClassExpression" ||
        t === "FunctionExpression" || t === "ArrowFunctionExpression") {
        return;
    }

    if (t === "ClassDeclaration") {
        if (node.id && node.id.name) vars[node.id.name] = true;
        return;
    }

    if (t === "VariableDeclaration") {
        const decls = node.declarations || [];
        for (let i = 0; i < decls.length; i++) {
            if (decls[i].id) {
                if (decls[i].id.type === "Identifier") {
                    vars[decls[i].id.name] = true;
                }
            }
        }
    } else if (t === "ImportDeclaration") {
        const specs = node.specifiers || [];
        for (let i = 0; i < specs.length; i++) {
            if (specs[i].local && specs[i].local.type === "Identifier") {
                vars[specs[i].local.name] = true;
            }
        }
    } else if (t === "ExportDeclaration") {
        if (node.declaration) {
            collectLocalDeclarations(node.declaration, vars);
        }
        if (node.specifiers) {
            for (let i = 0; i < node.specifiers.length; i++) {
                const spec = node.specifiers[i];
                if (spec.exported && spec.exported.type === "Identifier") {
                    vars[spec.exported.name] = true;
                }
            }
        }
    } else if (t === "BlockStatement") {
        const body = node.body || [];
        for (let i = 0; i < body.length; i++) {
            collectLocalDeclarations(body[i], vars);
        }
    } else if (t === "IfStatement") {
        collectLocalDeclarations(node.consequent, vars);
        if (node.alternate) {
            collectLocalDeclarations(node.alternate, vars);
        }
    } else if (t === "WhileStatement" || t === "DoWhileStatement") {
        collectLocalDeclarations(node.body, vars);
    } else if (t === "ForStatement") {
        if (node.init) {
            collectLocalDeclarations(node.init, vars);
        }
        collectLocalDeclarations(node.body, vars);
    } else if (t === "ForInStatement" || t === "ForOfStatement") {
        if (node.left && node.left.type === "VariableDeclaration") {
            collectLocalDeclarations(node.left, vars);
        }
        collectLocalDeclarations(node.body, vars);
    } else if (t === "TryStatement") {
        collectLocalDeclarations(node.block, vars);
        if (node.handler) {
            if (node.handler.param && node.handler.param.type === "Identifier") {
                vars[node.handler.param.name] = true;
            }
            collectLocalDeclarations(node.handler.body, vars);
        }
        if (node.finalizer) {
            collectLocalDeclarations(node.finalizer, vars);
        }
    } else if (t === "SwitchStatement") {
        const cases = node.cases || [];
        for (let i = 0; i < cases.length; i++) {
            const c = cases[i];
            for (let j = 0; j < c.consequent.length; j++) {
                collectLocalDeclarations(c.consequent[j], vars);
            }
        }
    } else if (t === "WithStatement") {
        // with 体内 var 仍属函数/脚本作用域(ES sloppy),须计入局部表
        collectLocalDeclarations(node.body, vars);
    } else if (t === "LabeledStatement") {
        collectLocalDeclarations(node.body, vars);
    }
}

// 收集函数体内的词法绑定(let/const/块级 function/class),供 sloppy 直接 eval 的
// EvalDeclarationInstantiation 与 !lex: 冲突表(lexEnv ≠ varEnv)。
export function collectLexicalDeclarations(node, out) {
    if (!node) return;

    const t = node.type;
    if (t === "ExpressionStatement" || t === "ReturnStatement" ||
        t === "BreakStatement" || t === "ContinueStatement" ||
        t === "ThrowStatement" || t === "EmptyStatement" ||
        t === "DebuggerStatement") {
        return;
    }

    if (t === "VariableDeclaration") {
        if (node.kind !== "let" && node.kind !== "const") return;
        const decls = node.declarations || [];
        for (let i = 0; i < decls.length; i++) {
            if (decls[i].id) collectPatternNames(decls[i].id, out);
        }
        return;
    }
    if (t === "ClassDeclaration") {
        if (node.id && node.id.name) out[node.id.name] = true;
        return;
    }
    if (t === "FunctionDeclaration") {
        if (node.id && node.id.name) out[node.id.name] = true;
        return;
    }
    if (t === "FunctionExpression" || t === "ArrowFunctionExpression" ||
        t === "ClassExpression") {
        return;
    }
    if (t === "BlockStatement") {
        const body = node.body || [];
        for (let i = 0; i < body.length; i++) collectLexicalDeclarations(body[i], out);
    } else if (t === "IfStatement") {
        collectLexicalDeclarations(node.consequent, out);
        if (node.alternate) collectLexicalDeclarations(node.alternate, out);
    } else if (t === "WhileStatement" || t === "DoWhileStatement") {
        collectLexicalDeclarations(node.body, out);
    } else if (t === "ForStatement") {
        if (node.init) collectLexicalDeclarations(node.init, out);
        collectLexicalDeclarations(node.body, out);
    } else if (t === "ForInStatement" || t === "ForOfStatement") {
        if (node.left && node.left.type === "VariableDeclaration") {
            collectLexicalDeclarations(node.left, out);
        }
        collectLexicalDeclarations(node.body, out);
    } else if (t === "TryStatement") {
        collectLexicalDeclarations(node.block, out);
        if (node.handler) collectLexicalDeclarations(node.handler.body, out);
        if (node.finalizer) collectLexicalDeclarations(node.finalizer, out);
    } else if (t === "SwitchStatement") {
        const cases = node.cases || [];
        for (let i = 0; i < cases.length; i++) {
            const c = cases[i];
            for (let j = 0; j < c.consequent.length; j++) {
                collectLexicalDeclarations(c.consequent[j], out);
            }
        }
    } else if (t === "WithStatement" || t === "LabeledStatement") {
        collectLexicalDeclarations(node.body, out);
    }
}

// let/const/class names only (no FunctionDeclaration). Used for annex-B
// B.3.3 skip: creating `var F` is an Early Error iff F is let/const/class.
export function collectLetConstClassNames(node, out) {
    if (!node) return;

    const t = node.type;
    if (t === "VariableDeclaration") {
        if (node.kind !== "let" && node.kind !== "const") return;
        const decls = node.declarations || [];
        for (let i = 0; i < decls.length; i++) {
            if (decls[i].id) collectPatternNames(decls[i].id, out);
        }
        return;
    }
    if (t === "ClassDeclaration") {
        if (node.id && node.id.name) out[node.id.name] = true;
        return;
    }
    if (t === "FunctionDeclaration" || t === "FunctionExpression" ||
        t === "ArrowFunctionExpression" || t === "ClassExpression") {
        return;
    }
    if (t === "BlockStatement") {
        const body = node.body || [];
        for (let i = 0; i < body.length; i++) collectLetConstClassNames(body[i], out);
    } else if (t === "IfStatement") {
        collectLetConstClassNames(node.consequent, out);
        if (node.alternate) collectLetConstClassNames(node.alternate, out);
    } else if (t === "WhileStatement" || t === "DoWhileStatement") {
        collectLetConstClassNames(node.body, out);
    } else if (t === "ForStatement") {
        if (node.init) collectLetConstClassNames(node.init, out);
        collectLetConstClassNames(node.body, out);
    } else if (t === "ForInStatement" || t === "ForOfStatement") {
        if (node.left && node.left.type === "VariableDeclaration") {
            collectLetConstClassNames(node.left, out);
        }
        collectLetConstClassNames(node.body, out);
    } else if (t === "TryStatement") {
        collectLetConstClassNames(node.block, out);
        if (node.handler) collectLetConstClassNames(node.handler.body, out);
        if (node.finalizer) collectLetConstClassNames(node.finalizer, out);
    } else if (t === "SwitchStatement") {
        const cases = node.cases || [];
        for (let i = 0; i < cases.length; i++) {
            const c = cases[i];
            for (let j = 0; j < c.consequent.length; j++) {
                collectLetConstClassNames(c.consequent[j], out);
            }
        }
    } else if (t === "WithStatement" || t === "LabeledStatement") {
        collectLetConstClassNames(node.body, out);
    }
}

function collectEvalVarNamesFromSource(src, out) {
    if (typeof src !== "string" || src.length === 0) return;
    // 等价 /\bvar\s+(id(,id)*)/ 的手写扫描。禁止正则字面量：lang/ 属 toolchain，
    // 自举跳过 __regexp_shim 注入，真实 /re/.exec 会改派到未绑定符号（P0.7）。
    const n = src.length;
    let i = 0;
    const isIdStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95;
    const isIdPart = (c) => isIdStart(c) || (c >= 48 && c <= 57);
    while (i < n) {
        // 找词边界上的 var
        if (src.charCodeAt(i) === 118 && i + 3 <= n &&
            src.charCodeAt(i + 1) === 97 && src.charCodeAt(i + 2) === 114) {
            const before = i > 0 ? src.charCodeAt(i - 1) : 0;
            const after = i + 3 < n ? src.charCodeAt(i + 3) : 0;
            if (!isIdPart(before) && !isIdPart(after)) {
                let j = i + 3;
                // \s+
                while (j < n) {
                    const c = src.charCodeAt(j);
                    if (c === 32 || c === 9 || c === 10 || c === 13) j++;
                    else break;
                }
                // id(,id)*
                while (j < n && isIdStart(src.charCodeAt(j))) {
                    let k = j;
                    while (k < n && isIdPart(src.charCodeAt(k))) k++;
                    const name = src.slice(j, k);
                    if (name.length > 0) out[name] = true;
                    j = k;
                    let s = j;
                    while (j < n) {
                        const c = src.charCodeAt(j);
                        if (c === 32 || c === 9 || c === 10 || c === 13) j++;
                        else break;
                    }
                    if (j < n && src.charCodeAt(j) === 44) { // ','
                        j++;
                        while (j < n) {
                            const c = src.charCodeAt(j);
                            if (c === 32 || c === 9 || c === 10 || c === 13) j++;
                            else break;
                        }
                        continue;
                    }
                    void s;
                    break;
                }
                i = j > i ? j : i + 3;
                continue;
            }
        }
        i++;
    }
}

function collectEvalVarNamesFromNode(node, out) {
    if (!node || typeof node !== "object") return;
    const t = node.type;
    if (t === "CallExpression" && node.callee &&
        node.callee.type === "Identifier" && node.callee.name === "eval" &&
        node.arguments && node.arguments[0] &&
        node.arguments[0].type === "Literal" &&
        typeof node.arguments[0].value === "string") {
        collectEvalVarNamesFromSource(node.arguments[0].value, out);
    }
    if (t === "FunctionExpression" || t === "ArrowFunctionExpression" ||
        t === "FunctionDeclaration") {
        return;
    }
    for (const key in node) {
        if (skipAstKey(key)) continue;
        const child = node[key];
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) collectEvalVarNamesFromNode(child[i], out);
        } else if (child && typeof child === "object") {
            collectEvalVarNamesFromNode(child, out);
        }
    }
}

function collectParamEvalVarNamesFromPattern(pat, out) {
    if (!pat) return;
    if (pat.type === "AssignmentPattern") {
        collectEvalVarNamesFromNode(pat.right, out);
        collectParamEvalVarNamesFromPattern(pat.left, out);
    } else if (pat.type === "ObjectPattern") {
        const props = pat.properties || [];
        for (let i = 0; i < props.length; i++) {
            const prop = props[i];
            if (prop.type === "Property" && prop.value) {
                collectParamEvalVarNamesFromPattern(prop.value, out);
            } else if (prop.type === "RestElement") {
                collectParamEvalVarNamesFromPattern(prop.argument, out);
            }
        }
    } else if (pat.type === "ArrayPattern") {
        const elts = pat.elements || [];
        for (let i = 0; i < elts.length; i++) {
            if (elts[i]) collectParamEvalVarNamesFromPattern(elts[i], out);
        }
    } else if (pat.type === "RestElement") {
        collectParamEvalVarNamesFromPattern(pat.argument, out);
    }
}

function collectParamEvalVarNamesFromParam(p, out) {
    if (!p) return;
    if (p.type === "AssignmentPattern") {
        collectEvalVarNamesFromNode(p.right, out);
        collectParamEvalVarNamesFromPattern(p.left, out);
    } else if (p.type === "SpreadElement") {
        collectParamEvalVarNamesFromPattern(p.argument, out);
    } else if (p.type === "ObjectPattern" || p.type === "ArrayPattern") {
        collectParamEvalVarNamesFromPattern(p, out);
    }
}

// 形参默认值里 direct eval('var …') 静态可提取的 var 名(Annex B 参数 eval 环境)。
export function collectParamEvalVarNames(params) {
    const out = {};
    if (!params) return out;
    for (let i = 0; i < params.length; i++) {
        collectParamEvalVarNamesFromParam(params[i], out);
    }
    return out;
}

// 函数体内 direct eval('var …') 静态可提取的 var 名(S11.13.2 复合赋值 LHS
// 仍写捕获格,eval 后读走独立 var 槽)。
export function collectBodyEvalVarNames(body) {
    const out = {};
    if (body) collectEvalVarNamesFromNode(body, out);
    return out;
}

// True if a direct eval('var name') appears in this subtree (not nested functions).
export function nodeEvalDeclaresVar(node, name) {
    if (!name) return false;
    const out = {};
    collectEvalVarNamesFromNode(node, out);
    return out[name] === true;
}

// 仅收集 `var` 绑定名(不含 let/const)。用于作用域入口初始化为 undefined
// (ES: var 提升且在进入 VariableEnvironment 时创绑定=undefined;未执行到声明语句
// 的赋值前读应得 undefined,而非栈槽垃圾)。不进入嵌套函数。
export function collectVarDeclarations(node, vars) {
    if (!node) return;

    const t = node.type;
    // 同 collectLocalDeclarations：表达式语句等无 var 绑定
    if (t === "ExpressionStatement" || t === "ReturnStatement" ||
        t === "BreakStatement" || t === "ContinueStatement" ||
        t === "ThrowStatement" || t === "EmptyStatement" ||
        t === "DebuggerStatement") {
        return;
    }

    if (t === "VariableDeclaration") {
        if (node.kind && node.kind !== "var") return; // let/const → TDZ,不在此初始化
        const decls = node.declarations || [];
        for (let i = 0; i < decls.length; i++) {
            if (decls[i].id) collectPatternNames(decls[i].id, vars);
        }
        return;
    }
    // 不进入嵌套函数(其有独立 VariableEnvironment)
    if (t === "FunctionExpression" || t === "ArrowFunctionExpression" ||
        t === "FunctionDeclaration" || t === "ClassDeclaration" ||
        t === "ClassExpression") {
        return;
    }
    if (t === "BlockStatement") {
        const body = node.body || [];
        for (let i = 0; i < body.length; i++) collectVarDeclarations(body[i], vars);
    } else if (t === "IfStatement") {
        collectVarDeclarations(node.consequent, vars);
        if (node.alternate) collectVarDeclarations(node.alternate, vars);
    } else if (t === "WhileStatement" || t === "DoWhileStatement") {
        collectVarDeclarations(node.body, vars);
    } else if (t === "ForStatement") {
        if (node.init) collectVarDeclarations(node.init, vars);
        collectVarDeclarations(node.body, vars);
    } else if (t === "ForInStatement" || t === "ForOfStatement") {
        if (node.left && node.left.type === "VariableDeclaration") {
            collectVarDeclarations(node.left, vars);
        }
        collectVarDeclarations(node.body, vars);
    } else if (t === "TryStatement") {
        collectVarDeclarations(node.block, vars);
        if (node.handler) {
            // B.3.5: `var F` inside catch does not create a function-scoped
            // binding when F is the catch parameter — it assigns to that
            // binding. Exclude those names from hoisting.
            const catchSkip = {};
            if (node.handler.param) {
                if (node.handler.param.type === "Identifier") {
                    catchSkip[node.handler.param.name] = true;
                } else {
                    collectPatternNames(node.handler.param, catchSkip);
                }
            }
            const catchVars = {};
            collectVarDeclarations(node.handler.body, catchVars);
            for (const n in catchVars) {
                if (Object.prototype.hasOwnProperty.call(catchVars, n) && catchSkip[n] !== true) {
                    vars[n] = true;
                }
            }
        }
        if (node.finalizer) collectVarDeclarations(node.finalizer, vars);
    } else if (t === "SwitchStatement") {
        const cases = node.cases || [];
        for (let i = 0; i < cases.length; i++) {
            const c = cases[i];
            for (let j = 0; j < c.consequent.length; j++) {
                collectVarDeclarations(c.consequent[j], vars);
            }
        }
    } else if (node.type === "WithStatement" || node.type === "LabeledStatement") {
        collectVarDeclarations(node.body, vars);
    }
}

// 收集引用的变量
export function collectReferencedVariables(node, referenced) {
    if (!node) return;

    const cached = node._rv;
    if (cached && analysisCacheValid(node, "_rvG")) {
        copyRefNames(cached, referenced);
        return;
    }

    if (node.type === "Identifier") {
        referenced[node.name] = true;
        return;
    }

    if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration") {
        return;
    }

    const mine = {};
    collectReferencedVariablesFill(node, mine);
    node._rv = mine;
    node._rvG = ANALYSIS_CACHE_GEN;
    copyRefNames(mine, referenced);
}

function collectReferencedVariablesFill(node, referenced) {
    if (!node) return;

    const cached = node._rv;
    if (cached && analysisCacheValid(node, "_rvG")) {
        copyRefNames(cached, referenced);
        return;
    }

    // Identifier 快判:首字母 I + 第二字母 d（排除 If*/Import*）；无 type 则下钻
    const nt = node.type;
    if (nt && nt.charCodeAt(0) === 73 && nt.charCodeAt(1) === 100) {
        referenced[node.name] = true;
        return;
    }

    if (nt === "FunctionExpression" || nt === "ArrowFunctionExpression" || nt === "FunctionDeclaration") {
        return;
    }

    if (nt === "MemberExpression" && !node.computed) {
        collectReferencedVariablesFill(node.object, referenced);
        return;
    }

    if (nt === "Property" && !node.computed) {
        collectReferencedVariablesFill(node.value, referenced);
        return;
    }

    // 类型化下钻:直接递归,勿箭头回调(gen1 上每次调用税很重)
    const t = nt;
    if (t === "Identifier" || t === "Literal" || t === "ThisExpression" ||
        t === "Super" || t === "EmptyStatement" || t === "DebuggerStatement" ||
        t === "PrivateIdentifier" || t === "TemplateElement" || t === "MetaProperty") {
        return;
    }
    if (t === "MemberExpression") {
        collectReferencedVariablesFill(node.object, referenced);
        collectReferencedVariablesFill(node.property, referenced);
        return;
    }
    if (t === "CallExpression" || t === "NewExpression") {
        collectReferencedVariablesFill(node.callee, referenced);
        const args = node.arguments;
        if (args) for (let i = 0; i < args.length; i++) collectReferencedVariablesFill(args[i], referenced);
        return;
    }
    if (t === "BinaryExpression" || t === "LogicalExpression" || t === "AssignmentExpression") {
        collectReferencedVariablesFill(node.left, referenced);
        collectReferencedVariablesFill(node.right, referenced);
        return;
    }
    if (t === "UnaryExpression" || t === "UpdateExpression" ||
        t === "YieldExpression" || t === "AwaitExpression" ||
        t === "SpreadElement" || t === "RestElement" || t === "ThrowStatement") {
        collectReferencedVariablesFill(node.argument, referenced);
        return;
    }
    if (t === "ExpressionStatement") {
        collectReferencedVariablesFill(node.expression, referenced);
        return;
    }
    if (t === "VariableDeclarator") {
        collectReferencedVariablesFill(node.id, referenced);
        collectReferencedVariablesFill(node.init, referenced);
        return;
    }
    if (t === "VariableDeclaration") {
        const decls = node.declarations;
        if (decls) for (let i = 0; i < decls.length; i++) collectReferencedVariablesFill(decls[i], referenced);
        return;
    }
    if (t === "Property" || t === "PropertyDefinition" || t === "MethodDefinition") {
        collectReferencedVariablesFill(node.key, referenced);
        collectReferencedVariablesFill(node.value, referenced);
        return;
    }
    if (t === "BlockStatement" || t === "Program" || t === "ClassBody") {
        const body = node.body;
        if (body) for (let i = 0; i < body.length; i++) collectReferencedVariablesFill(body[i], referenced);
        return;
    }
    if (t === "IfStatement") {
        collectReferencedVariablesFill(node.test, referenced);
        collectReferencedVariablesFill(node.consequent, referenced);
        collectReferencedVariablesFill(node.alternate, referenced);
        return;
    }
    if (t === "ReturnStatement") {
        collectReferencedVariablesFill(node.argument, referenced);
        return;
    }
    if (t === "ArrayExpression" || t === "ArrayPattern") {
        const els = node.elements;
        if (els) for (let i = 0; i < els.length; i++) collectReferencedVariablesFill(els[i], referenced);
        return;
    }
    if (t === "ObjectExpression" || t === "ObjectPattern") {
        const props = node.properties;
        if (props) for (let i = 0; i < props.length; i++) collectReferencedVariablesFill(props[i], referenced);
        return;
    }
    if (t === "ConditionalExpression") {
        collectReferencedVariablesFill(node.test, referenced);
        collectReferencedVariablesFill(node.consequent, referenced);
        collectReferencedVariablesFill(node.alternate, referenced);
        return;
    }
    if (t === "SequenceExpression") {
        const exprs = node.expressions;
        if (exprs) for (let i = 0; i < exprs.length; i++) collectReferencedVariablesFill(exprs[i], referenced);
        return;
    }
    if (t === "TemplateLiteral") {
        const exprs = node.expressions;
        if (exprs) for (let i = 0; i < exprs.length; i++) collectReferencedVariablesFill(exprs[i], referenced);
        return;
    }
    if (t === "AssignmentPattern") {
        collectReferencedVariablesFill(node.left, referenced);
        collectReferencedVariablesFill(node.right, referenced);
        return;
    }
    if (t === "ForStatement") {
        collectReferencedVariablesFill(node.init, referenced);
        collectReferencedVariablesFill(node.test, referenced);
        collectReferencedVariablesFill(node.update, referenced);
        collectReferencedVariablesFill(node.body, referenced);
        return;
    }
    if (t === "ForInStatement" || t === "ForOfStatement") {
        collectReferencedVariablesFill(node.left, referenced);
        collectReferencedVariablesFill(node.right, referenced);
        collectReferencedVariablesFill(node.body, referenced);
        return;
    }
    if (t === "WhileStatement" || t === "DoWhileStatement") {
        collectReferencedVariablesFill(node.test, referenced);
        collectReferencedVariablesFill(node.body, referenced);
        return;
    }
    if (t === "SwitchStatement") {
        collectReferencedVariablesFill(node.discriminant, referenced);
        const cases = node.cases;
        if (cases) for (let i = 0; i < cases.length; i++) collectReferencedVariablesFill(cases[i], referenced);
        return;
    }
    if (t === "SwitchCase") {
        collectReferencedVariablesFill(node.test, referenced);
        const cons = node.consequent;
        if (cons) for (let i = 0; i < cons.length; i++) collectReferencedVariablesFill(cons[i], referenced);
        return;
    }
    if (t === "TryStatement") {
        collectReferencedVariablesFill(node.block, referenced);
        collectReferencedVariablesFill(node.handler, referenced);
        collectReferencedVariablesFill(node.finalizer, referenced);
        return;
    }
    if (t === "CatchClause") {
        collectReferencedVariablesFill(node.param, referenced);
        collectReferencedVariablesFill(node.body, referenced);
        return;
    }
    if (t === "LabeledStatement") {
        collectReferencedVariablesFill(node.body, referenced);
        return;
    }
    if (t === "ClassDeclaration" || t === "ClassExpression") {
        collectReferencedVariablesFill(node.id, referenced);
        collectReferencedVariablesFill(node.superClass, referenced);
        collectReferencedVariablesFill(node.body, referenced);
        return;
    }
    if (t === "TaggedTemplateExpression") {
        collectReferencedVariablesFill(node.tag, referenced);
        collectReferencedVariablesFill(node.quasi, referenced);
        return;
    }
    if (t === "ChainExpression") {
        collectReferencedVariablesFill(node.expression, referenced);
        return;
    }
    for (const key in node) {
        if (skipAstKey(key)) continue;
        const child = node[key];
        if (!child || typeof child !== "object") continue;
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) collectReferencedVariablesFill(child[i], referenced);
        } else if (typeof child.type === "string") {
            collectReferencedVariablesFill(child, referenced);
        }
    }
}

function functionOuterRefs(node) {
    if (node._or && analysisCacheValid(node, "_orG")) return node._or;
    ensureFunctionNestedIndex(node);

    const nestedParams = {};
    if (node.params) {
        for (let i = 0; i < node.params.length; i++) {
            if (node.params[i].type === "Identifier") {
                nestedParams[node.params[i].name] = true;
            }
        }
    }

    const nestedLocals = {};
    collectLocalDeclarations(node.body, nestedLocals);

    const nestedReferenced = {};
    collectReferencedVariables(node.body, nestedReferenced);

    const hasParamExpr = paramsHaveExpressions(node.params);
    const paramOnlyScope = {};
    for (const name in nestedParams) paramOnlyScope[name] = true;
    const paramReferenced = {};
    if (node.params) {
        for (let i = 0; i < node.params.length; i++) {
            collectReferencedVariables(node.params[i], paramReferenced);
            if (hasParamExpr) {
                collectNestedFunctionReferences(node.params[i], paramReferenced, paramOnlyScope);
            } else {
                collectReferencedVariables(node.params[i], nestedReferenced);
            }
        }
    }

    const nestedLocalScope = {};
    for (const name in nestedParams) nestedLocalScope[name] = true;
    for (const name in nestedLocals) nestedLocalScope[name] = true;
    const nestedFns = node._nf;
    for (let i = 0; i < nestedFns.length; i++) {
        const refs = functionOuterRefs(nestedFns[i]);
        for (const name in refs) {
            if (!flagOwn(nestedLocalScope, name)) {
                nestedReferenced[name] = true;
            }
        }
    }

    const out = {};
    for (const name in nestedReferenced) {
        if (flagOwn(nestedParams, name)) continue;
        if (flagOwn(nestedLocals, name)) continue;
        if (name === "arguments" && node.type !== "ArrowFunctionExpression") continue;
        out[name] = true;
    }
    if (hasParamExpr) {
        for (const name in paramReferenced) {
            if (flagOwn(nestedParams, name)) continue;
            if (name === "arguments" && node.type !== "ArrowFunctionExpression") continue;
            out[name] = true;
        }
    }
    node._or = out;
    node._orG = ANALYSIS_CACHE_GEN;
    return out;
}

export function collectNestedFunctionReferences(node, referenced, localScope) {
    if (!node) return;

    // 本解析器 ClassDeclaration.body 是 MethodDefinition[]（无 ClassBody 包装）。
    // 类型化下钻若遇无 .type 的数组须展开，否则 `!t` 早退会漏掉类方法对外层的捕获
    // （fs.js 的 platform/arch → native「platform is not defined」）。
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
            collectNestedFunctionReferences(node[i], referenced, localScope);
        }
        return;
    }

    if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration") {
        const refs = functionOuterRefs(node);
        for (const name in refs) {
            if (!flagOwn(localScope, name)) {
                referenced[name] = true;
            }
        }
        return;
    }

    // 与 collectReferencedVariablesFill 同形的类型化下钻(勿箭头回调)
    const t = node.type;
    // Identifier / 叶子：早退（自编译图里极多）
    if (!t || (t.charCodeAt(0) === 73 && t.charCodeAt(1) === 100) ||
        t === "Literal" || t === "ThisExpression" ||
        t === "Super" || t === "EmptyStatement" || t === "DebuggerStatement" ||
        t === "PrivateIdentifier" || t === "TemplateElement" || t === "MetaProperty") {
        return;
    }
    if (t === "MemberExpression") {
        collectNestedFunctionReferences(node.object, referenced, localScope);
        collectNestedFunctionReferences(node.property, referenced, localScope);
        return;
    }
    if (t === "CallExpression" || t === "NewExpression") {
        collectNestedFunctionReferences(node.callee, referenced, localScope);
        const args = node.arguments;
        if (args) for (let i = 0; i < args.length; i++) collectNestedFunctionReferences(args[i], referenced, localScope);
        return;
    }
    if (t === "BinaryExpression" || t === "LogicalExpression" || t === "AssignmentExpression") {
        collectNestedFunctionReferences(node.left, referenced, localScope);
        collectNestedFunctionReferences(node.right, referenced, localScope);
        return;
    }
    if (t === "UnaryExpression" || t === "UpdateExpression" ||
        t === "YieldExpression" || t === "AwaitExpression" ||
        t === "SpreadElement" || t === "RestElement" || t === "ThrowStatement") {
        collectNestedFunctionReferences(node.argument, referenced, localScope);
        return;
    }
    if (t === "ExpressionStatement") {
        collectNestedFunctionReferences(node.expression, referenced, localScope);
        return;
    }
    if (t === "VariableDeclarator") {
        collectNestedFunctionReferences(node.id, referenced, localScope);
        collectNestedFunctionReferences(node.init, referenced, localScope);
        return;
    }
    if (t === "VariableDeclaration") {
        const decls = node.declarations;
        if (decls) for (let i = 0; i < decls.length; i++) collectNestedFunctionReferences(decls[i], referenced, localScope);
        return;
    }
    if (t === "Property" || t === "PropertyDefinition" || t === "MethodDefinition") {
        collectNestedFunctionReferences(node.key, referenced, localScope);
        collectNestedFunctionReferences(node.value, referenced, localScope);
        return;
    }
    if (t === "BlockStatement" || t === "Program" || t === "ClassBody") {
        const body = node.body;
        if (body) for (let i = 0; i < body.length; i++) collectNestedFunctionReferences(body[i], referenced, localScope);
        return;
    }
    if (t === "IfStatement") {
        collectNestedFunctionReferences(node.test, referenced, localScope);
        collectNestedFunctionReferences(node.consequent, referenced, localScope);
        collectNestedFunctionReferences(node.alternate, referenced, localScope);
        return;
    }
    if (t === "ReturnStatement") {
        collectNestedFunctionReferences(node.argument, referenced, localScope);
        return;
    }
    if (t === "ArrayExpression" || t === "ArrayPattern") {
        const els = node.elements;
        if (els) for (let i = 0; i < els.length; i++) collectNestedFunctionReferences(els[i], referenced, localScope);
        return;
    }
    if (t === "ObjectExpression" || t === "ObjectPattern") {
        const props = node.properties;
        if (props) for (let i = 0; i < props.length; i++) collectNestedFunctionReferences(props[i], referenced, localScope);
        return;
    }
    if (t === "ConditionalExpression") {
        collectNestedFunctionReferences(node.test, referenced, localScope);
        collectNestedFunctionReferences(node.consequent, referenced, localScope);
        collectNestedFunctionReferences(node.alternate, referenced, localScope);
        return;
    }
    if (t === "SequenceExpression" || t === "TemplateLiteral") {
        const exprs = node.expressions;
        if (exprs) for (let i = 0; i < exprs.length; i++) collectNestedFunctionReferences(exprs[i], referenced, localScope);
        return;
    }
    if (t === "AssignmentPattern") {
        collectNestedFunctionReferences(node.left, referenced, localScope);
        collectNestedFunctionReferences(node.right, referenced, localScope);
        return;
    }
    if (t === "ForStatement") {
        collectNestedFunctionReferences(node.init, referenced, localScope);
        collectNestedFunctionReferences(node.test, referenced, localScope);
        collectNestedFunctionReferences(node.update, referenced, localScope);
        collectNestedFunctionReferences(node.body, referenced, localScope);
        return;
    }
    if (t === "ForInStatement" || t === "ForOfStatement") {
        collectNestedFunctionReferences(node.left, referenced, localScope);
        collectNestedFunctionReferences(node.right, referenced, localScope);
        collectNestedFunctionReferences(node.body, referenced, localScope);
        return;
    }
    if (t === "WhileStatement" || t === "DoWhileStatement") {
        collectNestedFunctionReferences(node.test, referenced, localScope);
        collectNestedFunctionReferences(node.body, referenced, localScope);
        return;
    }
    if (t === "SwitchStatement") {
        collectNestedFunctionReferences(node.discriminant, referenced, localScope);
        const cases = node.cases;
        if (cases) for (let i = 0; i < cases.length; i++) collectNestedFunctionReferences(cases[i], referenced, localScope);
        return;
    }
    if (t === "SwitchCase") {
        collectNestedFunctionReferences(node.test, referenced, localScope);
        const cons = node.consequent;
        if (cons) for (let i = 0; i < cons.length; i++) collectNestedFunctionReferences(cons[i], referenced, localScope);
        return;
    }
    if (t === "TryStatement") {
        collectNestedFunctionReferences(node.block, referenced, localScope);
        collectNestedFunctionReferences(node.handler, referenced, localScope);
        collectNestedFunctionReferences(node.finalizer, referenced, localScope);
        return;
    }
    if (t === "CatchClause") {
        collectNestedFunctionReferences(node.param, referenced, localScope);
        collectNestedFunctionReferences(node.body, referenced, localScope);
        return;
    }
    if (t === "LabeledStatement") {
        collectNestedFunctionReferences(node.body, referenced, localScope);
        return;
    }
    if (t === "ClassDeclaration" || t === "ClassExpression") {
        collectNestedFunctionReferences(node.id, referenced, localScope);
        collectNestedFunctionReferences(node.superClass, referenced, localScope);
        collectNestedFunctionReferences(node.body, referenced, localScope);
        return;
    }
    for (const key in node) {
        if (skipAstKey(key)) continue;
        const child = node[key];
        if (!child || typeof child !== "object") continue;
        if (Array.isArray(child)) {
            for (let i = 0; i < child.length; i++) collectNestedFunctionReferences(child[i], referenced, localScope);
        } else if (typeof child.type === "string") {
            collectNestedFunctionReferences(child, referenced, localScope);
        }
    }
}

// 分析哪些变量需要被共享（被嵌套函数捕获）
export function analyzeSharedVariables(func) {
    // 同函数可被顶层声明 / 闭包体 / 类方法路径多次问及;结果只依赖 AST+缓存代数。
    // 缓存名表(非 Set):调用方常会 add 进返回的 Set(直接 eval 并入),不可共享可变 Set。
    if (func._sv && analysisCacheValid(func, "_svG")) {
        const hit = new Set();
        const list = func._sv;
        for (let i = 0; i < list.length; i++) hit.add(list[i]);
        return hit;
    }
    const sharedVars = new Set();
    ensureFunctionNestedIndex(func);

    // 收集当前函数的局部变量和参数
    const params = func.params || [];
    const localVars = {};

    for (let i = 0; i < params.length; i++) {
        if (params[i].type === "Identifier") {
            localVars[params[i].name] = true;
        }
    }
    collectLocalDeclarations(func.body, localVars);
    collectDirectFunctionDeclNames(func.body, localVars);
    if (func.id && func.id.name) localVars[func.id.name] = true;

    const addClassFieldCaptures = (cls) => {
        const classBody = cls.body && cls.body.body ? cls.body.body : (cls.body || []);
        for (const member of classBody) {
            if (member.type === "PropertyDefinition" && member.value) {
                const refs = {};
                collectReferencedVariables(member.value, refs);
                for (const name in refs) {
                    if (flagOwn(localVars, name)) {
                        sharedVars.add(name);
                    }
                }
            }
        }
    };

    const nestedFns = func._nf;
    for (let i = 0; i < nestedFns.length; i++) {
        const captured = analyzeCapturedVariables(nestedFns[i], localVars, null);
        for (const name of captured) sharedVars.add(name);
    }
    const classes = func._cc;
    if (classes) {
        for (let i = 0; i < classes.length; i++) {
            addClassFieldCaptures(classes[i]);
            // 类构造器/方法是词法嵌套函数,但 ensureFunctionNestedIndex 只把类
            // 推进 _cc、不进 _nf。漏分析则 for (let x of …) { class C { constructor(){ x } } }
            // 的循环绑定不入 boxedVars → 构造器读到未捕获槽(NaN)。
            const captured = analyzeCapturedVariables(classes[i], localVars, null);
            for (let j = 0; j < captured.length; j++) sharedVars.add(captured[j]);
        }
    }
    const saved = [];
    for (const name of sharedVars) saved.push(name);
    func._sv = saved;
    func._svG = ANALYSIS_CACHE_GEN;
    return sharedVars;
}

// 直接 eval 词法捕获的调用者帧模型。含直接 `eval (...)` 调用的函数,其局部变量可能被
// eval 片段内**逃逸**的闭包捕获(`function f(){let x=10; let g=eval ("(function(){return x})"); x=20; return g()}`
// —— node 返 20,朴素模型返 10)。调用者编译期看不见该捕获(片段源码是运行时字符串),
// 故其局部槽默认是普通值槽:eval 后的 `x=20` 只写值槽、不触片段闭包共享的 box → 逃逸
// 闭包读到 copy-out 时的陈旧快照。解法(保守):含直接 eval 的函数,把**全部**可 copy-in
// 的局部/参数升级为 box,使调用者槽与片段闭包共享同一 cell(调用点 layout `:b` 标志 +
// engine/compile.js copy-in 复用调用者 box、copy-out 免回灌)。编译器自身源码无直接
// eval → 自举永不触发 → gate 零影响(byte-identical)。
// 只看**本函数体直属**的 eval:嵌套函数体内的 eval 捕获的是那个嵌套函数的帧,由其自身
// 的 boxedVars 分析处理,故扫描到嵌套函数即止。
export function functionBodyHasDirectEval(node) {
    if (!node || typeof node !== "object") return false;
    if (node._he === 1) return true;
    if (node._he === 0) return false;
    let hit = false;
    if (node.type === "CallExpression" && node.callee &&
        node.callee.type === "Identifier" && node.callee.name === "eval") {
        hit = true;
    } else if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration") {
        hit = false;
    } else {
        for (const key in node) {
            if (skipAstKey(key)) continue;
            const child = node[key];
            if (child && typeof child === "object") {
                if (Array.isArray(child)) {
                    for (let i = 0; i < child.length; i++) {
                        if (functionBodyHasDirectEval(child[i])) { hit = true; break; }
                    }
                } else if (functionBodyHasDirectEval(child)) {
                    hit = true;
                }
            }
            if (hit) break;
        }
    }
    node._he = hit ? 1 : 0;
    return hit;
}

// 返回含直接 eval 的函数须升级为 box 的全部局部/参数名集合(否则空集)。
export function analyzeDirectEvalBoxedVars(func) {
    const out = new Set();
    if (!func) return out;
    ensureFunctionNestedIndex(func);
    let hasEval = functionBodyHasDirectEval(func.body);
    if (!hasEval && func.params) {
        for (let i = 0; i < func.params.length; i++) {
            if (functionBodyHasDirectEval(func.params[i])) { hasEval = true; break; }
        }
    }
    if (!hasEval) return out;
    const localVars = {};
    const params = func.params || [];
    for (let i = 0; i < params.length; i++) collectPatternNames(params[i], localVars);
    collectLocalDeclarations(func.body, localVars);
    collectDirectFunctionDeclNames(func.body, localVars);
    for (const name in localVars) out.add(name);
    return out;
}

// 分析程序顶层：哪些变量会被顶层函数声明捕获
// 这与 analyzeSharedVariables 不同，因为顶层函数声明是在主程序作用域外定义的
// 但它们可以访问主程序中的变量
export function analyzeTopLevelSharedVariables(ast) {
    const sharedVars = new Set();

    // 收集主程序中的局部变量（非函数声明语句）
    const mainLocalVars = {};
    for (const stmt of ast.body) {
        if (stmt.type !== "FunctionDeclaration") {
            collectLocalDeclarations(stmt, mainLocalVars);
        }
    }

    // 分析每个顶层函数/类声明捕获了哪些主程序变量
    for (const stmt of ast.body) {
        let decl = stmt;
        if (stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration" || stmt.type === "ExportDeclaration") {
            decl = stmt.declaration;
        }

        if (decl && (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration")) {
            const captured = analyzeCapturedVariables(decl, mainLocalVars, null);
            if (captured.length > 0) {
            }
            for (const name of captured) {
                sharedVars.add(name);
            }
        }
    }
    return sharedVars;
}

// 类字段 `eval('outer = 1')` 等:源码里外层名藏在字符串里,analyzeCapturedVariables
// 扫不到。解析直接 eval 的字面量实参,收集可引用外层词法的标识符(跳过嵌套函数体)。
export function collectDirectEvalSourceRefs(node) {
    const out = [];
    const seen = {};
    const add = (name) => {
        if (!name || isBuiltinOrGlobal(name)) return;
        if (seen[name]) return;
        seen[name] = true;
        out.push(name);
    };
    // `collectReferencedVariables` is deliberately not used here:declaration ids in
    // eval source are bindings,not references to the caller.  This walker keeps
    // those binding positions out while covering expressions nested under all
    // statement kinds (`while (outer) ...` was previously missed).
    const walkSourceNode = (n) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) {
            for (let i = 0; i < n.length; i++) walkSourceNode(n[i]);
            return;
        }
        const t = n.type;
        if (t === "Identifier") { add(n.name); return; }
        // Direct eval inherits the caller's ThisBinding.  The compiler models
        // that binding in the synthetic __this local, so expose it to the
        // capture-layout builder when eval source contains `this`.
        if (t === "ThisExpression") { add("__this"); return; }
        if (t === "FunctionDeclaration" || t === "FunctionExpression" ||
            t === "ClassDeclaration" || t === "ClassExpression") return;
        // Arrows inherit the eval caller's ThisBinding / Super. Walk their
        // bodies so `eval("()=>this")` captures __this.
        if (t === "ArrowFunctionExpression") {
            walkSourceNode(n.body);
            return;
        }
        if (t === "VariableDeclarator") {
            if (n.init) walkSourceNode(n.init);
            return;
        }
        if (t === "MemberExpression" && !n.computed) {
            walkSourceNode(n.object);
            return;
        }
        if ((t === "Property" || t === "PropertyDefinition" ||
            t === "MethodDefinition") && !n.computed) {
            // Accessor functions created by a direct-eval object literal are
            // still closures over the caller's lexical environment.  Their
            // bodies are represented as FunctionExpression nodes, so the
            // generic function early-return below would otherwise hide names
            // such as `s2` assigned by a setter.  Traverse only accessor
            // bodies here; ordinary nested functions keep the historical
            // declaration-shadowing behavior of this conservative walker.
            if ((n.kind === "get" || n.kind === "set") && n.value &&
                (n.value.type === "FunctionExpression" ||
                 n.value.type === "ArrowFunctionExpression" ||
                 n.value.type === "FunctionDeclaration")) {
                walkSourceNode(n.value.body);
            } else {
                walkSourceNode(n.value);
            }
            return;
        }
        if (t === "LabeledStatement") {
            walkSourceNode(n.body);
            return;
        }
        if (t === "BreakStatement" || t === "ContinueStatement" ||
            t === "MetaProperty") return;
        if (t === "CatchClause") {
            walkSourceNode(n.body);
            return;
        }
        if (t === "CallExpression" && n.callee && n.callee.type === "Identifier" &&
            n.callee.name === "eval" && n.arguments && n.arguments[0]) {
            const arg = n.arguments[0];
            let src = null;
            if ((arg.type === "Literal" || arg.type === "StringLiteral") &&
                typeof arg.value === "string") src = arg.value;
            if (src) {
                try {
                    const prog = parse(src);
                    if (prog) walkSourceNode(prog);
                } catch (_e) { /* 非法 eval 源码:运行时再抛 */ }
            }
        }
        for (const k in n) {
            if (skipAstKey(k)) continue;
            const v = n[k];
            if (!v || typeof v !== "object") continue;
            walkSourceNode(v);
        }
    };
    walkSourceNode(node);
    return out;
}
