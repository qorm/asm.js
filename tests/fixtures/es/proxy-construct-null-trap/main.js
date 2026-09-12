var calls = 0;
var Target = new Proxy(function () { throw new Error("target"); }, {
    construct: function (_T, args) {
        calls += 1;
        return { sum: args[0] + args[1] };
    }
});
var P = new Proxy(Target, { construct: null });
var obj = new P(3, 4);
if (calls !== 1) throw new Error("calls=" + calls);
if (obj.sum !== 7) throw new Error("sum=" + obj.sum);
console.log("ok");
