var calls = [];
function mapFn(value) {
    calls.push(arguments[1]);
    return value;
}
Array.from({ 0: 41, 1: 42, length: 2 }, mapFn, {});
if (calls[0] !== 0) throw new Error("k0=" + calls[0]);
if (calls[1] !== 1) throw new Error("k1=" + calls[1]);
var n = 0;
function cb() {
    if (arguments[2][arguments[1]] !== arguments[0]) throw new Error("every");
    n = n + 1;
    return true;
}
if ([11, 12].every(cb) !== true) throw new Error("every ret");
if (n !== 2) throw new Error("n");
console.log(calls[0], calls[1], n);
