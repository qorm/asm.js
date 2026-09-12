function copyInto(dest, src) {
  var d = new Uint8Array(dest);
  var s = new Uint8Array(src);
  for (var i = 0; i < s.length; i++) d[i] = s[i];
  return dest;
}
var src = new Uint8Array([10, 20, 30, 40]).buffer;
var dest = new ArrayBuffer(4);
copyInto(dest, src);
var out = new Uint8Array(dest);
console.log(out[0] + "," + out[1] + "," + out[2] + "," + out[3]);
