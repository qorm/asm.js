// asm.js - 块级作用域改名(let/const shadowing + TDZ 标记)
//
// 设计:AST 级 alpha-renaming 前置 pass(在 parse 之后、闭包分析/编译之前跑一次)。
// 把「非函数顶层块」里的 let/const 绑定改成全函数唯一的内部名 `name$blk$N`,
// 其所有词法引用(读/写/++/--/解构/闭包体内)同步改名。这样下游一切按名字
// 解析的消费者(ctx.locals / boxedVars / mainCapturedVars / 捕获分析 / 类型
// 推断)天然一致,不需要在每个解析入口插 resolveName —— 改名本身就是统一的
// resolveName,且覆盖面由"引用必是 Identifier 节点"保证,不存在漏点。
//
// TDZ:块入口预扫描直辖 let/const(绑定对整块可见);同块、同函数深度、
// 词法先于声明的引用打 node._tdz = 1 标记并把改名后的名字登记到块节点
// _tdzNames(编译期在块入口分配槽位并写 SENTINEL、读点发守卫;正常顺序
// 代码零守卫税、零槽位预分配 —— 非 TDZ 绑定仍在声明点分配,保持既有
// "闭包先于声明创建时静默跳过捕获"的行为而非引入裸 deref 崩溃)。
//
// gen1-safe:无正则/无解构/无 typed-array 视图;字典键是用户标识符,一律
// 经 bs 记录标记(rec.bs === 1)守卫,挡 node 原型链污染([#32] 铁律);
// `__proto__` 绑定不改名(node 下往字典写该键会改原型,直接跳过)。
// 分隔符用 `$blk$`:用户标识符含 $ 合法,但 `$blk$` 三段式与手写名撞车
// 概率可忽略;`#` 虽不可能出现在用户名里,但为避免任何 label/符号管道
// 对特殊字符的隐含假设,不用。

// 可改名判定:合法字符串且不是 __proto__(见文件头注释)
function bsRenameable(name) {
    return typeof name === "string" && name.length > 0 && name !== "__proto__";
}

function bsNewName(st, name) {
    st.c = st.c + 1;
    return name + "$blk$" + st.c;
}

function bsPushFrame(st) {
    const f = { m: {} };
    st.scopes.push(f);
    return f;
}

function bsPopFrame(st) {
    st.scopes.pop();
}

// [#32] 双语义守卫:合法记录恒为带 bs===1 标记的对象。node 下字典 miss 会
// 沿原型链拿到函数(constructor/toString),asm.js 下返回 raw 0 —— 都判 miss。
function bsFrameGet(frame, name) {
    const rec = frame.m[name];
    if (rec && typeof rec === "object" && rec.bs === 1) return rec;
    return null;
}

function bsLookup(st, name) {
    for (let i = st.scopes.length - 1; i >= 0; i--) {
        const rec = bsFrameGet(st.scopes[i], name);
        if (rec) return rec;
    }
    return null;
}

// 恒等注册:该名字在本帧“可见但不改名”(参数/var/函数顶层 let/函数名/catch 参)
// —— 用于遮挡外层块的改名映射。
function bsRegIdentity(st, frame, name) {
    if (!bsRenameable(name)) return;
    frame.m[name] = { bs: 1, n: null, d: true, f: st.fnDepth, blk: null, t: 0 };
}

// 收集 pattern 里的绑定 Identifier 节点(顺带拆开 shorthand 的 key/value 共享节点,
// key 保持源属性名、value 才是绑定名 —— 否则改 value.name 会连 key 一起改掉)。
function bsPatternIdents(id, out) {
    if (!id) return;
    if (id.type === "Identifier") {
        out.push(id);
        return;
    }
    // [#47] 默认值包装:绑定名在 left(可为 Identifier 或又一层 pattern),递归。
    // right(默认表达式)不是绑定,不收集。
    if (id.type === "AssignmentPattern") {
        bsPatternIdents(id.left, out);
        return;
    }
    if (id.type === "ObjectPattern") {
        const props = id.properties || [];
        for (let i = 0; i < props.length; i++) {
            const p = props[i];
            if (!p) continue;
            // [rest] {a, ...rest}:rest 绑定名收集(改名/TDZ 一致)
            if (p.type === "SpreadElement") {
                if (p.argument && p.argument.type === "Identifier") out.push(p.argument);
                continue;
            }
            if (p.shorthand && p.value === p.key && p.key && p.key.type === "Identifier") {
                p.value = { type: "Identifier", name: p.key.name };
            }
            // [#47] 值位可为 Identifier / 嵌套 pattern / 带默认的任一,递归收集绑定名。
            // key 是属性名不改,只收 value 位。
            bsPatternIdents(p.value, out);
        }
        return;
    }
    if (id.type === "ArrayPattern") {
        const els = id.elements || [];
        for (let i = 0; i < els.length; i++) {
            const el = els[i];
            if (!el) continue;
            if (el.type === "SpreadElement") {
                if (el.argument && el.argument.type === "Identifier") out.push(el.argument);
                continue;
            }
            // [#47] Identifier / 嵌套 pattern / 带默认的任一,递归。
            bsPatternIdents(el, out);
        }
        return;
    }
}

