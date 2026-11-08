/**
 * Tiny CSV parser for the usage files the trackers write.
 *
 * Handles a header row, quoted fields with "" escapes (including embedded
 * commas and newlines), CRLF or LF, a trailing newline, a BOM and blank lines.
 * No dependency; never throws.
 */

export interface ParsedCsv {
  header: string[];
  rows: Record<string, string>[];
}

/** Split text into records of fields. */
export function parseCsvRecords(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let fieldStarted = false;

  const endField = () => {
    record.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    // A blank line is a single empty field: skip it.
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\r") {
      if (src[i + 1] === "\n") i++;
      endRecord();
    } else if (ch === "\n") {
      endRecord();
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (field !== "" || record.length > 0 || fieldStarted) endRecord();
  return records;
}

/**
 * Parse CSV text with a header row. Rows shorter than the header get empty
 * strings for the missing columns; extra fields are dropped.
 */
export function parseCsv(text: string): ParsedCsv {
  const records = parseCsvRecords(text);
  const first = records[0];
  if (!first) return { header: [], rows: [] };
  const header = first.map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r] ?? [];
    const row: Record<string, string> = {};
    header.forEach((name, idx) => {
      row[name] = rec[idx] ?? "";
    });
    rows.push(row);
  }
  return { header, rows };
}
