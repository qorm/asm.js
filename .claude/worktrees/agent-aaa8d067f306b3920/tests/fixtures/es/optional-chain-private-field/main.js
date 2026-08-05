// Optional chaining onto a private field: o?.#x must read the private slot when o is set.
class C {
  #x = 42;
  pub = 7;
  viaOpt(o)      { return o?.#x; }
  viaOptPub(o)   { return o?.pub; }
  viaDefault(o = this) { return o?.#x; }
}
var c = new C();
console.log("optthis", c.viaOpt(c));
console.log("optnull", c.viaOpt(null) === undefined);
console.log("optpub", c.viaOptPub(c));
console.log("default", c.viaDefault());
console.log("defaultnull", c.viaDefault(null) === undefined);
