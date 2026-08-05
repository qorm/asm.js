// Object.prototype.toString on generator / async-generator objects.
// Both are coroutine-backed plain objects (TYPE_OBJECT) with no distinct type
// byte, so on native they fall through to [object Object]. The wasi backend
// probes the internal "__gen_coro" slot (set by _generator_new /
// _async_generator_new) as a reliable discriminator, then distinguishes async
// via the presence of the "Symbol.asyncIterator" slot.
// native runs compile-only (returns the incorrect [object Object], to be fixed
// in the native lane by an object-header/type-byte change); wasm behaviour is
// asserted via expectWasm.
function* g() { yield 1; }
async function* ag() { yield 1; }
const t = Object.prototype.toString;
console.log(t.call(g()));
console.log(t.call(ag()));
// negative controls: a plain object and a custom (non-generator) iterable must
// NOT be branded as generators.
console.log(t.call({}));
console.log(t.call({ [Symbol.asyncIterator]() { return this; } }));
