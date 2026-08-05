// Embedded-NUL transparency: runtime string concat must copy by length
// (not stop at the first \x00). Bytes after an embedded NUL survive.
var a = String.fromCharCode(65, 0, 66); // "A\0B", length 3
var b = String.fromCharCode(67, 0, 68); // "C\0D", length 3
var c = a + b;
console.log(c.length);
var out = [];
for (var i = 0; i < c.length; i++) out.push(c.charCodeAt(i));
console.log(out.join(","));
// concat with a NUL-containing string then plain text
var d = a + "xy";
console.log(d.length, d.charCodeAt(0), d.charCodeAt(1), d.charCodeAt(2), d.charCodeAt(3), d.charCodeAt(4));
// indexOf past an embedded NUL
console.log(c.indexOf("D"));
