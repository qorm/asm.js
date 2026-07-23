// T2a 边界:访问器类(ACCESSOR_FREE=0)getter/setter 正常 + 继承
class Base {
    get x() { return this._x || 0; }
    set x(v) { this._x = v * 2; }
    plain() { return "p"; }
}
class Sub extends Base { bump() { return this.x + 1; } }
const s = new Sub();
s.x = 5;
console.log(s.x, s.bump(), s.plain());
