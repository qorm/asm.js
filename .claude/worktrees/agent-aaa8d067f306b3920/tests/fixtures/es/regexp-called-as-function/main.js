let b = RegExp("y", "i");
console.log(b.global, b.source, b.flags, b.ignoreCase);
console.log(RegExp("x", "g").global, RegExp("\\d+").test("42"));
console.log(RegExp("abc").source, RegExp("a", "gi").flags);
let r = RegExp("(\\d+)");
console.log("n42".match(r)[1]);
console.log(RegExp(/pre/).source);
console.log(RegExp("t").toString());
