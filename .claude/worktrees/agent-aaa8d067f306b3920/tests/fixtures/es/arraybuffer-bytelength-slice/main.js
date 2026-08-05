const ab = new ArrayBuffer(16);
console.log(ab.byteLength);
console.log(ab.slice(4, 12).byteLength);
console.log(ab.slice(8).byteLength);
console.log(ab.slice().byteLength);
console.log(new ArrayBuffer(100).byteLength);
