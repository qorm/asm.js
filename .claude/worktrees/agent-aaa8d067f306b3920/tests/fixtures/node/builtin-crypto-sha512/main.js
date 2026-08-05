import crypto from "node:crypto";

function h(algo, data, enc) {
    return crypto.createHash(algo).update(data).digest(enc);
}

// SHA-512 known vectors (hex).
console.log(h("sha512", "abc", "hex"));
console.log(h("sha512", "", "hex"));
console.log(h("sha512", "The quick brown fox jumps over the lazy dog", "hex"));
// Multi-block (> 111 bytes forces a second 128-byte block).
console.log(h("sha512", "0123456789".repeat(20), "hex"));
// base64 encoding.
console.log(h("sha512", "abc", "base64"));

// SHA-384.
console.log(h("sha384", "abc", "hex"));
console.log(h("sha384", "", "hex"));
console.log(h("sha384", "The quick brown fox jumps over the lazy dog", "hex"));

// Chained update.
const c = crypto.createHash("sha512");
c.update("The quick brown fox ");
c.update("jumps over the lazy dog");
console.log(c.digest("hex"));

// HMAC-SHA512 (block size 128) + HMAC-SHA384.
console.log(crypto.createHmac("sha512", "key").update("The quick brown fox jumps over the lazy dog").digest("hex"));
console.log(crypto.createHmac("sha384", "key").update("The quick brown fox jumps over the lazy dog").digest("hex"));
// HMAC-SHA512 with a key longer than the 128-byte block (forces key hashing).
console.log(crypto.createHmac("sha512", "k".repeat(200)).update("data").digest("hex"));
