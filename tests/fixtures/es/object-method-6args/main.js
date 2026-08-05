var obj = {
    m: function(a, b, c, d, e, f) {
        if (a !== 10) { console.log("arg0 failed: expected 10 got", a); process.exit(1); }
        if (b !== 20) { console.log("arg1 failed: expected 20 got", b); process.exit(1); }
        if (c !== 30) { console.log("arg2 failed: expected 30 got", c); process.exit(1); }
        if (d !== 40) { console.log("arg3 failed: expected 40 got", d); process.exit(1); }
        if (e !== 50) { console.log("arg4 failed: expected 50 got", e); process.exit(1); }
        if (f !== 60) { console.log("arg5 failed: expected 60 got", f); process.exit(1); }
        return "ok";
    }
};

var result = obj.m(10, 20, 30, 40, 50, 60);
if (result !== "ok") { console.log("result failed:", result); process.exit(1); }

var m = obj.m;
var callResult = m.call(obj, 10, 20, 30, 40, 50, 60);
if (callResult !== "ok") { console.log("call result failed:", callResult); process.exit(1); }

console.log("6args ok");