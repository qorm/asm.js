// IEEE remainder keeps the sign of a zero dividend, including when the
// divisor is negative. This is a native-backend regression fixture.
console.log(1 / (0 % 1), 1 / (0 % -1), 1 / (-0 % 1), 1 / (-0 % -1));
console.log(5 % 2, -5 % 2, 5 % -2, -5 % -2);
