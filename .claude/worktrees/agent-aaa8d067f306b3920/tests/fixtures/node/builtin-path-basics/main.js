import path from "node:path";

console.log(path.join("a", "b", "c"));
console.log(path.dirname("/a/b/c.js"));
console.log(path.basename("/a/b/c.js"));
console.log(path.basename("/a/b/c.js", ".js"));
console.log(path.extname("/a/b/c.js"));
console.log(path.normalize("a/./b/../c"));
console.log(path.isAbsolute("/x"));
console.log(path.isAbsolute("x"));
console.log(path.relative("/a/b", "/a/c/d"));
console.log(path.sep);
const p = path.parse("/a/b/c.js");
console.log(p.base + " " + p.ext + " " + p.name);
