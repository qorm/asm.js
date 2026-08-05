let e = new Error("boom");
console.log(e + "");
console.log("" + e);
console.log(new TypeError("t") + "");
console.log(new RangeError("r") + "!");
console.log([e, new Error("x")].map(x => x + "").join(" / "));
