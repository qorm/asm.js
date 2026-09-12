var w = new String("hello");
print(w.charAt(0));
print(w.split("l", 1)[0]);
print(String.prototype.substring.call(w, 0, 2));
print(String.prototype.slice.call(w, 0, 2));
