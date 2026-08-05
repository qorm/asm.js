// Promise called without new must throw a TypeError; static methods and `new` still work.
function tag(f){ try{ f(); return "nothrow"; } catch(e){ return "threw:" + (e instanceof TypeError); } }
console.log("nonew", tag(function(){ Promise(function(){}); }));
var p = new Promise(function(resolve){ resolve(42); });
p.then(function(v){ console.log("resolved", v); });
Promise.resolve(7).then(function(v){ console.log("static", v); });
