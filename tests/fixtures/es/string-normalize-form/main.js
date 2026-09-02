function nameOf(fn) {
  try { fn(); return "none"; }
  catch (e) { return e && e.name ? e.name : "Error"; }
}

console.log("forms", "abc".normalize(), "abc".normalize("NFC"), "abc".normalize("NFD"), "abc".normalize("NFKC"), "abc".normalize("NFKD"));
console.log("invalid", nameOf(function() { "abc".normalize("BAD"); }));
console.log("symbol", nameOf(function() { "abc".normalize(Symbol("form")); }));
console.log("object", nameOf(function() { "abc".normalize({ toString: function() { throw new Error("form"); } }); }));
var normalize = String.prototype.normalize;
console.log("extracted", nameOf(function() { normalize.call("abc", "BAD"); }));
