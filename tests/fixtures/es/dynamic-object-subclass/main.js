var make = new Function("return class DynamicObjectSubclass extends Object {}");
var C = make();
if (Object.getPrototypeOf(C) !== Object) {
    throw new Error("dynamic class constructor heritage lost Object identity");
}
if (Object.getPrototypeOf(C.prototype) !== Object.prototype) {
    throw new Error("dynamic class prototype heritage lost Object.prototype identity");
}
console.log("ok");
