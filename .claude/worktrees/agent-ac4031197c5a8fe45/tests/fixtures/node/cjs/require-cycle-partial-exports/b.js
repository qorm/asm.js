exports.name = "b";

const a = require("./a.js");

exports.fromA = a.name;
exports.seesReady = a.ready === true ? "yes" : "no";
