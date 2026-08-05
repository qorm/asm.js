// asm.js - JavaScript AST 节点定义
// 抽象语法树节点类型和类

// ============ 节点类型 ============

export const NodeType = {
    // 程序
    Program: "Program",

    // 语句
    VariableDeclaration: "VariableDeclaration",
    FunctionDeclaration: "FunctionDeclaration",
    ClassDeclaration: "ClassDeclaration",
    ExpressionStatement: "ExpressionStatement",
    EmptyStatement: "EmptyStatement",
    BlockStatement: "BlockStatement",
    ReturnStatement: "ReturnStatement",
    IfStatement: "IfStatement",
    ForStatement: "ForStatement",
    ForInStatement: "ForInStatement",
    ForOfStatement: "ForOfStatement",
    WhileStatement: "WhileStatement",
    DoWhileStatement: "DoWhileStatement",
    WithStatement: "WithStatement",
    SwitchStatement: "SwitchStatement",
    BreakStatement: "BreakStatement",
    ContinueStatement: "ContinueStatement",
    LabeledStatement: "LabeledStatement",
    TryStatement: "TryStatement",
    ThrowStatement: "ThrowStatement",
    SpawnStatement: "SpawnStatement", // [方言] js f(x) 协程派发
    ImportDeclaration: "ImportDeclaration",
    ImportLibDeclaration: "ImportLibDeclaration",
    ExportDeclaration: "ExportDeclaration",

    // 表达式
    Identifier: "Identifier",
    Literal: "Literal",
    ArrayExpression: "ArrayExpression",
    ObjectExpression: "ObjectExpression",
    FunctionExpression: "FunctionExpression",
    ArrowFunctionExpression: "ArrowFunctionExpression",
    CallExpression: "CallExpression",
    MemberExpression: "MemberExpression",
    BinaryExpression: "BinaryExpression",
    UnaryExpression: "UnaryExpression",
    AssignmentExpression: "AssignmentExpression",
    UpdateExpression: "UpdateExpression",
    LogicalExpression: "LogicalExpression",
    ConditionalExpression: "ConditionalExpression",
    NewExpression: "NewExpression",
    ThisExpression: "ThisExpression",
    SuperExpression: "SuperExpression",
    SequenceExpression: "SequenceExpression",
    TemplateLiteral: "TemplateLiteral",
    SpreadElement: "SpreadElement",
    AssignmentPattern: "AssignmentPattern",
    AwaitExpression: "AwaitExpression",
    MetaProperty: "MetaProperty",
    RegexLiteral: "RegexLiteral",

    // 其他
    Property: "Property",
    MethodDefinition: "MethodDefinition",
    PropertyDefinition: "PropertyDefinition",
    StaticBlock: "StaticBlock",
    PrivateIdentifier: "PrivateIdentifier",
    ImportSpecifier: "ImportSpecifier",
    ExportSpecifier: "ExportSpecifier",
    VariableDeclarator: "VariableDeclarator",
    CatchClause: "CatchClause",
    SwitchCase: "SwitchCase",
    YieldExpression: "YieldExpression",
};

// ============ 基础节点类 ============

export class Node {
    constructor(type) {
        this.type = type;
    }
}

// ============ 程序 ============

export class Program extends Node {
    constructor() {
        super(NodeType.Program);
        this.body = [];
    }
}

// ============ 语句节点 ============

export class VariableDeclaration extends Node {
    constructor(kind) {
        super(NodeType.VariableDeclaration);
        this.kind = kind; // "let", "const", "var"
        this.declarations = [];
    }
}

export class VariableDeclarator extends Node {
    constructor(id, init) {
        super(NodeType.VariableDeclarator);
        this.id = id;
        this.init = init;
    }
}

export class FunctionDeclaration extends Node {
    constructor(id, params, body, isAsync, isGenerator) {
        super(NodeType.FunctionDeclaration);
        this.id = id;
        this.params = params || [];
        this.body = body;
        this.isAsync = isAsync || false;
        this.isGenerator = isGenerator || false; // function* (批次D 生成器)
    }
}

