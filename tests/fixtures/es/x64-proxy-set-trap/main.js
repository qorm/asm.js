var env = { p: 0 };
var n = 0;
var proxy = new Proxy(env, {
  set: function (t, pk, v) {
    n = n + 1;
    t[pk] = v;
    return true;
  }
});
proxy.p = 1;
print(String(n));
print(String(env.p));
with (proxy) {
  p += 1;
}
print(String(env.p));
