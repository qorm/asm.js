var booleanObject = new Boolean(false);
booleanObject.charAt = String.prototype.charAt;
console.log(booleanObject.charAt(false) + booleanObject.charAt(true) + booleanObject.charAt(true + 1));

booleanObject.concat = String.prototype.concat;
console.log(booleanObject.concat("A", true, true + 1));

console.log(String.prototype.trim.call(new Number(123)));
