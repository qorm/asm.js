// Self-host probe: non-ASCII string literals must survive the compiled compiler intact,
// not be double-encoded (你好 -> mojibake) or truncated. Covers raw UTF-8 (CJK/accent/
// astral), \x, \uNNNN (BMP), 😀 surrogate pairs, and \u{...} code-point escapes
// in plain strings, object keys, JSON and templates. Source is read latin1 (raw bytes) and
// escapes are decoded to UTF-8 bytes by the lexer, then emitted verbatim (asm/*.js), so the
// g1-compiled output equals node's byte-for-byte.
const rawCjk = "你好";
const rawAcc = "café";
const rawAstral = "😀";
const xEsc = "\xe9";           // é as UTF-8 c3 a9
const uBmp = "你";          // 你
const uSurr = "😀";  // 😀 via surrogate pair
const uCp = "\u{1F389}";       // 🎉 via code-point escape
const key = JSON.stringify({ "名": "値" });
const tmpl = `模板${1 + 1}🎉`;
const ok =
    rawCjk === "你好" && rawAcc === "café" && rawAstral.length > 0 &&
    xEsc === "é" && uBmp === "你" && uSurr === "😀" && uCp === "🎉" &&
    key.indexOf("名") !== -1 && key.indexOf("値") !== -1 &&
    tmpl === "模板2🎉" && ["一", "二"].join("") === "一二";
console.log(ok ? "nonascii-ok" : "nonascii-FAIL");
