var MyU8 = new Function("return class MyU8 extends Uint8Array {}")();
console.log(typeof MyU8);
console.log(MyU8.BYTES_PER_ELEMENT);
console.log(Object.getPrototypeOf(MyU8) === Uint8Array);
var rab = new ArrayBuffer(4, { maxByteLength: 8 });
var ta = new MyU8(rab, 0, 4);
console.log(ta.length);
console.log(ta instanceof Uint8Array);
