const H = 12;

// a fragment the way pdf.js hands it over, placed at a baseline
module.exports = function frag(str, x, y, opts) {
  const o = opts || {};
  return {
    str,
    width: o.width === undefined ? str.length * 6 : o.width,
    height: o.height === undefined ? H : o.height,
    transform: [1, 0, 0, H, x, y],
    hasEOL: !!o.hasEOL,
  };
};
