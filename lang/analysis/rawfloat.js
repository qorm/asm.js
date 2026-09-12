// P3.1: prove non-param unboxed locals that always hold raw float64 JSValues.
// Identifier arithmetic then skips the identity _number_coerce / emitNumberCoerceFast.
// Analysis is AST-level, gen1-safe (flag dicts + parallel arrays, no optional chaining).
// Soundness over precision: a missed candidate only keeps the existing coerce.
// Nested functions are module-level: a self-hosted compileFragment used to
// throw TypeError "not a function" when Function("var x;") ran this analysis
// (hold-expr leftover on the nested visit/markPoison closures).

import { collectLocalDeclarations, collectPatternNames, ensureFunctionNestedIndex } from "./closure.js";

function isBigLit(node) {
    return !!(node && node.type === "Literal" && typeof node.value === "bigint");
}

function isRawFloatProducer(node, raw) {
    if (!node) return false;
    const t = node.type;
    if (t === "Literal" || t === "NumericLiteral") {
        return typeof node.value === "number";
    }
    if (t === "Identifier") {
        if (node.name === "NaN" || node.name === "Infinity") return true;
        return raw[node.name] === true;
    }
    if (t === "UnaryExpression") {
        const op = node.operator;
        if (op !== "-" && op !== "+" && op !== "~") return false;
        return isRawFloatProducer(node.argument, raw);
    }
    if (t === "BinaryExpression") {
        const op = node.operator;
        if (op === ",") return isRawFloatProducer(node.right, raw);
        if (op !== "+" && op !== "-" && op !== "*" && op !== "/" &&
            op !== "%" && op !== "**") {
            return false;
        }
        if (isBigLit(node.left) || isBigLit(node.right)) return false;
        return isRawFloatProducer(node.left, raw) && isRawFloatProducer(node.right, raw);
    }
    if (t === "ConditionalExpression") {
        return isRawFloatProducer(node.consequent, raw) &&
            isRawFloatProducer(node.alternate, raw);
    }
    return false;
}

function isArithAssignOp(op) {
    return op === "-=" || op === "*=" || op === "/=" || op === "%=";
}

function isBoxedName(boxedVars, name) {
    if (!boxedVars) return false;
    if (typeof boxedVars.has === "function") return boxedVars.has(name) === true;
    return boxedVars[name] === true;
}

function markPoison(st, name) {
    if (st.cand[name] === true) st.poison[name] = true;
}

function markPoisonPat(st, pat) {
    if (!pat) return;
    const ns = {};
    collectPatternNames(pat, ns);
    for (const n in ns) {
        if (ns[n] === true) markPoison(st, n);
    }
}

function addProd(st, name, node) {
    if (st.cand[name] !== true) return;
    st.prods[name].push(node);
}

function markAlways(st, name, depth) {
    if (st.cand[name] === true && depth === 0) st.alwaysInit[name] = true;
}

function visitList(st, list, depth) {
    if (!list) return;
    for (let i = 0; i < list.length; i++) visitRawFloat(st, list[i], depth);
}

