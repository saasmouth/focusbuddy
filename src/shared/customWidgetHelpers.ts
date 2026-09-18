// A small standard library handed to every generated widget.
//
// Chosen from evidence, not from a list of popular packages. Across the custom
// widgets actually generated in this workspace, what they reached for beyond
// built-ins was: maps and tiles (3 of 5), distance between coordinates (3 of 5),
// charting (2 of 5), CSV parsing (1 of 5), date formatting (1 of 5).
//
// Nothing from npm earns its place against that list. recharts and
// react-markdown are React components and cannot run in a plain sandboxed frame.
// dayjs is 1.9 MB to do what Intl already does. xlsx is 7.2 MB for a need no
// widget has yet had. Chart.js would be ~200 KB to replace forty lines of SVG.
// And a map needs no library at all: `img-src https:` is already permitted, so
// tiles are just images at computed coordinates.
//
// What those four things have in common is that they are SMALL AND EASY TO GET
// SUBTLY WRONG -- a CSV parser that breaks on a quoted comma, a Mercator
// projection that asks for tile row -1 at the poles, a haversine with the wrong
// radius. Writing them once, here, tested, is better than having them rewritten
// from memory in every generation.
//
// There is a second reason, and it is the practical one: every line the model
// does not have to write is generation budget left for the widget itself. These
// helpers exist partly because widgets were running out of room.
//
// Injected by the host alongside the plexi bridge, so they are always present
// and never something the model has to remember to include.

/** The helper source, as it is spliced into the sandboxed document. */
export function helperScript(): string {
  return `
  // ── plexi.geo ────────────────────────────────────────────────────────────
  var EARTH_KM = 6371.0088;
  var MERCATOR_LIMIT = 85.05112878;
  var geo = {
    /** Great-circle distance in kilometres. */
    distance: function (a, b) {
      if (!a || !b) return NaN;
      var toRad = Math.PI / 180;
      var dLat = (b.lat - a.lat) * toRad;
      var dLon = (b.lon - a.lon) * toRad;
      var s =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
      return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
    },
    /** Fractional tile coordinates. Clamps the RESULT, not just the input: at
     *  the exact Mercator limit the log/tan rounds a few parts in 1e11 past the
     *  edge, which floors to tile row -1 and requests a tile that does not exist. */
    project: function (p, zoom) {
      var n = Math.pow(2, zoom);
      var lat = Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, p.lat));
      var rad = (lat * Math.PI) / 180;
      var y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
      return { x: ((p.lon + 180) / 360) * n, y: Math.max(0, Math.min(n, y)) };
    },
    unproject: function (x, y, zoom) {
      var n = Math.pow(2, zoom);
      return {
        lon: (x / n) * 360 - 180,
        lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
      };
    },
    /** An OpenStreetMap tile URL. Requires the widget's network access to be on;
     *  with it off the image simply will not load, so say so in the UI. */
    tileUrl: function (x, y, z) {
      return 'https://tile.openstreetmap.org/' + z + '/' + x + '/' + y + '.png';
    },
    /** The tiles covering a box of w x h pixels centred on a point, each with the
     *  left/top offset to place it at. Draw them as <img> elements. */
    tilesFor: function (centre, zoom, w, h) {
      var size = 256;
      var c = geo.project(centre, zoom);
      var originX = c.x * size - w / 2;
      var originY = c.y * size - h / 2;
      var n = Math.pow(2, zoom);
      var out = [];
      var x0 = Math.floor(originX / size);
      var y0 = Math.floor(originY / size);
      for (var ty = y0; ty * size < originY + h; ty++) {
        if (ty < 0 || ty >= n) continue;
        for (var tx = x0; tx * size < originX + w; tx++) {
          var wrapped = ((tx % n) + n) % n;
          out.push({
            x: wrapped, y: ty, z: zoom,
            left: tx * size - originX,
            top: ty * size - originY,
            url: geo.tileUrl(wrapped, ty, zoom)
          });
        }
      }
      return out;
    }
  };

  // ── plexi.csv ────────────────────────────────────────────────────────────
  var csv = {
    /** Parse CSV into an array of row arrays. Handles quoted fields, embedded
     *  commas and newlines, and doubled quotes — the cases a hand-rolled split
     *  on ',' gets wrong and nobody notices until a real file arrives. */
    parse: function (text, delimiter) {
      var d = delimiter || ',';
      var rows = [];
      var row = [];
      var field = '';
      var quoted = false;
      var s = String(text == null ? '' : text).replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
      for (var i = 0; i < s.length; i++) {
        var ch = s[i];
        if (quoted) {
          if (ch === '"') {
            if (s[i + 1] === '"') { field += '"'; i++; }
            else quoted = false;
          } else field += ch;
          continue;
        }
        if (ch === '"') { quoted = true; continue; }
        if (ch === d) { row.push(field); field = ''; continue; }
        if (ch === '\\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        field += ch;
      }
      if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
      return rows;
    },
    /** Parse with the first row as headers, into an array of objects. */
    parseObjects: function (text, delimiter) {
      var rows = csv.parse(text, delimiter);
      if (rows.length === 0) return [];
      var head = rows[0].map(function (h) { return String(h).trim(); });
      return rows.slice(1).filter(function (r) {
        return r.some(function (c) { return String(c).trim() !== ''; });
      }).map(function (r) {
        var o = {};
        for (var i = 0; i < head.length; i++) o[head[i]] = r[i] === undefined ? '' : r[i];
        return o;
      });
    },
    /** Rows back to CSV text, quoting anything that needs it. */
    format: function (rows, delimiter) {
      var d = delimiter || ',';
      return (rows || []).map(function (r) {
        return (r || []).map(function (cell) {
          var v = cell == null ? '' : String(cell);
          return /["\\n]/.test(v) || v.indexOf(d) >= 0 ? '"' + v.replace(/"/g, '""') + '"' : v;
        }).join(d);
      }).join('\\n');
    }
  };

  // ── plexi.fmt ────────────────────────────────────────────────────────────
  // Intl, with the boilerplate removed. Follows the user's own locale.
  var fmt = {
    number: function (n, opts) {
      if (n == null || !isFinite(n)) return '—';
      try { return new Intl.NumberFormat(undefined, opts || {}).format(n); }
      catch (e) { return String(n); }
    },
    money: function (n, currency) {
      return fmt.number(n, { style: 'currency', currency: currency || 'GBP' });
    },
    percent: function (n, dp) {
      return fmt.number(n, { style: 'percent', maximumFractionDigits: dp == null ? 1 : dp });
    },
    date: function (value, opts) {
      var d = value instanceof Date ? value : new Date(value);
      if (isNaN(d.getTime())) return '—';
      try { return new Intl.DateTimeFormat(undefined, opts || { dateStyle: 'medium' }).format(d); }
      catch (e) { return d.toISOString().slice(0, 10); }
    },
    /** "2 h 15 min" from minutes. */
    duration: function (minutes) {
      if (minutes == null || !isFinite(minutes)) return '—';
      var m = Math.max(0, Math.round(minutes));
      var h = Math.floor(m / 60);
      return h > 0 ? h + ' h ' + (m % 60) + ' min' : m + ' min';
    }
  };
`
}
