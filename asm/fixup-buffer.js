const CHUNK_BITS = 20;
const CHUNK_SIZE = 1 << CHUNK_BITS;
const CHUNK_MASK = CHUNK_SIZE - 1;
const TYPE_NAMES = ["", "b", "bl", "cbz", "cbnz", "adr", "adrp", "bcond", "iat_stub", "got_stub"];
export const FIXUP_TYPE = {
    b: 1, bl: 2, cbz: 3, cbnz: 4, adr: 5, adrp: 6, bcond: 7,
    iat_stub: 8, got_stub: 9,
};
const TYPE_CODES = FIXUP_TYPE;
const MISSING_RD = 255;
const MISSING_SLOT = 0xFFFFFFFF;

export class FixupBuffer {
    constructor() {
        // native TypedArray 下标极慢;对象数组对自编译更便宜。Node 仍走 packed TA。
        this.nativeObjects = !process.release;
        this.items = [];
        this.labels = [];
        this.extras = [];
        this.length = 0;
        this._asmjsFixupBuffer = true;
        if (this.nativeObjects) {
            this.typeChunks = [];
            this.offsetChunks = [];
            this.rdChunks = [];
            this.condChunks = [];
            this.slotChunks = [];
            return;
        }
        this.typeChunks = [new Uint8Array(CHUNK_SIZE)];
        this.offsetChunks = [new Uint32Array(CHUNK_SIZE)];
        this.rdChunks = [new Uint8Array(CHUNK_SIZE)];
        this.condChunks = [new Uint8Array(CHUNK_SIZE)];
        this.slotChunks = [new Uint32Array(CHUNK_SIZE)];
    }

    _ensure(index) {
        while ((index >> CHUNK_BITS) >= this.typeChunks.length) {
            this.typeChunks.push(new Uint8Array(CHUNK_SIZE));
            this.offsetChunks.push(new Uint32Array(CHUNK_SIZE));
            this.rdChunks.push(new Uint8Array(CHUNK_SIZE));
            this.condChunks.push(new Uint8Array(CHUNK_SIZE));
            this.slotChunks.push(new Uint32Array(CHUNK_SIZE));
        }
    }

    pushRaw(type, offset, label, extra) {
        if (this.nativeObjects) {
            // 热路径:无 extra 的 b/bl/adr/... —— 少建字段、免 TYPE_CODES 字符串查表
            if (extra === undefined || extra === null) {
                const typeCode = typeof type === "number" ? type : (TYPE_CODES[type] || 0);
                this.items.push({ offset: offset, label: label, typeCode: typeCode });
                this.length = this.items.length;
                return this.length;
            }
            const item = typeof extra === "object" ? extra : { type: type, offset: offset, label: label };
            if (typeof extra === "number") {
                item.rd = extra;
                item.offset = offset;
                item.label = label;
            } else {
                if (item.offset === undefined) item.offset = offset;
                if (item.label === undefined && label !== undefined) item.label = label;
            }
            if (typeof item.typeCode !== "number") {
                if (typeof type === "number") item.typeCode = type;
                else item.typeCode = TYPE_CODES[item.type || type] || 0;
            }
            this.items.push(item);
            this.length = this.items.length;
            return this.length;
        }
        const index = this.length++;
        this._ensure(index);
        const chunk = index >> CHUNK_BITS;
        const within = index & CHUNK_MASK;
        this.typeChunks[chunk][within] = typeof type === "number" ? type : (TYPE_CODES[type] || 0);
        this.offsetChunks[chunk][within] = offset >>> 0;
        this.labels.push(label);
        let rd = MISSING_RD;
        let cond = MISSING_RD;
        let slot = MISSING_SLOT;
        if (typeof extra === "number") {
            rd = extra & 255;
        } else if (extra) {
            if (typeof extra.rd === "number") rd = extra.rd & 255;
            if (typeof extra.cond === "number") cond = extra.cond & 255;
            if (typeof extra.slotIndex === "number") slot = extra.slotIndex >>> 0;
            if (extra.symbol) this.extras[index] = extra;
        }
        this.rdChunks[chunk][within] = rd;
        this.condChunks[chunk][within] = cond;
        this.slotChunks[chunk][within] = slot;
        return this.length;
    }

