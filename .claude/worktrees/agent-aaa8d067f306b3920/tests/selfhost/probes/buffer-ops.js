// Buffer read/write/encoding under the g1-compiled compiler. (Buffer.concat is a
// separate SHARED asm.js bug — broken under node-cli AND g1 — so not exercised here.)
const { Buffer } = require("buffer");
const b = Buffer.from([1, 2, 3, 4]);
const c = Buffer.alloc(4); c.writeUInt32LE(0x01020304, 0);
const b64 = Buffer.from("SGk=", "base64").toString();
const ok = b.length === 4 && b.readUInt16LE(0) === 0x0201 && b.toString("hex") === "01020304" &&
    c.readUInt32LE(0) === 0x01020304 && c.toString("hex") === "04030201" && b64 === "Hi";
console.log(ok ? "buffer-ops-ok" : "buffer-ops-FAIL");
