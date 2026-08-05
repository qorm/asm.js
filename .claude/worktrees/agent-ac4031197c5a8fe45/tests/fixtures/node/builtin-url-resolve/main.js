import { URL, fileURLToPath, pathToFileURL } from "node:url";
console.log(new URL("../c", "https://a.com/a/b").href);
console.log(new URL("/x/y", "https://h.com/a/b").href);
console.log(new URL("?q=1", "https://h.com/a/b").href);
console.log(new URL("https://h.com/a/b/c/../../x").href);
console.log(fileURLToPath("file:///tmp/x.js"));
console.log(pathToFileURL("/tmp/x.js").href);
