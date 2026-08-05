const err = new Error("boom");

console.log(err.name);
console.log(err.message);
console.log(String(err));
console.log(err);
console.log(err.cause === undefined);