// Explicit children only. for-in + Array.isArray on AST nodes inside a
// self-hosted compileFragment throws TypeError "not a function".
function visitRawFloat(st, node, depth) {
    if (st.hasWith) return;
    if (!node || typeof node !== "object") return;
    const t = node.type;
    if (!t) return;

    if (t === "FunctionExpression" || t === "ArrowFunctionExpression" ||
        t === "FunctionDeclaration" || t === "ClassExpression" ||
        t === "ClassDeclaration") {
        if (t === "ClassDeclaration" && node.id && node.id.name) {
            markPoison(st, node.id.name);
        }
        if (t === "FunctionDeclaration" && node.id && node.id.name) {
            markPoison(st, node.id.name);
        }
        return;
    }

    if (t === "WithStatement") {
        st.hasWith = true;
        return;
    }

    if (t === "Identifier") {
        const nm = node.name;
        if (st.cand[nm] === true && st.alwaysInit[nm] !== true) st.earlyRead[nm] = true;
        return;
    }

    if (t === "VariableDeclaration") {
        const ds = node.declarations || [];
        for (let i = 0; i < ds.length; i++) {
            const d = ds[i];
            if (!d) continue;
            const id = d.id;
            if (id && id.type === "Identifier") {
                const nm = id.name;
                if (st.cand[nm] === true) {
                    if (d.init) {
                        markAlways(st, nm, depth);
                        addProd(st, nm, d.init);
                        visitRawFloat(st, d.init, depth);
                    } else {
                        markPoison(st, nm);
                    }
                } else if (d.init) {
                    visitRawFloat(st, d.init, depth);
                }
            } else {
                markPoisonPat(st, id);
                if (d.init) visitRawFloat(st, d.init, depth);
            }
        }
        return;
    }

    if (t === "AssignmentExpression") {
        const left = node.left;
        const op = node.operator;
        if (left && left.type === "Identifier") {
            const nm = left.name;
            if (st.cand[nm] === true) {
                if (op === "=") {
                    markAlways(st, nm, depth);
                    addProd(st, nm, node.right);
                } else if (isArithAssignOp(op)) {
                    markAlways(st, nm, depth);
                } else {
                    markPoison(st, nm);
                }
            }
            const rd = (op === "&&=" || op === "||=" || op === "??=") ? depth + 1 : depth;
            visitRawFloat(st, node.right, rd);
        } else {
            markPoisonPat(st, left);
            visitRawFloat(st, left, depth);
            visitRawFloat(st, node.right, depth);
        }
        return;
    }

    if (t === "UpdateExpression") {
        const arg = node.argument;
        if (arg && arg.type === "Identifier") {
            const nm = arg.name;
            if (st.cand[nm] === true) markAlways(st, nm, depth);
        } else {
            visitRawFloat(st, arg, depth);
        }
        return;
    }

    if (t === "ForInStatement" || t === "ForOfStatement") {
        const left = node.left;
        if (left && left.type === "Identifier") markPoison(st, left.name);
        else if (left && left.type === "VariableDeclaration") {
            const ds = left.declarations || [];
            for (let i = 0; i < ds.length; i++) {
                if (ds[i] && ds[i].id) markPoisonPat(st, ds[i].id);
            }
        } else {
            markPoisonPat(st, left);
        }
        visitRawFloat(st, node.right, depth);
        visitRawFloat(st, node.body, depth + 1);
        return;
    }

    if (t === "ForStatement") {
        visitRawFloat(st, node.init, depth);
        visitRawFloat(st, node.test, depth + 1);
        visitRawFloat(st, node.update, depth + 1);
        visitRawFloat(st, node.body, depth + 1);
        return;
    }

    if (t === "IfStatement") {
        visitRawFloat(st, node.test, depth);
        visitRawFloat(st, node.consequent, depth + 1);
        visitRawFloat(st, node.alternate, depth + 1);
        return;
    }

    if (t === "WhileStatement" || t === "DoWhileStatement") {
        visitRawFloat(st, node.test, depth);
        visitRawFloat(st, node.body, depth + 1);
        return;
    }

    if (t === "SwitchStatement") {
        visitRawFloat(st, node.discriminant, depth);
        visitList(st, node.cases, depth + 1);
        return;
    }

    if (t === "TryStatement") {
        visitRawFloat(st, node.block, depth + 1);
        const h = node.handler;
        if (h) {
            if (h.param) markPoisonPat(st, h.param);
            visitRawFloat(st, h.body, depth + 1);
        }
        visitRawFloat(st, node.finalizer, depth + 1);
        return;
    }

    if (t === "LogicalExpression") {
        visitRawFloat(st, node.left, depth);
        visitRawFloat(st, node.right, depth + 1);
        return;
    }

    if (t === "ConditionalExpression") {
        visitRawFloat(st, node.test, depth);
        visitRawFloat(st, node.consequent, depth + 1);
        visitRawFloat(st, node.alternate, depth + 1);
        return;
    }

    if (t === "LabeledStatement") {
        visitRawFloat(st, node.body, depth);
        return;
    }
    if (t === "BlockStatement" || t === "Program") {
        visitList(st, node.body, depth);
        return;
    }
    if (t === "ExpressionStatement") {
        visitRawFloat(st, node.expression, depth);
        return;
    }
    if (t === "ReturnStatement" || t === "ThrowStatement" || t === "UnaryExpression" ||
        t === "SpreadElement" || t === "YieldExpression" || t === "AwaitExpression") {
        visitRawFloat(st, node.argument, depth);
        return;
    }
    if (t === "MemberExpression") {
        visitRawFloat(st, node.object, depth);
        if (node.computed) visitRawFloat(st, node.property, depth);
        return;
    }
    if (t === "CallExpression" || t === "NewExpression") {
        visitRawFloat(st, node.callee, depth);
        visitList(st, node.arguments, depth);
        return;
    }
    if (t === "ArrayExpression") {
        visitList(st, node.elements, depth);
        return;
    }
    if (t === "ObjectExpression") {
        visitList(st, node.properties, depth);
        return;
    }
    if (t === "Property") {
        if (node.computed) visitRawFloat(st, node.key, depth);
        visitRawFloat(st, node.value, depth);
        return;
    }
    if (t === "SequenceExpression") {
        visitList(st, node.expressions, depth);
        return;
    }
    if (t === "SwitchCase") {
        visitRawFloat(st, node.test, depth);
        visitList(st, node.consequent, depth);
        return;
    }
    visitRawFloat(st, node.body, depth);
    visitRawFloat(st, node.expression, depth);
    visitRawFloat(st, node.argument, depth);
    visitRawFloat(st, node.left, depth);
    visitRawFloat(st, node.right, depth);
    visitRawFloat(st, node.init, depth);
    visitRawFloat(st, node.test, depth);
    visitRawFloat(st, node.update, depth);
    visitRawFloat(st, node.consequent, depth);
    visitRawFloat(st, node.alternate, depth);
    visitRawFloat(st, node.callee, depth);
    visitRawFloat(st, node.object, depth);
    visitRawFloat(st, node.block, depth);
    visitRawFloat(st, node.handler, depth);
    visitRawFloat(st, node.finalizer, depth);
    visitRawFloat(st, node.discriminant, depth);
}

