var o = { v: 1 };
o[Symbol.unscopables] = { v: true };
var outer = 2;
{
  var v = outer;
  with (o) {
    print(String(v));
  }
}
