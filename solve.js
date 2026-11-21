// A faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader, the reference program of
// csv-reader-speed-01): run(input) returns exactly what csv-reader 1.0.0's readCsv returns for
// {text, header} — {columns, rows, errors} — but reads the text with indexOf/slice scanning
// instead of one character at a time.
//
// The semantics, as the reference states them (baseline/csv-reader/vendor/csv-reader/index.js):
// a U+FEFF at the very start is dropped; a record ends at LF or CRLF, and a line left with no
// characters is no record; outside quotes a CR not followed by LF is dropped (stray_cr); a field
// opening with a quote runs to the next quote that is not doubled, "" inside it is one quote and
// each CRLF or lone CR inside it is read as LF; what follows its closing quote, up to the next
// comma or line break, is appended as it stands (quote_junk, when the field ends); a quote that
// never closes is a literal character and the text after it is read again as unquoted
// (unterminated_quote); a quote inside an unquoted field is a literal character; fields stay
// strings, never trimmed or converted; columns is the first record when header is true, else null;
// rows holds the records after it, each padded with "" (short_row, with fields: its field count)
// or cut (long_row, with extra: the cut fields) to the first record's width; each error is
// {code, line, row} in the order met, a record's short_row or long_row when it ends: line the
// 1-based line its record starts on, counting every LF, CRLF and lone CR inside quotes, and row
// its record's index in rows, null for the header.
//
// How it stays identical while going faster:
// - An unquoted field ends at the next comma or LF, found with indexOf; the field is one slice,
//   unless a stray CR has to be dropped, which is the rare path (a stray CR is found by a short
//   scan of the field, never by an unbounded search).
// - A quoted field runs to the next quote, found with indexOf; doubled quotes become one quote;
//   a line break inside quotes takes the slow path, which follows the reference character by
//   character, so the line counting and the CR-to-LF reading inside quotes are the reference's own.
// - Nothing is kept from one case to the next: every call builds its own rows and errors.
//
// Ended codes: 0 at a comma (the record goes on), 1 at a line break, 2 at the end of the text.

/** csv-reader 1.0.0's answer for one case's input, read faster. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;
  let fields = [];

  // Reads an unquoted field from pos, starting from the string already kept in `init` ('' for a
  // plain field, '"' when a quote that never closed is re-read as unquoted, the quoted value when
  // what follows a closing quote is read). When `junk` is true this is the read after a closing
  // quote, and a quote_junk error is recorded when it kept any character. Returns how the field
  // ended (0 comma, 1 line break, 2 end) and pushes the field onto `fields`.
  function unquoted(init, junk) {
    let start = pos;
    let parts = null; // kept pieces, only once a stray CR has split the field
    let added = 0; // characters kept after `init` (a stray CR keeps none)
    for (;;) {
      const comma = text.indexOf(',', start);
      const lf = text.indexOf('\n', start);
      let m;
      let kind;
      if (comma === -1 && lf === -1) {
        m = n;
        kind = 2;
      } else if (lf === -1 || (comma !== -1 && comma < lf)) {
        m = comma;
        kind = 0;
      } else {
        m = lf;
        kind = 1;
      }
      // The first CR inside the field, if any: a CR right before a terminating LF is the CRLF
      // that ends the field; any other CR is a stray CR, dropped with an error.
      let r = -1;
      for (let j = start; j < m; j++) {
        if (text.charCodeAt(j) === 13) {
          r = j;
          break;
        }
      }
      if (r === -1) {
        const seg = text.slice(start, m);
        added += seg.length;
        if (parts === null) fields.push(init !== '' ? init + seg : seg);
        else {
          parts.push(seg);
          fields.push(parts.join(''));
        }
        if (kind === 0) pos = m + 1;
        else if (kind === 1) {
          pos = m + 1;
          line += 1;
        } else pos = n;
        if (junk && added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        return kind;
      }
      if (kind === 1 && r === m - 1) {
        const seg = text.slice(start, r);
        added += seg.length;
        if (parts === null) fields.push(init !== '' ? init + seg : seg);
        else {
          parts.push(seg);
          fields.push(parts.join(''));
        }
        pos = m + 1;
        line += 1;
        if (junk && added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        return 1;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      const seg = text.slice(start, r);
      added += seg.length;
      if (parts === null) parts = init !== '' ? [init] : [];
      parts.push(seg);
      start = r + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Returns how the field ended and pushes
  // the field onto `fields`. A line break inside the quotes hands the whole field to quotedSlow,
  // which follows the reference character by character.
  function quoted() {
    const open = pos;
    const openLine = line;
    let start = pos + 1;
    let parts = null; // kept pieces, only once a doubled quote has split the field
    for (;;) {
      const q = text.indexOf('"', start);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is read
        // again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return unquoted('"', false);
      }
      let br = -1;
      for (let j = start; j < q; j++) {
        const c = text.charCodeAt(j);
        if (c === 10 || c === 13) {
          br = j;
          break;
        }
      }
      if (br !== -1) return quotedSlow(open, openLine);
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote; the field runs on after it.
        if (parts === null) parts = [];
        parts.push(text.slice(start, q), '"');
        start = q + 2;
        continue;
      }
      const seg = text.slice(start, q);
      const value = parts === null ? seg : (parts.push(seg), parts.join(''));
      pos = q + 1;
      if (pos >= n) {
        fields.push(value);
        return 2;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fields.push(value);
        return 0;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fields.push(value);
        return 1;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fields.push(value);
        return 1;
      }
      // What follows the closing quote is appended as it stands, up to the next comma or
      // line break.
      return unquoted(value, true);
    }
  }

  // A quoted field that holds a line break, read exactly as the reference reads it: one
  // character at a time, each CRLF or lone CR inside it one LF, doubled quotes one quote.
  function quotedSlow(open, openLine) {
    let value = '';
    let p = open + 1;
    let ln = openLine;
    let closed = false;
    while (p < n) {
      const c = text[p];
      if (c === '"') {
        if (text[p + 1] === '"') {
          value += '"';
          p += 2;
          continue;
        }
        p += 1;
        closed = true;
        break;
      }
      if (c === '\r') {
        value += '\n';
        ln += 1;
        p += text[p + 1] === '\n' ? 2 : 1;
        continue;
      }
      if (c === '\n') ln += 1;
      value += c;
      p += 1;
    }
    if (!closed) {
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return unquoted('"', false);
    }
    line = ln;
    pos = p;
    if (pos >= n) {
      fields.push(value);
      return 2;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fields.push(value);
      return 0;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fields.push(value);
      return 1;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fields.push(value);
      return 1;
    }
    return unquoted(value, true);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    fields = [];
    let ended;
    let lastQuoted = false;
    // A record holding no quote at all could be read as one line split on commas, but only
    // about a quarter of records hold no quote, and the check costs every record more than
    // the split saves: the field-by-field read below stays faster overall (measured).
    do {
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        ended = quoted();
      } else {
        lastQuoted = false;
        ended = unquoted('', false);
      }
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr
    // errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
