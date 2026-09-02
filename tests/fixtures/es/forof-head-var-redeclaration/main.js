// A `var` declaration in the loop body redeclares the hoisted head binding;
// it must not reset the value assigned by the for-of iteration.
var seen = 0;
for (var value of [99]) {
  var value;
  if (value !== 99) throw new Error("for-of var redeclaration reset value");
  seen += 1;
}
console.log(seen, value);