    push(fixup) {
        return this.pushRaw(fixup.type, fixup.offset, fixup.label, fixup);
    }

    typeAt(index) {
        if (this.nativeObjects) {
            const tc = this.items[index].typeCode;
            if (typeof tc === "number") return TYPE_NAMES[tc] || "";
            return this.items[index].type;
        }
        return TYPE_NAMES[this.typeChunks[index >> CHUNK_BITS][index & CHUNK_MASK]];
    }

    typeCodeAt(index) {
        if (this.nativeObjects) {
            const item = this.items[index];
            if (typeof item.typeCode === "number") return item.typeCode;
            return TYPE_CODES[item.type] || 0;
        }
        return this.typeChunks[index >> CHUNK_BITS][index & CHUNK_MASK];
    }

    offsetAt(index) {
        if (this.nativeObjects) return this.items[index].offset;
        return this.offsetChunks[index >> CHUNK_BITS][index & CHUNK_MASK];
    }

    labelAt(index) {
        if (this.nativeObjects) return this.items[index].label;
        return this.labels[index];
    }

    rdAt(index) {
        if (this.nativeObjects) {
            const rd = this.items[index].rd;
            return typeof rd === "number" ? rd : MISSING_RD;
        }
        return this.rdChunks[index >> CHUNK_BITS][index & CHUNK_MASK];
    }

    condAt(index) {
        if (this.nativeObjects) {
            const cond = this.items[index].cond;
            return typeof cond === "number" ? cond : MISSING_RD;
        }
        return this.condChunks[index >> CHUNK_BITS][index & CHUNK_MASK];
    }

    slotAt(index) {
        if (this.nativeObjects) {
            const slot = this.items[index].slotIndex;
            return typeof slot === "number" ? slot >>> 0 : MISSING_SLOT;
        }
        return this.slotChunks[index >> CHUNK_BITS][index & CHUNK_MASK];
    }

    get(index) {
        if (this.nativeObjects) {
            // 必须物化 type 字符串:engine/compile.js 片段链接按 fx.type === "bl"/"adrp"
            // 判别。此前直接返回 items[i](仅有 typeCode)→ fx.type===undefined →
            // `new Function(...)`/`eval` 一律 "未支持的 fixup 类型 undefined"。
            const item = this.items[index];
            const out = {
                type: this.typeAt(index),
                offset: item.offset,
                label: item.label,
            };
            if (typeof item.rd === "number") out.rd = item.rd;
            if (typeof item.cond === "number") out.cond = item.cond;
            if (typeof item.slotIndex === "number") out.slotIndex = item.slotIndex;
            if (item.symbol) out.symbol = item.symbol;
            return out;
        }
        const extra = this.extras[index];
        if (extra) return extra;
        const out = {
            type: this.typeAt(index),
            offset: this.offsetAt(index),
            label: this.labelAt(index),
        };
        const rd = this.rdAt(index);
        if (rd !== MISSING_RD) out.rd = rd;
        const cond = this.condAt(index);
        if (cond !== MISSING_RD) out.cond = cond;
        const slot = this.slotAt(index);
        if (slot !== MISSING_SLOT) out.slotIndex = slot;
        return out;
    }

    slice(start = 0, end = this.length) {
        const out = [];
        for (let i = start; i < end; i++) out.push(this.get(i));
        return out;
    }

    clone() {
        const out = new FixupBuffer();
        out.nativeObjects = this.nativeObjects;
        out.items = this.items.map((item) => ({ ...item }));
        out.typeChunks = this.typeChunks.map((chunk) => chunk.slice());
        out.offsetChunks = this.offsetChunks.map((chunk) => chunk.slice());
        out.rdChunks = this.rdChunks.map((chunk) => chunk.slice());
        out.condChunks = this.condChunks.map((chunk) => chunk.slice());
        out.slotChunks = this.slotChunks.map((chunk) => chunk.slice());
        out.labels = this.labels.slice();
        out.extras = this.extras.map((item) => item && { ...item });
        out.length = this.length;
        return out;
    }
}
