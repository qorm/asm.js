async function f(a, b, c) {
  print(typeof c);
  print(String(c));
}
f(false, "", NaN);

async function g(aFalse = 1, aString = 2, aNaN = 3) {
  print(String(aNaN));
}
g(false, "", NaN);
