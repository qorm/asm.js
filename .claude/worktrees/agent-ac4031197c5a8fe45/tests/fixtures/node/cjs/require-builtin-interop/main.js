const path = require("node:path");
console.log(path.sep);
console.log(path.join("a", "b"));
console.log(path.basename("/x/y.js"));

const EventEmitter = require("node:events");
console.log(typeof EventEmitter);
const e = new EventEmitter();
e.on("go", (v) => console.log("fired:" + v));
e.emit("go", 7);

const fs = require("node:fs");
console.log(typeof fs);
console.log(typeof fs.writeFileSync);

const os = require("node:os");
console.log(os.EOL === "\n");
