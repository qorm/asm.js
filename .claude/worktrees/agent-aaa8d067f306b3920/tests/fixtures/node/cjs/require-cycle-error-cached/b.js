exports.name = "b";

const a = require("./a.js");

console.log("b-init", a.name);
throw "boom";
