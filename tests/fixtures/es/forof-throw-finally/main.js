// A throw from a for-of body's finally block must escape the protected try
// exactly once.  In particular, it must not jump back to the same finalizer
// (which would increment count twice before the outer catch observes it).
var ErrorType = function () {};
var error = new ErrorType();
var count = 0;
var closed = 0;
var iterable = {
  [Symbol.iterator]: function () {
    return {
      next: function () { return { value: 1, done: false }; },
      return: function () { closed += 1; return { done: true }; }
    };
  }
};

var caught = false;
try {
  for (var value of iterable) {
    try {
    } finally {
      count += 1;
      throw error;
    }
  }
} catch (e) {
  caught = e === error;
}

console.log(count, closed, caught);