// [C2] 递归走 pattern 里的计算键表达式 {[expr]: t},使其中引用的外层变量按块级改名。
// 计算键在外层作用域求值,不是绑定名——bsPatternIdents 只收绑定不改键,故需单独走。
// 仅计算键(全新特性,编译器源码无计算键 pattern → 不影响 gen1 自编译逐字节定点)。
function bsWalkPatternComputedKeys(pat, st) {
    if (!pat) return;
    const t = pat.type;
    if (t === "AssignmentPattern") { bsWalkPatternComputedKeys(pat.left, st); return; }
    if (t === "ObjectPattern") {
        const props = pat.properties || [];
        for (let i = 0; i < props.length; i++) {
            const p = props[i];
            if (!p) continue;
            if (p.type === "SpreadElement") continue;
            if (p.computed && p.key) bsWalkExpr(p.key, st);
            bsWalkPatternComputedKeys(p.value, st);
        }
        return;
    }
    if (t === "ArrayPattern") {
        const els = pat.elements || [];
        for (let i = 0; i < els.length; i++) bsWalkPatternComputedKeys(els[i], st);
        return;
    }
}

// ============ 函数作用域名字收集(恒等注册) ============
// 进入函数时预注册:参数、全深度 var/int、函数顶层(depth 0)let/const、
// 全深度 function/class 声明名。这些名字遮挡外层块改名映射,自身不改名。
function bsCollectStmtNames(node, st, frame, depth) {
    if (!node) return;
    const t = node.type;
    if (t === "VariableDeclaration") {
        const isLet = node.kind === "let" || node.kind === "const";
        if (!isLet || depth === 0) {
            const decls = node.declarations || [];
            for (let i = 0; i < decls.length; i++) {
                const ids = [];
                bsPatternIdents(decls[i].id, ids);
                for (let j = 0; j < ids.length; j++) bsRegIdentity(st, frame, ids[j].name);
            }
        }
        return;
    }
    if (t === "FunctionDeclaration" || t === "ClassDeclaration") {
        if (node.id && node.id.type === "Identifier") bsRegIdentity(st, frame, node.id.name);
        return; // 不进函数/类体
    }
    if (t === "BlockStatement") {
        const body = node.body || [];
        for (let i = 0; i < body.length; i++) bsCollectStmtNames(body[i], st, frame, depth + 1);
        return;
    }
    if (t === "IfStatement") {
        bsCollectStmtNames(node.consequent, st, frame, depth + 1);
        bsCollectStmtNames(node.alternate, st, frame, depth + 1);
        return;
    }
    if (t === "WhileStatement" || t === "DoWhileStatement" || t === "LabeledStatement") {
        bsCollectStmtNames(node.body, st, frame, depth + 1);
        return;
    }
    if (t === "ForStatement") {
        bsCollectStmtNames(node.init, st, frame, depth + 1);
        bsCollectStmtNames(node.body, st, frame, depth + 1);
        return;
    }
    if (t === "ForInStatement" || t === "ForOfStatement") {
        bsCollectStmtNames(node.left, st, frame, depth + 1);
        bsCollectStmtNames(node.body, st, frame, depth + 1);
        return;
    }
    if (t === "TryStatement") {
        bsCollectStmtNames(node.block, st, frame, depth + 1);
        if (node.handler) bsCollectStmtNames(node.handler.body, st, frame, depth + 1);
        bsCollectStmtNames(node.finalizer, st, frame, depth + 1);
        return;
    }
    if (t === "SwitchStatement") {
        const cases = node.cases || [];
        for (let i = 0; i < cases.length; i++) {
            const cons = cases[i].consequent || [];
            for (let j = 0; j < cons.length; j++) bsCollectStmtNames(cons[j], st, frame, depth + 1);
        }
        return;
    }
    if (t === "ExportDeclaration" || t === "ExportNamedDeclaration" || t === "ExportDefaultDeclaration") {
        if (node.declaration) bsCollectStmtNames(node.declaration, st, frame, depth);
        return;
    }
    if (t === "ImportDeclaration") {
        const specs = node.specifiers || [];
        for (let i = 0; i < specs.length; i++) {
            if (specs[i].local && specs[i].local.type === "Identifier") bsRegIdentity(st, frame, specs[i].local.name);
        }
        return;
    }
}

