exports.name = "a";

const b = require("./b.js");

exports.fromB = b.name;
exports.ready = true;
