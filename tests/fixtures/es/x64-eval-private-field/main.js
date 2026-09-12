var F = new Function("return class { #x=1; get x(){ return this.#x; } }");
var C = F();
var o = new C();
print(String(o.x));
