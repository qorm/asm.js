// ES [[OwnPropertyKeys]] order: integer-index keys ascending first, then string
// keys in insertion order — across keys/values/entries/for-in/JSON/assign.
console.log(Object.keys({b:1, 2:1, a:1, 1:1}).join(","));           // 1,2,b,a
console.log(Object.getOwnPropertyNames({b:1, 2:1, a:1, 1:1}).join(",")); // 1,2,b,a
console.log(Object.values({b:"B", 2:"two", a:"A", 1:"one"}).join(",")); // one,two,B,A
console.log(JSON.stringify(Object.entries({b:1, 2:2, a:3, 1:4})));  // [["1",4],["2",2],["b",1],["a",3]]
console.log(JSON.stringify({b:1, 2:2, a:3, 1:4}));                  // {"1":4,"2":2,"b":1,"a":3}
var fi=[]; for (var k in {b:1, 2:1, a:1, 1:1}) fi.push(k); console.log(fi.join(",")); // 1,2,b,a
var t={}; Object.assign(t, {b:1, 2:2, a:3, 1:4}); console.log(Object.keys(t).join(",")); // 1,2,b,a
// canonical-index edge cases: leading zero / negative / >=2^32-1 stay as string keys
var e={}; e["01"]=1; e["1"]=1; e["-1"]=1; e["4294967295"]=1; e.x=1; e["2"]=1;
console.log(Object.keys(e).join(","));                             // 1,2,01,-1,4294967295,x
// adversarial: defineProperty integer key + delete/re-add must still re-sort
var o={1:1, b:1}; Object.defineProperty(o, "0", {value:1, enumerable:true, configurable:true});
console.log(Object.keys(o).join(","));                             // 0,1,b
var d={0:1, 1:1, 2:1, a:1}; delete d[1]; d[1]=1;
console.log(Object.keys(d).join(","));                            // 0,1,2,a
// pure string-keyed object unchanged (insertion order)
console.log(Object.keys({banana:1, apple:1, cherry:1}).join(",")); // banana,apple,cherry