// ============ 块 prescan:直辖 let/const 建改名映射 ============
// ownerNode:登记 _tdzNames 的宿主(BlockStatement/ForStatement/SwitchStatement)。
// 同时把块级 function/class 声明名恒等注册进块帧,遮挡外层块的改名映射
// (它们按现行编译语义仍是函数级绑定,不改名)。
function bsPrescanLets(ownerNode, stmts, st, frame) {
    for (let i = 0; i < stmts.length; i++) {
        const s = stmts[i];
        if (!s) continue;
        if (s.type === "FunctionDeclaration" || s.type === "ClassDeclaration") {
            if (s.id && s.id.type === "Identifier") bsRegIdentity(st, frame, s.id.name);
            continue;
        }
        if (s.type !== "VariableDeclaration") continue;
        if (s.kind !== "let" && s.kind !== "const") continue;
        const decls = s.declarations || [];
        for (let j = 0; j < decls.length; j++) {
            const ids = [];
            bsPatternIdents(decls[j].id, ids);
            for (let k = 0; k < ids.length; k++) {
                const name = ids[k].name;
                if (!bsRenameable(name)) continue;
                if (bsFrameGet(frame, name)) continue; // 同块重复 let:复用首个映射(偏差:不报错)
                const nn = bsNewName(st, name);
                frame.m[name] = { bs: 1, n: nn, d: false, f: st.fnDepth, blk: ownerNode, t: 0 };
            }
        }
    }
}

// 声明语句:先走 init(此时映射已存在但未 declared → `let x = x` 会命中 TDZ 标记),
// 再改绑定名并置 declared。
function bsHandleVarDecl(node, st) {
    const isLet = node.kind === "let" || node.kind === "const";
    const decls = node.declarations || [];
    for (let i = 0; i < decls.length; i++) {
        const d = decls[i];
        if (d.init) bsWalkExpr(d.init, st);
        bsWalkPatternComputedKeys(d.id, st); // [C2] 计算键引用外层变量,按块级改名
        const ids = [];
        bsPatternIdents(d.id, ids);
        for (let j = 0; j < ids.length; j++) {
            const idn = ids[j];
            if (!isLet) continue; // var/int:函数级,恒等(不改名)
            const rec = bsLookup(st, idn.name);
            if (rec && rec.n) {
                idn.name = rec.n;
                rec.d = true;
            }
        }
    }
}

function bsWalkStmts(list, st) {
    for (let i = 0; i < list.length; i++) bsWalkStmt(list[i], st);
}

function bsWalkBlock(node, st) {
    const frame = bsPushFrame(st);
    const body = node.body || [];
    bsPrescanLets(node, body, st, frame);
    bsWalkStmts(body, st);
    bsPopFrame(st);
}

function bsWalkFor(node, st) {
    bsPushFrame(st);
    const frame = st.scopes[st.scopes.length - 1];
    if (node.init && node.init.type === "VariableDeclaration") {
        if (node.init.kind === "let" || node.init.kind === "const") {
            const one = [node.init];
            bsPrescanLets(node, one, st, frame);
        }
        bsHandleVarDecl(node.init, st);
    } else if (node.init) {
        bsWalkExpr(node.init, st);
    }
    bsWalkExpr(node.test, st);
    bsWalkExpr(node.update, st);
    bsWalkStmt(node.body, st);
    bsPopFrame(st);
}

function bsWalkForEach(node, st) {
    // 迭代对象在外层作用域求值(`for (let x of x)` 的右侧 x 指外层)
    bsWalkExpr(node.right, st);
    const frame = bsPushFrame(st);
    if (node.left && node.left.type === "VariableDeclaration") {
        const isLet = node.left.kind === "let" || node.left.kind === "const";
        const decls = node.left.declarations || [];
        for (let i = 0; i < decls.length; i++) {
            bsWalkPatternComputedKeys(decls[i].id, st); // [C2] 计算键引用外层变量
            const ids = [];
            bsPatternIdents(decls[i].id, ids);
            for (let j = 0; j < ids.length; j++) {
                const idn = ids[j];
                if (isLet && bsRenameable(idn.name)) {
                    const nn = bsNewName(st, idn.name);
                    frame.m[idn.name] = { bs: 1, n: nn, d: true, f: st.fnDepth, blk: null, t: 0 };
                    idn.name = nn;
                } else {
                    bsRegIdentity(st, frame, idn.name);
                }
            }
        }
    } else if (node.left) {
        bsWalkExpr(node.left, st);
    }
    bsWalkStmt(node.body, st);
    bsPopFrame(st);
}

