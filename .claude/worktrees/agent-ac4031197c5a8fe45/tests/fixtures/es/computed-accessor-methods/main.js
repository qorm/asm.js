// Computed accessor methods: get [expr]() / set [expr](v) in classes AND object literals.
// A get/set pair sharing one key expression is merged into a single accessor.

// --- class: computed getter + setter (same key expression) ---
const key = "value";
class Box {
  constructor(n) { this._n = n; }
  get [key]() { return this._n * 2; }
  set [key](v) { this._n = v; }
}
const b = new Box(10);
console.log("class-get " + b.value);   // 20
b.value = 7;
console.log("class-set " + b.value);   // 14

// --- class: static computed getter ---
const vk = "VERSION";
class Cfg { static get [vk]() { return 42; } }
console.log("class-static " + Cfg.VERSION); // 42

// --- class: computed setter only ---
const pk = "p";
class S { set [pk](v) { this._p = v * 3; } }
const s = new S();
s.p = 4;
console.log("class-setonly " + s._p); // 12

// --- object literal: computed getter + setter ---
const k = "prop";
const o = {
  _p: 0,
  get [k]() { return this._p + 1; },
  set [k](v) { this._p = v * 10; },
};
console.log("obj-get " + o.prop); // 1
o.prop = 5;
console.log("obj-set " + o.prop); // 51

// --- object literal: computed getter only ---
const ok = "answer";
const o2 = { get [ok]() { return 99; } };
console.log("obj-getonly " + o2.answer); // 99

// --- regression: plain (non-computed) accessors unaffected ---
class Plain { get x() { return 5; } set x(v) { this._x = v; } }
const pp = new Plain();
pp.x = 8;
console.log("plain " + pp.x + " " + pp._x); // 5 8
