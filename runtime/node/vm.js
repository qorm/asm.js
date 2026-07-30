// asm.js Runtime - Node.js vm

export class vm {
    static createContext(context) { return context || {}; }
    static isContext(maybeContext) { return maybeContext && typeof maybeContext === "object"; }
    static runInContext(code, context) {
        return eval(code);
    }
    static runInNewContext(code, context) {
        const ctx = context || {};
        return vm.runInContext(code, ctx);
    }
    static runInThisContext(code) {
        return eval(code);
    }
    static compileFunction(code, params) {
        return new Function(params || [], code);
    }
    static measureMemory() {
        throw new Error("vm.measureMemory is not implemented");
    }
}

export default vm;
