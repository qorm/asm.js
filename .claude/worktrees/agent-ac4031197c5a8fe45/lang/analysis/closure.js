// asm.js - 闭包分析模块
// 分析函数表达式中捕获的外部变量

// 检查是否是内置函数或全局对象
export function isBuiltinOrGlobal(name) {
    const builtins = ["print", "console", "Promise", "Uint8Array", "Buffer", "Math", "sleep", "Array", "Object", "String", "Number", "Boolean", "Date", "RegExp", "JSON", "Error", "undefined", "null", "NaN", "Infinity", "globalThis", "queueMicrotask", "__asmjs_setTimeout", "__asmjs_setImmediate", "__asmjs_queueMicrotask", "__asmjs_clearTimer"];
    return builtins.includes(name);
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

// 分析函数表达式中捕获的外部变量
// 返回需要捕获的变量名数组
export function analyzeCapturedVariables(funcExpr, outerLocals, functions) {
    const params = funcExpr.params || [];
    const paramNames = {};
    for (let i = 0; i < params.length; i++) {
        collectPatternNames(params[i], paramNames);
    }

    // 收集函数体中声明的局部变量
    const localVars = {};
    collectLocalDeclarations(funcExpr.body, localVars);

    // 收集所有引用的变量
    const referenced = {};
    collectReferencedVariables(funcExpr.body, referenced);
    // 参数默认值/计算键中引用的外层变量也需捕获(({x=a})=>x 捕获外层 a)。
    // pattern 自身的绑定名会一并混入 referenced,但下方按 paramNames 过滤掉。
    for (let i = 0; i < params.length; i++) {
        collectReferencedVariables(params[i], referenced);
    }

    // 递归收集嵌套函数需要的外部变量
    collectNestedFunctionReferences(funcExpr.body, referenced, { ...paramNames, ...localVars });

    // 找出需要捕获的变量
    const captured = [];
    for (const name in referenced) {
        // 跳过参数和局部变量
        if (paramNames[name]) continue;
        if (localVars[name]) continue;
        // 跳过全局函数和内置函数
        if (functions && functions[name]) continue;
        if (isBuiltinOrGlobal(name)) continue;

        // 检查是否在外部作用域中
        if (outerLocals && outerLocals[name]) {
            captured.push(name);
        }
    }

    return captured;
}

// 收集函数体中声明的局部变量
export function collectLocalDeclarations(node, vars) {
    if (!node) return;

    if (node.type === "VariableDeclaration") {
        const decls = node.declarations || [];
        for (let i = 0; i < decls.length; i++) {
            if (decls[i].id) {
                if (decls[i].id.type === "Identifier") {
                    vars[decls[i].id.name] = true;
                }
            }
        }
    } else if (node.type === "ImportDeclaration") {
        const specs = node.specifiers || [];
        for (let i = 0; i < specs.length; i++) {
            if (specs[i].local && specs[i].local.type === "Identifier") {
                vars[specs[i].local.name] = true;
            }
        }
    } else if (node.type === "ExportDeclaration") {
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
    } else if (node.type === "BlockStatement") {
        const body = node.body || [];
        for (let i = 0; i < body.length; i++) {
            collectLocalDeclarations(body[i], vars);
        }
    } else if (node.type === "IfStatement") {
        collectLocalDeclarations(node.consequent, vars);
        if (node.alternate) {
            collectLocalDeclarations(node.alternate, vars);
        }
    } else if (node.type === "WhileStatement" || node.type === "DoWhileStatement") {
        collectLocalDeclarations(node.body, vars);
    } else if (node.type === "ForStatement") {
        if (node.init) {
            collectLocalDeclarations(node.init, vars);
        }
        collectLocalDeclarations(node.body, vars);
    } else if (node.type === "ForInStatement" || node.type === "ForOfStatement") {
        if (node.left && node.left.type === "VariableDeclaration") {
            collectLocalDeclarations(node.left, vars);
        }
        collectLocalDeclarations(node.body, vars);
    } else if (node.type === "TryStatement") {
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
    } else if (node.type === "SwitchStatement") {
        const cases = node.cases || [];
        for (let i = 0; i < cases.length; i++) {
            const c = cases[i];
            for (let j = 0; j < c.consequent.length; j++) {
                collectLocalDeclarations(c.consequent[j], vars);
            }
        }
    }
}

// 收集引用的变量
export function collectReferencedVariables(node, referenced) {
    if (!node) return;

    if (node.type === "Identifier") {
        referenced[node.name] = true;
        return;
    }

    // 不进入嵌套函数
    if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration") {
        return;
    }

    // 对象属性的 key 不算引用
    if (node.type === "MemberExpression" && !node.computed) {
        collectReferencedVariables(node.object, referenced);
        return;
    }

    if (node.type === "Property" && !node.computed) {
        collectReferencedVariables(node.value, referenced);
        return;
    }

    // 递归遍历子节点
    for (const key in node) {
        if (key === "type" || key === "loc" || key === "range" || key === "start" || key === "end") continue;
        const child = node[key];
        if (child && typeof child === "object") {
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    if (child[i] && typeof child[i] === "object") {
                        collectReferencedVariables(child[i], referenced);
                    }
                }
            } else {
                collectReferencedVariables(child, referenced);
            }
        }
    }
}

