// C.prototype.constructor and instance.constructor point back to the class.
class C { constructor(){ this.x = 1; } foo(){ return 9; } }
console.log("proto", C.prototype.constructor === C);
console.log("inst", new C().constructor === C);
console.log("body", new C().x, new C().foo());
console.log("typeof", typeof C.prototype.constructor);

class D extends C { constructor(){ super(); this.y = 2; } }
console.log("dproto", D.prototype.constructor === D);
console.log("dinst", new D().constructor === D);
console.log("dinherit", new D().foo(), new D().x, new D().y);
