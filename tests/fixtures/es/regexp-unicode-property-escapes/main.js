// Unicode property resolution and membership across binary, General_Category,
// Script, Script_Extensions, BMP boundaries, and an astral code point.
console.log("ascii",
  /^\p{ASCII}$/u.test("\x7f"),
  /^\p{ASCII}$/u.test("\u0080"),
  /^\P{ASCII}$/u.test("\u0080"));

console.log("gc",
  /^\p{General_Category=Decimal_Number}$/u.test("0"),
  /^\p{gc=Nd}$/u.test("\u0660"),
  /^\p{Nd}$/u.test("A"));

console.log("script",
  /^\p{Script=Latin}$/u.test("A"),
  /^\p{sc=Latn}$/u.test("\u03b1"));

console.log("scx",
  /^\p{Script_Extensions=Latin}$/u.test("\u0300"),
  /^\p{Script=Latin}$/u.test("\u0300"));

console.log("astral",
  /^\p{Lu}$/u.test("\u{10400}"),
  /^\p{Script=Deseret}$/u.test("\u{10400}"),
  /^\P{Script=Deseret}$/u.test("\u{10400}"));

function alphabeticRun(length) {
  const codePoints = [];
  for (let i = 0; i < length; i++) codePoints[i] = 0x41;
  const input = String.fromCodePoint.apply(null, codePoints);
  return input.length === length && /^\p{Alphabetic}+$/u.test(input);
}

function alphabeticConcat(length) {
  let input = "";
  for (let i = 0; i < length; i++) input += "A";
  return input.length === length && /^\p{Alphabetic}+$/u.test(input);
}

const twoCodePoints = [0x41, 0x41];
const twoFromApply = String.fromCodePoint.apply(null, twoCodePoints);
console.log("apply",
  twoFromApply.length,
  twoFromApply === "AA",
  /^\p{Alphabetic}+$/u.test(twoFromApply));
console.log("concat",
  alphabeticConcat(2),
  alphabeticConcat(16),
  alphabeticConcat(100));

console.log("repeat",
  alphabeticRun(1),
  alphabeticRun(2),
  alphabeticRun(3),
  alphabeticRun(4),
  alphabeticRun(5),
  alphabeticRun(6),
  alphabeticRun(7),
  alphabeticRun(8),
  alphabeticRun(16),
  alphabeticRun(32),
  alphabeticRun(48),
  alphabeticRun(64),
  alphabeticRun(100),
  alphabeticRun(1000),
  alphabeticRun(10000));
