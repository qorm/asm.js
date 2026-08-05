// asm.js Runtime - String Utilities
// Helper functions for C string <-> JS string conversion

function cstringToJS(ptr) {
    if (!ptr) return "";
    let s = "";
    let ch;
    do {
        ch = __getChar(ptr);
        if (ch === 0) break;
        s += String.fromCharCode(ch);
        ptr = ptr + 1;
    } while (true);
    return s;
}

function JStoCstring(jsStr, buf, maxLen) {
    if (!jsStr) jsStr = "";
    const len = jsStr.length < maxLen - 1 ? jsStr.length : maxLen - 1;
    for (let i = 0; i < len; i++) {
        __setChar(buf + i, jsStr.charCodeAt(i));
    }
    __setChar(buf + len, 0);
    return len;
}

function syscallWrite(fd, str, getSyscall) {
    if (!str) str = "";
    if (typeof str !== "string") str = String(str);
    if (str.length === 0) return;
    const buf = __alloc(str.length + 1);
    JStoCstring(str, buf, str.length + 1);
    __syscall(getSyscall("write"), fd, buf, str.length);
}

export { cstringToJS, JStoCstring, syscallWrite };
export default { cstringToJS, JStoCstring, syscallWrite };