export class ClassDeclaration extends Node {
    constructor(id, superClass, body) {
        super(NodeType.ClassDeclaration);
        this.id = id;
        this.superClass = superClass;
        this.body = body || [];
    }
}

export class MethodDefinition extends Node {
    constructor(key, value, kind, isStatic, computed) {
        super(NodeType.MethodDefinition);
        this.key = key;
        this.value = value;
        this.kind = kind; // "constructor", "method", "get", "set"
        this.static = isStatic || false;
        this.computed = computed || false;
    }
}

// 类字段定义 (ES2022)
export class PropertyDefinition extends Node {
    constructor(key, value, computed, isStatic) {
        super(NodeType.PropertyDefinition);
        this.key = key;
        this.value = value;
        this.computed = computed || false;
        this.static = isStatic || false;
    }
}

// 私有标识符 (#name)
export class PrivateIdentifier extends Node {
    constructor(name) {
        super(NodeType.PrivateIdentifier);
        this.name = name; // 包含 # 前缀
    }
}

// yield 表达式 (生成器)
export class YieldExpression extends Node {
    constructor(argument, delegate) {
        super(NodeType.YieldExpression);
        this.argument = argument;
        this.delegate = delegate || false; // yield* 为 true
    }
}

export class ExpressionStatement extends Node {
    constructor(expression) {
        super(NodeType.ExpressionStatement);
        this.expression = expression;
    }
}

// 空语句 `;`(#68):编译期 no-op
export class EmptyStatement extends Node {
    constructor() {
        super(NodeType.EmptyStatement);
    }
}

export class BlockStatement extends Node {
    constructor(body) {
        super(NodeType.BlockStatement);
        this.body = body || [];
    }
}

// [ES2022] 类静态初始化块 static { ... }:类定义期以 this=类对象执行 body。
export class StaticBlock extends Node {
    constructor(body) {
        super(NodeType.StaticBlock);
        this.body = body || [];
    }
}

export class ReturnStatement extends Node {
    constructor(argument) {
        super(NodeType.ReturnStatement);
        this.argument = argument;
    }
}

export class IfStatement extends Node {
    constructor(test, consequent, alternate) {
        super(NodeType.IfStatement);
        this.test = test;
        this.consequent = consequent;
        this.alternate = alternate;
    }
}

export class ForStatement extends Node {
    constructor(init, test, update, body) {
        super(NodeType.ForStatement);
        this.init = init;
        this.test = test;
        this.update = update;
        this.body = body;
    }
}

export class ForInStatement extends Node {
    constructor(left, right, body) {
        super(NodeType.ForInStatement);
        this.left = left;
        this.right = right;
        this.body = body;
    }
}

export class ForOfStatement extends Node {
    constructor(left, right, body, isAwait) {
        super(NodeType.ForOfStatement);
        this.left = left;
        this.right = right;
        this.body = body;
        this.await = !!isAwait; // for await (... of ...)
    }
}

export class WhileStatement extends Node {
    constructor(test, body) {
        super(NodeType.WhileStatement);
        this.test = test;
        this.body = body;
    }
}

export class WithStatement extends Node {
    constructor(object, body) {
        super(NodeType.WithStatement);
        this.object = object;
        this.body = body;
    }
}

export class DoWhileStatement extends Node {
    constructor(body, test) {
        super(NodeType.DoWhileStatement);
        this.body = body;
        this.test = test;
    }
}

export class SwitchStatement extends Node {
    constructor(discriminant, cases) {
        super(NodeType.SwitchStatement);
        this.discriminant = discriminant;
        this.cases = cases || [];
    }
}

export class SwitchCase extends Node {
    constructor(test, consequent) {
        super(NodeType.SwitchCase);
        this.test = test; // null for default
        this.consequent = consequent || [];
    }
}

