import path from "node:path";
console.log(path.format({ dir: "/a/b", name: "f", ext: ".txt" }));
console.log(path.format({ dir: "/a/b", name: "f", ext: "txt" }));
console.log(path.format({ root: "/", base: "file.js" }));
console.log(path.format({ name: "noext" }));
console.log(path.format({ base: "only.js" }));
