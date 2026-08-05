import crypto from "node:crypto";
import { Buffer } from "node:buffer";

function hex(digest, ikm, salt, info, len) {
    return Buffer.from(crypto.hkdfSync(digest, ikm, salt, info, len)).toString("hex");
}

// RFC 5869 Appendix A.1 — SHA-256 basic test vector.
const ikm = Buffer.from("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", "hex");
const salt = Buffer.from("000102030405060708090a0b0c", "hex");
const info = Buffer.from("f0f1f2f3f4f5f6f7f8f9", "hex");
console.log("a1: " + hex("sha256", ikm, salt, info, 42));

// RFC 5869 Appendix A.3 — SHA-256, zero-length salt and info.
const ikm3 = Buffer.from("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", "hex");
console.log("a3: " + hex("sha256", ikm3, Buffer.alloc(0), Buffer.alloc(0), 42));

// String IKM/salt/info + sha512.
console.log("s512: " + hex("sha512", "secret-key-material", "my-salt", "app-context", 64));

// sha1 output, longer than one hash block (needs 2 expand rounds).
console.log("s1: " + hex("sha1", "input", "salt", "ctx", 40));