export class BreakStatement extends Node {
    constructor(label) {
        super(NodeType.BreakStatement);
        this.label = label;
    }
}

export class ContinueStatement extends Node {
    constructor(label) {
        super(NodeType.ContinueStatement);
        this.label = label;
    }
}

export class LabeledStatement extends Node {
    constructor(label, body) {
        super(NodeType.LabeledStatement);
        this.label = label;
        this.body = body;
    }
}

export class TryStatement extends Node {
    constructor(block, handler, finalizer) {
        super(NodeType.TryStatement);
        this.block = block;
        this.handler = handler;
        this.finalizer = finalizer;
    }
}

export class CatchClause extends Node {
    constructor(param, body) {
        super(NodeType.CatchClause);
        this.param = param;
        this.body = body;
    }
}

// [方言扩展] SpawnStatement:`js <CallExpression>` —— 求值被调方与实参后把调用
// 作为新协程投递到事件循环(fire-and-forget,Go 的 go 语句之 asm.js 版)。
export class SpawnStatement extends Node {
    constructor(call) {
        super(NodeType.SpawnStatement);
        this.call = call;
    }
}

export class ThrowStatement extends Node {
    constructor(argument) {
        super(NodeType.ThrowStatement);
        this.argument = argument;
    }
}

export class ImportDeclaration extends Node {
    constructor(specifiers, source) {
        super(NodeType.ImportDeclaration);
        this.specifiers = specifiers || [];
        this.source = source;
    }
}

// 动态库导入声明: import * from.lib "libname"
export class ImportLibDeclaration extends Node {
    constructor(libPath, symbols) {
        super(NodeType.ImportLibDeclaration);
        this.libPath = libPath;
        this.symbols = symbols || [];
    }
}

export class ImportSpecifier extends Node {
    constructor(local, imported, isDefault, isNamespace) {
        super(NodeType.ImportSpecifier);
        this.local = local;
        this.imported = imported;
        this.default = isDefault || false;
        this.namespace = isNamespace || false;
    }
}

export class ExportDeclaration extends Node {
    constructor(declaration, specifiers, source, isDefault) {
        super(NodeType.ExportDeclaration);
        this.declaration = declaration;
        this.specifiers = specifiers || [];
        this.source = source;
        this.default = isDefault || false;
    }
}

export class ExportSpecifier extends Node {
    constructor(local, exported, isNamespace) {
        super(NodeType.ExportSpecifier);
        this.local = local;
        this.exported = exported;
        this.namespace = isNamespace || false;
    }
}

// ============ 表达式节点 ============

export class Identifier extends Node {
    constructor(name) {
        super(NodeType.Identifier);
        this.name = name;
    }
}

export class Literal extends Node {
    constructor(value, raw) {
        super(NodeType.Literal);
        this.value = value;
        this.raw = raw;
    }
}

export class ArrayExpression extends Node {
    constructor(elements) {
        super(NodeType.ArrayExpression);
        this.elements = elements || [];
    }
}

export class ObjectExpression extends Node {
    constructor(properties) {
        super(NodeType.ObjectExpression);
        this.properties = properties || [];
    }
}

export class Property extends Node {
    constructor(key, value, kind, computed, shorthand) {
        super(NodeType.Property);
        this.key = key;
        this.value = value;
        this.kind = kind || "init";
        this.computed = computed || false;
        this.shorthand = shorthand || false;
    }
}

export class FunctionExpression extends Node {
    constructor(id, params, body, isAsync, isGenerator) {
        super(NodeType.FunctionExpression);
        this.id = id;
        this.params = params || [];
        this.body = body;
        this.isAsync = isAsync || false;
        this.isGenerator = isGenerator || false; // function* (批次D 生成器)
    }
}

