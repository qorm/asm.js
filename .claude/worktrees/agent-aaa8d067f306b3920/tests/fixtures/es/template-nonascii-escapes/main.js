// Template-literal \x / \u / \u{} / surrogate-pair escapes cook to UTF-8, raw non-ASCII
// passes through, String.raw preserves the raw text, and invalid escapes in a tagged
// template (String.raw`\x` with no hex) don't break parsing.
const x = 7;
console.log(`accent \xe9`);
console.log(`bmp 你`);
console.log(`astral \u{1F600}`);
console.log(`surr 😀`);
console.log(`raw 你好 café 🎉`);
console.log(`interp 你${x}好`);
console.log(String.raw`C:\temp\x A\n keep`);
console.log(String.raw`\xe9 你 \u{1F600}`);
