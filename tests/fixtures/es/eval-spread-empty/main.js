var nextCount = 0;
var iter = {};
iter[Symbol.iterator] = function() {
  return {
    next: function() {
      nextCount++;
      return {done: true, value: undefined};
    }
  };
};
var result = eval(...iter);
console.log(result === undefined);
console.log(nextCount);
