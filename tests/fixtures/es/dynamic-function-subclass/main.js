var GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;

class SubGeneratorFunction extends GeneratorFunction {}

var fn = new SubGeneratorFunction("value", "yield value;");
if (Object.getPrototypeOf(fn) !== SubGeneratorFunction.prototype) {
    throw new Error("dynamic function ignored NewTarget.prototype");
}
if (!(fn instanceof SubGeneratorFunction)) {
    throw new Error("dynamic function is not an instance of its NewTarget");
}
if (Object.prototype.hasOwnProperty.call(fn.prototype, "constructor")) {
    throw new Error("generator function prototype has an own constructor");
}
var iterator = fn(42);
if (iterator.next().value !== 42) {
    throw new Error("subclassed generator function does not execute");
}

class Parent {
    constructor() {
        if (arguments.length !== 3 || arguments[0] !== 1 ||
            arguments[1] !== undefined || arguments[2] !== 3) {
            throw new Error("default derived constructor did not forward exact args");
        }
    }
}
class Child extends Parent {}
new Child(1, undefined, 3);

console.log("ok");
