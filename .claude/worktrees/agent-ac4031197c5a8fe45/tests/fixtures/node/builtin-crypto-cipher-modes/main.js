import crypto from "node:crypto";
import { Buffer } from "node:buffer";

const key128 = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
const key256 = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
const iv16 = Buffer.from("aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb", "hex");
const iv12 = Buffer.from("cafebabecafebabecafebabe", "hex");
const pt = "Hello, AES cipher modes! A longer-than-one-block message.";

// ---- CTR (no padding, encrypt==decrypt), byte-exact vs Node ----
function ctrEnc(algo, key, plain) {
    const c = crypto.createCipheriv(algo, key, iv16);
    return c.update(plain, "utf8", "hex") + c.final("hex");
}
function ctrDec(algo, key, cthex) {
    const d = crypto.createDecipheriv(algo, key, iv16);
    return d.update(cthex, "hex", "utf8") + d.final("utf8");
}
const ctr128 = ctrEnc("aes-128-ctr", key128, pt);
const ctr256 = ctrEnc("aes-256-ctr", key256, pt);
console.log("ctr128: " + ctr128);
console.log("ctr256: " + ctr256);
console.log("ctr128-rt: " + (ctrDec("aes-128-ctr", key128, ctr128) === pt ? "OK" : "FAIL"));
console.log("ctr256-rt: " + (ctrDec("aes-256-ctr", key256, ctr256) === pt ? "OK" : "FAIL"));

// ---- GCM: ciphertext + auth tag, byte-exact vs Node ----
function gcmEnc(algo, key, plain, aad) {
    const c = crypto.createCipheriv(algo, key, iv12);
    if (aad) c.setAAD(Buffer.from(aad, "utf8"));
    const ct = c.update(plain, "utf8", "hex") + c.final("hex");
    return { ct: ct, tag: c.getAuthTag().toString("hex") };
}
function gcmDec(algo, key, cthex, taghex, aad) {
    const d = crypto.createDecipheriv(algo, key, iv12);
    if (aad) d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(Buffer.from(taghex, "hex"));
    return d.update(cthex, "hex", "utf8") + d.final("utf8");
}

const g256 = gcmEnc("aes-256-gcm", key256, pt);
console.log("gcm256-ct: " + g256.ct);
console.log("gcm256-tag: " + g256.tag);
console.log("gcm256-rt: " + (gcmDec("aes-256-gcm", key256, g256.ct, g256.tag) === pt ? "OK" : "FAIL"));

const g128 = gcmEnc("aes-128-gcm", key128, pt);
console.log("gcm128-ct: " + g128.ct);
console.log("gcm128-tag: " + g128.tag);

// GCM with additional authenticated data.
const gAad = gcmEnc("aes-256-gcm", key256, pt, "header-v1");
console.log("gcm256-aad-tag: " + gAad.tag);
console.log("gcm256-aad-rt: " + (gcmDec("aes-256-gcm", key256, gAad.ct, gAad.tag, "header-v1") === pt ? "OK" : "FAIL"));

// Tampered tag must fail authentication.
let tamper = "FAIL";
try {
    const badTag = g256.tag.slice(0, g256.tag.length - 2) + (g256.tag.slice(-2) === "00" ? "11" : "00");
    gcmDec("aes-256-gcm", key256, g256.ct, badTag);
} catch (e) { tamper = "THROWS"; }
console.log("gcm256-tamper: " + tamper);

const cs = crypto.getCiphers();
console.log("has-ctr: " + (cs.indexOf("aes-256-ctr") >= 0));
console.log("has-gcm: " + (cs.indexOf("aes-256-gcm") >= 0));
