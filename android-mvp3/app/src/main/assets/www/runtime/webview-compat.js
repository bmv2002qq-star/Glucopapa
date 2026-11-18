/* Compatibility for the stock Android 12 (Chromium 91) WebView. */
(() => {
  'use strict';

  if (typeof Object.hasOwn !== 'function') {
    Object.defineProperty(Object, 'hasOwn', {
      configurable: true,
      writable: true,
      value(object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
      },
    });
  }

  if (typeof Array.prototype.at !== 'function') {
    const maxLength = Number.MAX_SAFE_INTEGER;
    Object.defineProperty(Array.prototype, 'at', {
      configurable: true,
      writable: true,
      value(position) {
        if (this == null) throw new TypeError('Array.at requires an object');
        const object = Object(this);
        const length = Math.min(maxLength, Math.max(0, Math.trunc(+object.length))) || 0;
        const index = Math.trunc(+position) || 0;
        const offset = index < 0 ? length + index : index;
        return offset >= 0 && offset < length ? object[offset] : undefined;
      },
    });
  }
})();
