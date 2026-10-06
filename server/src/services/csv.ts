/** Dependency-free RFC-4180 style CSV parse/serialise. */

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          let value = cell === null || cell === undefined ? '' : String(cell);
          // Neutralise spreadsheet formula injection when the file is opened in Excel/Sheets.
          const isNumeric = /^-?\d+(\.\d+)?$/.test(value);
          if (!isNumeric && /^[=+@\-\t\r]/.test(value)) value = `'${value}`;
          return /["\n\r,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        })
        .join(','),
    )
    .join('\r\n');
}

/** Heuristic used by the import preview when the file has no header row match. */
export function guessColumn(header: string, candidates: string[]): string | null {
  const norm = header.trim().toLowerCase().replace(/[\s_-]+/g, '');
  for (const candidate of candidates) {
    const c = candidate.toLowerCase().replace(/[\s_-]+/g, '');
    if (norm === c) return candidate;
  }
  for (const candidate of candidates) {
    const c = candidate.toLowerCase().replace(/[\s_-]+/g, '');
    if (norm.includes(c) || c.includes(norm)) return candidate;
  }
  return null;
}
