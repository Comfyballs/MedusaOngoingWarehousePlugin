'use strict';
var Buffer = require('buffer').Buffer;

// Node.js v26 removed SlowBuffer; this shim provides the same API used by jwa.
function bufferEq(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  var c = 0;
  for (var i = 0; i < a.length; i++) {
    c |= a[i] ^ b[i];
  }
  return c === 0;
}

bufferEq.install = function() {};
bufferEq.restore = function() {};

module.exports = bufferEq;
