const ref = new ReferenceError("missing");
console.log(ref.name);
console.log(ref.message);
console.log(String(ref));

const typeErr = new TypeError("bad");
console.log(typeErr.name);
console.log(typeErr.message);
console.log(String(typeErr));
