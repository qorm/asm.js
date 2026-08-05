// require(fs/os/path) namespace members must be reachable under g1 (compiled compiler).
const fs = require("fs");
const os = require("os");
const path = require("path");
const ok = typeof fs.readFileSync === "function" &&
    typeof fs.writeFileSync === "function" &&
    typeof os.platform === "function" && os.EOL === "\n" &&
    path.join("a", "b", "c") === "a/b/c" && path.sep === "/" &&
    path.basename("/x/y.txt") === "y.txt";
console.log(ok ? "require-namespace-ok" : "require-namespace-FAIL");