function bsWalkSwitch(node, st) {
    bsWalkExpr(node.discriminant, st);
    const frame = bsPushFrame(st);
    const cases = node.cases || [];
    const all = [];
    for (let i = 0; i < cases.length; i++) {
        const cons = cases[i].consequent || [];
        for (let j = 0; j < cons.length; j++) all.push(cons[j]);
    }
    bsPrescanLets(node, all, st, frame);
    for (let i = 0; i < cases.length; i++) {
        if (cases[i].test) bsWalkExpr(cases[i].test, st);
        bsWalkStmts(cases[i].consequent || [], st);
    }
    bsPopFrame(st);
}

function bsWalkTry(node, st) {
    bsWalkStmt(node.block, st);
    if (node.handler) {
        const frame = bsPushFrame(st);
        if (node.handler.param) {
            // catch 参也是块级绑定:改名成唯一名,修复它与同名函数级变量共享
            // 槽位的别名问题(catch(e) 写穿外层 let e / var e 的槽)。
            const ids = [];
            bsPatternIdents(node.handler.param, ids);
            for (let i = 0; i < ids.length; i++) {
                const idn = ids[i];
                if (bsRenameable(idn.name)) {
                    const nn = bsNewName(st, idn.name);
                    frame.m[idn.name] = { bs: 1, n: nn, d: true, f: st.fnDepth, blk: null, t: 0 };
                    idn.name = nn;
                } else {
                    bsRegIdentity(st, frame, idn.name);
                }
            }
        }
        bsWalkStmt(node.handler.body, st);
        bsPopFrame(st);
    }
    if (node.finalizer) bsWalkStmt(node.finalizer, st);
}

function bsWalkFunction(fn, st) {
    st.fnDepth = st.fnDepth + 1;
    const frame = bsPushFrame(st);
    if (fn.id && fn.id.type === "Identifier") bsRegIdentity(st, frame, fn.id.name);
    const params = fn.params || [];
    for (let i = 0; i < params.length; i++) {
        const p = params[i];
        if (!p) continue;
        const ids = [];
        if (p.type === "Identifier") ids.push(p);
        else if (p.type === "AssignmentPattern" && p.left && p.left.type === "Identifier") ids.push(p.left);
        else if (p.type === "SpreadElement" && p.argument && p.argument.type === "Identifier") ids.push(p.argument);
        else bsPatternIdents(p, ids);
        for (let j = 0; j < ids.length; j++) bsRegIdentity(st, frame, ids[j].name);
    }
    // 默认值表达式按本函数作用域解析(可引用前序参数;外层块 let 引用同样要改名)
    for (let i = 0; i < params.length; i++) {
        const p = params[i];
        if (p && p.type === "AssignmentPattern" && p.right) bsWalkExpr(p.right, st);
    }
    if (fn.body && fn.body.type === "BlockStatement") {
        const body = fn.body.body || [];
        for (let i = 0; i < body.length; i++) bsCollectStmtNames(body[i], st, frame, 0);
        bsWalkStmts(body, st);
    } else if (fn.body) {
        bsWalkExpr(fn.body, st);
    }
    bsPopFrame(st);
    st.fnDepth = st.fnDepth - 1;
}

function bsWalkClass(cls, st) {
    if (cls.superClass) bsWalkExpr(cls.superClass, st);
    const members = cls.body || [];
    for (let i = 0; i < members.length; i++) {
        const m = members[i];
        if (!m) continue;
        if (m.computed && m.key) bsWalkExpr(m.key, st);
        if (m.type === "MethodDefinition") {
            if (m.value) bsWalkFunction(m.value, st);
        } else if (m.type === "PropertyDefinition") {
            // 字段初始化器在构造期执行:按嵌套函数深度处理,禁 TDZ 标记
            if (m.value) {
                st.fnDepth = st.fnDepth + 1;
                bsWalkExpr(m.value, st);
                st.fnDepth = st.fnDepth - 1;
            }
        }
    }
}