export class ArrowFunctionExpression extends Node {
    constructor(params, body, isAsync, expression) {
        super(NodeType.ArrowFunctionExpression);
        this.params = params || [];
        this.body = body;
        this.isAsync = isAsync || false;
        this.expression = expression || false;
    }
}

export class CallExpression extends Node {
    constructor(callee, args) {
        super(NodeType.CallExpression);
        this.callee = callee;
        this.arguments = args || [];
    }
}

export class MemberExpression extends Node {
    constructor(object, property, computed, optional) {
        super(NodeType.MemberExpression);
        this.object = object;
        this.property = property;
        this.computed = computed || false;
        this.optional = optional || false;
    }
}

export class BinaryExpression extends Node {
    constructor(operator, left, right) {
        super(NodeType.BinaryExpression);
        this.operator = operator;
        this.left = left;
        this.right = right;
    }
}

export class UnaryExpression extends Node {
    constructor(operator, argument, prefix) {
        super(NodeType.UnaryExpression);
        this.operator = operator;
        this.argument = argument;
        this.prefix = prefix !== false;
    }
}

export class AssignmentExpression extends Node {
    constructor(operator, left, right) {
        super(NodeType.AssignmentExpression);
        this.operator = operator;
        this.left = left;
        this.right = right;
    }
}

export class UpdateExpression extends Node {
    constructor(operator, argument, prefix) {
        super(NodeType.UpdateExpression);
        this.operator = operator;
        this.argument = argument;
        this.prefix = prefix || false;
    }
}

export class AwaitExpression extends Node {
    constructor(argument) {
        super(NodeType.AwaitExpression);
        this.argument = argument;
    }
}

export class MetaProperty extends Node {
    constructor(meta, property) {
        super(NodeType.MetaProperty);
        this.meta = meta;
        this.property = property;
    }
}

export class LogicalExpression extends Node {
    constructor(operator, left, right) {
        super(NodeType.LogicalExpression);
        this.operator = operator;
        this.left = left;
        this.right = right;
    }
}

export class ConditionalExpression extends Node {
    constructor(test, consequent, alternate) {
        super(NodeType.ConditionalExpression);
        this.test = test;
        this.consequent = consequent;
        this.alternate = alternate;
    }
}

export class NewExpression extends Node {
    constructor(callee, args) {
        super(NodeType.NewExpression);
        this.callee = callee;
        this.arguments = args || [];
    }
}

export class ThisExpression extends Node {
    constructor() {
        super(NodeType.ThisExpression);
    }
}

export class SuperExpression extends Node {
    constructor() {
        super(NodeType.SuperExpression);
    }
}

export class SequenceExpression extends Node {
    constructor(expressions) {
        super(NodeType.SequenceExpression);
        this.expressions = expressions || [];
    }
}

export class RegexLiteral extends Node {
    constructor(pattern, flags, raw) {
        super(NodeType.RegexLiteral);
        this.pattern = pattern;
        this.flags = flags;
        this.raw = raw;
    }
}

export class TemplateLiteral extends Node {
    constructor(quasis, expressions) {
        super(NodeType.TemplateLiteral);
        this.quasis = quasis || [];
        this.expressions = expressions || [];
    }
}

export class SpreadElement extends Node {
    constructor(argument) {
        super(NodeType.SpreadElement);
        this.argument = argument;
    }
}

export class AssignmentPattern extends Node {
    constructor(left, right) {
        super(NodeType.AssignmentPattern);
        this.left = left;
        this.right = right;
    }
}

// ============ 解构模式 ============

export class ObjectPattern extends Node {
    constructor() {
        super("ObjectPattern");
        this.properties = [];
    }
}

export class ArrayPattern extends Node {
    constructor() {
        super("ArrayPattern");
        this.elements = [];
    }
}

export class AssignmentProperty extends Node {
    constructor() {
        super("AssignmentProperty");
        this.key = null;
        this.value = null;
        this.shorthand = false;
        this.computed = false; // [C2] {[expr]: target} 计算键
    }
}
