// asm.js Runtime - Node.js string_decoder
//
// StringDecoder 是 class(以支持 `new StringDecoder(enc)`),但 `write`/`end` 作为
// **实例属性(构造函数内赋值的闭包)**而非原型方法。原因:asm.js 方法派发对名为
// `end` 的**类原型方法**存在与内建符号冲突的缺陷——类实例上 `end()` 会被误派发
// (返回 "" 甚至令 main 无限重执)。实例属性即 own-property 闭包,由 _object_get
// 直取,规避该派发路径。用普通 function 表达式 + self 捕获(勿箭头,保持一致)。

export class StringDecoder {
    constructor(encoding) {
        const enc = encoding || "utf8";
        this.encoding = enc;
        // 累积的不完整多字节序列(asm.js 字节模型下多为空;保留以贴合 Node 形态)
        this.incomplete = "";
        const self = this;
        this.write = function (buffer) {
            if (buffer === undefined || buffer === null) return "";
            if (typeof buffer === "string") return buffer;
            return buffer.toString(enc === "buffer" ? "utf8" : enc);
        };
        this.end = function (buffer) {
            let out = self.incomplete;
            self.incomplete = "";
            if (buffer !== undefined && buffer !== null) out += self.write(buffer);
            return out;
        };
    }
}

export default { StringDecoder };
