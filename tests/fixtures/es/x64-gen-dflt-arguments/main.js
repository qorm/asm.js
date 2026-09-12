var f = function*(x = arguments[2], y = arguments[3], z) {
  print(String(x));
  print(String(y));
  print(String(z));
};
f(undefined, undefined, "third", "fourth").next();
