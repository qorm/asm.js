const answer = require("./module-exports.js");
const named = require("./exports-object.js");

console.log(answer.value);
console.log(named.kind);
console.log(typeof __filename);
console.log(typeof __dirname);
