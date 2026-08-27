const CHUNK_BITS = 20;
const CHUNK_SIZE = 1 << CHUNK_BITS;
const CHUNK_MASK = CHUNK_SIZE - 1;

// Growable byte storage without boxed number[] elements. Chunks keep growth O(1) and
// avoid copying the already emitted 60+ MB code segment.
export class ByteBuffer {
    constructor() {
        this.chunks = [new Uint32Array(CHUNK_SIZE >> 2)];
        this.length = 0;
        this._asmjsByteBuffer = true;
    }

    _ensure(offset) {
        while ((offset >> CHUNK_BITS) >= this.chunks.length) {
            this.chunks.push(new Uint32Array(CHUNK_SIZE >> 2));
        }
    }

    emit32(word) {
        const offset = this.length;
        const ci = offset >> CHUNK_BITS;
        let chunk = this.chunks[ci];
        if (chunk === undefined) {
            this._ensure(offset + 3);
            chunk = this.chunks[ci];
        }
        const within = offset & CHUNK_MASK;
        if ((within & 3) === 0) {
            chunk[within >> 2] = word >>> 0;
            this.length = offset + 4;
            return this.length;
        }
        this.write32(offset, word);
        this.length = offset + 4;
        return this.length;
    }

    push(a, b, c, d) {
        if (d !== undefined) {
            const offset = this.length;
            this._ensure(offset + 3);
            const within = offset & CHUNK_MASK;
            if ((within & 3) === 0) {
                this.chunks[offset >> CHUNK_BITS][within >> 2] =
                    (a & 255) | ((b & 255) << 8) | ((c & 255) << 16) | ((d & 255) << 24);
                this.length = offset + 4;
                return this.length;
            }
            this.set(offset, a);
            this.set(offset + 1, b);
            this.set(offset + 2, c);
            this.set(offset + 3, d);
            this.length = offset + 4;
            return this.length;
        }
        const count = c !== undefined ? 3 : b !== undefined ? 2 : 1;
        const offset = this.length;
        this._ensure(offset + count - 1);
        const within = offset & CHUNK_MASK;
        if (within + count <= CHUNK_SIZE) {
            this.set(offset, a);
            if (count > 1) this.set(offset + 1, b);
            if (count > 2) this.set(offset + 2, c);
            this.length = offset + count;
            return this.length;
        }
        this.set(this.length++, a);
        if (count > 1) this.set(this.length++, b);
        if (count > 2) this.set(this.length++, c);
        return this.length;
    }

    pop() {
        if (this.length === 0) return undefined;
        this.length -= 1;
        return this.get(this.length);
    }

    get(offset) {
        const within = offset & CHUNK_MASK;
        const word = this.chunks[offset >> CHUNK_BITS][within >> 2];
        return (word >>> ((within & 3) << 3)) & 255;
    }

    set(offset, value) {
        const within = offset & CHUNK_MASK;
        const chunk = this.chunks[offset >> CHUNK_BITS];
        const index = within >> 2;
        const shift = (within & 3) << 3;
        const mask = 255 << shift;
        chunk[index] = (chunk[index] & ~mask) | ((value & 255) << shift);
    }

    write32(offset, word) {
        const within = offset & CHUNK_MASK;
        if ((within & 3) === 0) {
            this.chunks[offset >> CHUNK_BITS][within >> 2] = word >>> 0;
            return;
        }
        this.set(offset, word);
        this.set(offset + 1, word >> 8);
        this.set(offset + 2, word >> 16);
        this.set(offset + 3, word >> 24);
    }

    slice(start = 0, end = this.length) {
        const out = new Uint8Array(Math.max(0, end - start));
        let src = start;
        let dst = 0;
        while (src < end) {
            const chunk = this.chunks[src >> CHUNK_BITS];
            const within = src & CHUNK_MASK;
            const count = Math.min(end - src, CHUNK_SIZE - within);
            const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            out.set(bytes.subarray(within, within + count), dst);
            src += count;
            dst += count;
        }
        return out;
    }

    clone() {
        const out = new ByteBuffer();
        out.chunks = this.chunks.map((chunk) => chunk.slice());
        out.length = this.length;
        return out;
    }

    static fromBytes(bytes) {
        const out = new ByteBuffer();
        const n = bytes ? bytes.length : 0;
        if (!n) return out;
        out._ensure(n - 1);
        out.length = n;
        let src = 0;
        while (src < n) {
            const within = src & CHUNK_MASK;
            const count = Math.min(n - src, CHUNK_SIZE - within);
            const chunk = out.chunks[src >> CHUNK_BITS];
            const view = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            if (bytes.subarray) view.set(bytes.subarray(src, src + count), within);
            else {
                for (let i = 0; i < count; i++) view[within + i] = bytes[src + i] & 255;
            }
            src += count;
        }
        return out;
    }
}
