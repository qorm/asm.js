var source = '\u00C5\u2ADC\u0958\u2126\u0344';
console.log('default', source.normalize());
console.log('forms', '\u1E9B\u0323'.normalize('NFD'), '\u1E9B\u0323'.normalize('NFKC'), '\u1E9B\u0323'.normalize('NFKD'));
console.log('coerced', source.normalize(['NFC']), source.normalize({ toString: function() { return 'NFD'; } }));
