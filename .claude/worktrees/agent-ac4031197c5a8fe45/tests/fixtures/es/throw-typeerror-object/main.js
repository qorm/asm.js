// Engine-synthesized TypeErrors (destructure null, class/collection called without new)
// must be real TypeError objects: `e instanceof TypeError`, `e.name`, `e.message` all valid.
function tag(f){ try{ f(); return "nothrow"; } catch(e){ return (e instanceof TypeError) + "/" + e.name; } }

console.log("desnull", tag(function(){ var {a} = null; return a; }));
console.log("desundef", tag(function(){ var {b} = undefined; return b; }));
class C {}
console.log("classnonew", tag(function(){ C(); }));
console.log("mapnonew", tag(function(){ Map(); }));
console.log("setnonew", tag(function(){ Set(); }));

try { var {x} = null; } catch (e) {
  console.log("msgcheck", typeof e.message === "string" && e.message.length > 0);
}
