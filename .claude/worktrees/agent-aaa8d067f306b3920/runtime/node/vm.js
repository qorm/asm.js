// asm.js Runtime - Node.js vm

export class vm {
    static createContext(context) { return context || {}; }
    static isContext(maybeContext) { return maybeContext && typeof maybeContext === "object"; }
    static runInContext(code, context) {
        try { return eval(code); } catch { return undefined; }
    }
    static runInNewContext(code, context) {
        const ctx = context || {};
        return vm.runInContext(code, ctx);
    }
    static runInThisContext(code) {
        try { return eval(code); } catch { return undefined; }
    }
    static compileFunction(code, params) {
        try { return new Function(params || [], code); } catch { return () => undefined; }
    }
    static measureMemory() {
        return Promise.resolve({ total: { bytes: 0, external: 0 }, jsheapTotal: 0, jsheapUsed: 0 });
    }
}

export default vm;
