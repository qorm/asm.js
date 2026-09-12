print(String(-(0 / 0) !== -(0 / 0)));
var o = {};
o.p = -(0 / 0);
print(String(o.p !== o.p));
o.q = 0 / 0;
print(String(o.q !== o.q));