function bsWalkStmt(node, st) {
    if (!node) return;
    const t = node.type;
    if (t === "VariableDeclaration") { bsHandleVarDecl(node, st); return; }
    if (t === "ExpressionStatement") { bsWalkExpr(node.expression, st); return; }
    if (t === "FunctionDeclaration") { bsWalkFunction(node, st); return; }
    if (t === "ClassDeclaration") { bsWalkClass(node, st); return; }
    if (t === "BlockStatement") { bsWalkBlock(node, st); return; }
    if (t === "IfStatement") {
        bsWalkExpr(node.test, st);
        bsWalkStmt(node.consequent, st);
        bsWalkStmt(node.alternate, st);
        return;
    }
    if (t === "WhileStatement" || t === "DoWhileStatement") {
        bsWalkExpr(node.test, st);
        bsWalkStmt(node.body, st);
        return;
    }
    if (t === "ForStatement") { bsWalkFor(node, st); return; }
    if (t === "ForOfStatement" || t === "ForInStatement") { bsWalkForEach(node, st); return; }
    if (t === "SwitchStatement") { bsWalkSwitch(node, st); return; }
    if (t === "TryStatement") { bsWalkTry(node, st); return; }
    if (t === "LabeledStatement") { bsWalkStmt(node.body, st); return; }
    if (t === "ReturnStatement" || t === "ThrowStatement") { bsWalkExpr(node.argument, st); return; }
    if (t === "ExportDeclaration" || t === "ExportNamedDeclaration") {
        if (node.declaration) bsWalkStmt(node.declaration, st);
        return; // specifiers 引用顶层名,不动
    }
    if (t === "ExportDefaultDeclaration") {
        const d = node.declaration;
        if (!d) return;
        if (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") bsWalkStmt(d, st);
        else bsWalkExpr(d, st);
        return;
    }
    if (t === "ImportDeclaration" || t === "ImportLibDeclaration" || t === "ExportAllDeclaration" ||
        t === "BreakStatement" || t === "ContinueStatement" || t === "EmptyStatement") {
        return;
    }
    // 其余按表达式处理(表达式作为语句)
    bsWalkExpr(node, st);
}

function bsWalkExpr(node, st) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) bsWalkExpr(node[i], st);
        return;
    }
    const t = node.type;
    if (t === "Identifier") {
        const rec = bsLookup(st, node.name);
        if (rec && rec.n) {
            node.name = rec.n;
            // 同函数深度、词法先于声明 → TDZ 读点(嵌套函数内引用运行序不可判,不标)
            if (!rec.d && rec.f === st.fnDepth) {
                node._tdz = 1;
                if (!rec.t) {
                    rec.t = 1;
                    if (rec.blk) {
                        if (!rec.blk._tdzNames) rec.blk._tdzNames = [];
                        rec.blk._tdzNames.push(rec.n);
                    }
                }
            }
        }
        return;
    }
    if (t === "FunctionExpression" || t === "ArrowFunctionExpression" || t === "FunctionDeclaration") {
        bsWalkFunction(node, st);
        return;
    }
    if (t === "ClassExpression" || t === "ClassDeclaration") {
        bsWalkClass(node, st);
        return;
    }
    if (t === "MemberExpression") {
        bsWalkExpr(node.object, st);
        if (node.computed) bsWalkExpr(node.property, st);
        return;
    }
    if (t === "Property" || t === "AssignmentProperty") {
        if (node.shorthand && node.value === node.key && node.key && node.key.type === "Identifier") {
            node.value = { type: "Identifier", name: node.key.name };
        }
        if (node.computed) bsWalkExpr(node.key, st);
        bsWalkExpr(node.value, st);
        return;
    }
    if (t === "MetaProperty" || t === "Literal" || t === "RegexLiteral" ||
        t === "ThisExpression" || t === "SuperExpression" || t === "PrivateIdentifier") {
        return;
    }
    // 通用递归(仅遍历子节点对象/数组;跳过元信息键)
    for (const key in node) {
        if (key === "type" || key === "loc" || key === "range" || key === "start" || key === "end") continue;
        const child = node[key];
        if (child && typeof child === "object") bsWalkExpr(child, st);
    }
}

// 入口:对整份模块 AST 做一次改名(幂等:打 _blockScoped 标记防重入)。
// 模块顶层的 let/const 不改名(它们参与导出绑定/_main_captured_ 标签等按名管道)。
export function renameBlockScopedBindings(ast) {
    if (!ast || ast._blockScoped) return ast;
    ast._blockScoped = 1;
    const st = { c: 0, scopes: [], fnDepth: 0 };
    const frame = bsPushFrame(st);
    const body = ast.body || [];
    for (let i = 0; i < body.length; i++) bsCollectStmtNames(body[i], st, frame, 0);
    bsWalkStmts(body, st);
    bsPopFrame(st);
    return ast;
}
