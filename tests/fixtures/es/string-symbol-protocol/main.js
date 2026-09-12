var separator = {};
separator[Symbol.split] = function(value, limit) {
  return "custom:" + (this === separator) + ":" + value + ":" + limit;
};
console.log("".split(separator, "limit"));

var searchValue = {
  toString: function() { return {}; },
  valueOf: function() { throw "insearchValue"; }
};
try {
  new String("AB").replace(searchValue, "x");
} catch (error) {
  console.log(error);
}
