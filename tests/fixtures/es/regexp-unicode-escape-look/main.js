// Unicode CharacterEscape > 127 used to crash in parseAtom's
// `{ k:"str", cs: __re_utf8Str(code) }` literal.
var m = /\u00FF/.exec("\u00FF");
if (!m || m[0].charCodeAt(0) !== 255) throw new Error("u00FF");
m = /\u0410/.exec("\u0410");
if (!m || m[0].charCodeAt(0) !== 1040) throw new Error("u0410");
m = /\x00/.exec("\u0000");
if (!m || m[0].charCodeAt(0) !== 0) throw new Error("x00");
m = new RegExp("\\u0080").exec("\u0080");
if (!m || m[0].charCodeAt(0) !== 128) throw new Error("u0080");

// Lookaround node used to _object_set NULL at new RegExp("(?=a)").
if (!/(?=a)a/.test("a")) throw new Error("lookahead");
if (/(?!a)a/.test("a")) throw new Error("neg-lookahead");
if (!/(?<=a)b/.test("ab")) throw new Error("lookbehind");
if (/(?<!a)b/.test("ab")) throw new Error("neg-lookbehind");
console.log("ok");
