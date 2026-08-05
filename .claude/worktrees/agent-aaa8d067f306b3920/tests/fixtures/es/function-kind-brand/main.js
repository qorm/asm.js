const ts = (x) => Object.prototype.toString.call(x);
// expression forms
console.log(ts(function () {}));
console.log(ts(function* () {}));
console.log(ts(async function () {}));
console.log(ts(async function* () {}));
const a = async () => 1;
console.log(ts(a));
// declaration forms (registered via compileFunction)
function* gd() { yield 1; }
async function ad() {}
async function* agd() { yield 1; }
console.log(ts(gd));
console.log(ts(ad));
console.log(ts(agd));
