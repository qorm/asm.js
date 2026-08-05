// Guards the string behaviors that the compiled compiler gets RIGHT (UTF-8-aware):
// code-point iteration (spread/for-of over astral), string/template \x/\u/\u{}/surrogate
// escape cooking to UTF-8, raw non-ASCII passthrough, and normalize() identity. The
// index/length/charCode ops are byte-model (UTF-16 deep item) and are intentionally NOT
// asserted here (see string catalog in docs/ES_SUPPORT.md).
const spreadAstral = [..."a😀b"].length === 3;
let n = 0; for (const c of "你好世") n++;
const forofCjk = n === 3;
const strEsc = "\xe9" === "é" && "你" === "你" && "😀" === "😀" && "\u{1F389}" === "🎉";
const tmplEsc = `\xe9` === "é" && `\u{1F600}` === "😀" && `你${1}好` === "你1好";
const rawIntact = String.raw`\xe9 你` === "\\xe9 你";
const norm = "café".normalize("NFC") === "café";
const ok = spreadAstral && forofCjk && strEsc && tmplEsc && rawIntact && norm;
console.log(ok ? "string-surface-ok" : "string-surface-FAIL");