export function analyzeRawFloatVars(func, boxedVars) {
    const empty = {};
    if (!func || !func.body) return empty;
    if (typeof process !== "undefined" && process.env && process.env.RAW_FLOAT_NO) {
        return empty;
    }

    ensureFunctionNestedIndex(func);
    if (func.body && func.body._he === 1) return empty;

    const locals = {};
    collectLocalDeclarations(func.body, locals);

    const params = {};
    const ps = func.params || [];
    for (let i = 0; i < ps.length; i++) collectPatternNames(ps[i], params);

    const cand = {};
    const names = [];
    for (const name in locals) {
        if (locals[name] !== true) continue;
        if (params[name] === true) continue;
        if (isBoxedName(boxedVars, name)) continue;
        if (name === "arguments" || name === "__this") continue;
        cand[name] = true;
        names.push(name);
    }
    if (names.length === 0) return empty;

    const alwaysInit = {};
    const poison = {};
    const earlyRead = {};
    const prods = {};
    for (let i = 0; i < names.length; i++) prods[names[i]] = [];

    const st = {
        cand: cand,
        poison: poison,
        earlyRead: earlyRead,
        alwaysInit: alwaysInit,
        prods: prods,
        hasWith: false,
    };
    visitRawFloat(st, func.body, 0);
    if (st.hasWith) return empty;

    const raw = {};
    for (let i = 0; i < names.length; i++) {
        const nm = names[i];
        if (poison[nm] === true) continue;
        if (earlyRead[nm] === true) continue;
        if (alwaysInit[nm] !== true) continue;
        raw[nm] = true;
    }

    let changed = true;
    let guard = names.length + 2;
    while (changed && guard > 0) {
        changed = false;
        guard = guard - 1;
        for (let i = 0; i < names.length; i++) {
            const nm = names[i];
            if (raw[nm] !== true) continue;
            const list = prods[nm];
            let ok = true;
            for (let j = 0; j < list.length; j++) {
                if (!isRawFloatProducer(list[j], raw)) {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                raw[nm] = false;
                changed = true;
            }
        }
    }

    const out = {};
    for (let i = 0; i < names.length; i++) {
        const nm = names[i];
        if (raw[nm] === true) out[nm] = true;
    }
    return out;
}
