// asm.js Runtime - Node.js tty

import { JStoCstring } from "./_string.js";
import { getSyscall } from "./constants.js";

class WriteStream {
    constructor(fd) { this.fd = fd; this.writable = true; this.readable = false; }
    write(str) {
        if (str) {
            const buf = __alloc(str.length + 1);
            JStoCstring(str, buf, str.length + 1);
            __syscall(getSyscall("write"), this.fd, buf, str.length);
        }
        return true;
    }
    end(str) { if (str) this.write(str); }
    destroy() { this.close(); }
    close() {}
    get columns() { return 80; }
    get rows() { return 24; }
    isTTY = true;
}

class ReadStream {
    constructor(fd) { this.fd = fd; this.readable = true; this.writable = false; }
    read(size) { return ""; }
    destroy() { this.close(); }
    close() {}
    pause() { return this; }
    resume() { return this; }
    isTTY = true;
}

function isatty(fd) { return fd === 0 || fd === 1 || fd === 2; }

export { WriteStream, ReadStream, isatty };
export default { WriteStream, ReadStream, isatty };