// 递归收集嵌套函数中引用的外部变量
export function collectNestedFunctionReferences(node, referenced, localScope) {
    if (!node) return;

    if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration") {
        // 对于嵌套函数，收集它引用但不在它自己局部作用域中的变量
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
        // 嵌套函数参数默认值中引用的更外层变量也需上抛捕获。
        if (node.params) {
            for (let i = 0; i < node.params.length; i++) {
                collectReferencedVariables(node.params[i], nestedReferenced);
            }
        }

        // 递归处理更深层的嵌套
        const nestedLocalScope = { ...nestedParams, ...nestedLocals };
        collectNestedFunctionReferences(node.body, nestedReferenced, nestedLocalScope);

        // 找出嵌套函数引用但不在它自己作用域中的变量
        for (const name in nestedReferenced) {
            if (nestedParams[name]) continue;
            if (nestedLocals[name]) continue;
            // 如果这个变量也不在当前函数的局部作用域中，说明它需要从更外层捕获
            if (!localScope[name]) {
                referenced[name] = true;
            }
        }
        return; // 不继续遍历函数体
    }

    // 递归遍历子节点
    for (const key in node) {
        if (key === "type" || key === "loc" || key === "range") continue;
        const child = node[key];
        if (child && typeof child === "object") {
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    collectNestedFunctionReferences(child[i], referenced, localScope);
                }
            } else {
                collectNestedFunctionReferences(child, referenced, localScope);
            }
        }
    }
}

// 分析哪些变量需要被共享（被嵌套函数捕获）
export function analyzeSharedVariables(func) {
    const sharedVars = new Set();

    // 收集当前函数的局部变量和参数
    const params = func.params || [];
    const localVars = {};

    for (let i = 0; i < params.length; i++) {
        if (params[i].type === "Identifier") {
            localVars[params[i].name] = true;
        }
    }
    collectLocalDeclarations(func.body, localVars);

    // 遍历函数体，查找嵌套函数（表达式和声明）
    function visit(node) {
        if (!node) return;

        if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration") {
            // 分析这个嵌套函数捕获了哪些变量
            const captured = analyzeCapturedVariables(node, localVars, null);
            for (const name of captured) {
                sharedVars.add(name);
            }
            return; // 不继续深入嵌套函数
        }

        for (const key in node) {
            if (key === "type" || key === "loc" || key === "range") continue;
            const child = node[key];
            if (child && typeof child === "object") {
                if (Array.isArray(child)) {
                    for (let i = 0; i < child.length; i++) {
                        visit(child[i]);
                    }
                } else {
                    visit(child);
                }
            }
        }
    }

    visit(func.body);
    return sharedVars;
}

// 直接 eval 词法捕获的调用者帧模型。含直接 `eval(...)` 调用的函数,其局部变量可能被
// eval 片段内**逃逸**的闭包捕获(`function f(){let x=10; let g=eval("(function(){return x})"); x=20; return g()}`
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
    if (node.type === "CallExpression" && node.callee &&
        node.callee.type === "Identifier" && node.callee.name === "eval") {
        return true;
    }
    if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration") {
        return false; // 不下潜嵌套函数
    }
    for (const key in node) {
        if (key === "type" || key === "loc" || key === "range" || key === "start" || key === "end") continue;
        const child = node[key];
        if (child && typeof child === "object") {
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    if (functionBodyHasDirectEval(child[i])) return true;
                }
            } else if (functionBodyHasDirectEval(child)) return true;
        }
    }
    return false;
}

// 返回含直接 eval 的函数须升级为 box 的全部局部/参数名集合(否则空集)。
export function analyzeDirectEvalBoxedVars(func) {
    const out = new Set();
    if (!func || !functionBodyHasDirectEval(func.body)) return out;
    const localVars = {};
    const params = func.params || [];
    for (let i = 0; i < params.length; i++) collectPatternNames(params[i], localVars);
    collectLocalDeclarations(func.body, localVars);
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
