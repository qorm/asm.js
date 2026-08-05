import crypto from "node:crypto";
import { Buffer } from "node:buffer";

const key128 = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
const key256 = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
const iv = Buffer.from("aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb", "hex");
const pt = "Hello, AES world! This is a longer message.";

// AES-128-CBC encrypt (hex), must match Node byte-for-byte.
function enc(algo, key, plain) {
    const c = crypto.createCipheriv(algo, key, iv);
    return c.update(plain, "utf8", "hex") + c.final("hex");
}
function dec(algo, key, cthex) {
    const d = crypto.createDecipheriv(algo, key, iv);
    return d.update(cthex, "hex", "utf8") + d.final("utf8");
}

const ct128 = enc("aes-128-cbc", key128, pt);
const ct256 = enc("aes-256-cbc", key256, pt);
console.log("aes128: " + ct128);
console.log("aes256: " + ct256);
console.log("rt128: " + (dec("aes-128-cbc", key128, ct128) === pt ? "OK" : "FAIL"));
console.log("rt256: " + (dec("aes-256-cbc", key256, ct256) === pt ? "OK" : "FAIL"));

// Exact block-multiple plaintext (16 bytes) still gets a full pad block.
console.log("aes128-16: " + enc("aes-128-cbc", key128, "0123456789abcdef"));

// setAutoPadding(false): 16-byte input, no pad, single raw block.
const cnp = crypto.createCipheriv("aes-128-cbc", key128, iv);
cnp.setAutoPadding(false);
const raw16 = cnp.update("0123456789abcdef", "utf8", "hex") + cnp.final("hex");
console.log("aes128-nopad: " + raw16);

// PBKDF2 (HMAC-based) matches Node.
console.log("pbkdf2-sha256: " + crypto.pbkdf2Sync("password", "salt", 1000, 32, "sha256").toString("hex"));
console.log("pbkdf2-sha1: " + crypto.pbkdf2Sync("password", "salt", 100, 20, "sha1").toString("hex"));

// getCiphers surface + randomFillSync length.
console.log("ciphers: " + crypto.getCiphers().join(","));
const rf = Buffer.alloc(8);
crypto.randomFillSync(rf, 2, 4);
console.log("randfill-len: " + rf.length);
