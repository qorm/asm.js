// Custom-tag tagged templates: .raw on the strings array (via the array props
// side-table) + per-site template-object caching (node semantics).
function tag(s, ...v) { return s.join("|") + " raw:" + s.raw.join("|") + " vals:" + v.join(","); }
console.log(tag`a\nb`);
console.log(tag`x${1}y${2}z`);
function cookraw(s) { return JSON.stringify(s[0]) + " " + JSON.stringify(s.raw[0]); }
console.log(cookraw`p\tq`);
let saved = null;
function idTag(s) { if (saved === null) { saved = s; return "first"; } return saved === s ? "SAME" : "DIFF"; }
function run() { return idTag`abc${1}def`; }
console.log(run(), run());
function tagB(s) { return s; }
console.log(tagB`x` === tagB`x`); // distinct sites -> distinct objects
console.log(String.raw`a\nb ${1 + 1}`); // String.raw unaffected
