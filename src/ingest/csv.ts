/**
 * Minimal CSV parser — handles quoted fields with commas, escaped quotes,
 * and CRLF/LF line endings. Good enough for our synthetic seed and small
 * real-world exports. If we ever ingest messy multi-line free text, swap
 * for `papaparse`.
 */

export function parseCsv(text: string): Array<Record<string, string>> {
  // Strip UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return [];
  const header = rows[0]!;
  return rows.slice(1).filter((r) => r.some((v) => v.length > 0)).map((r) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) obj[header[i]!] = r[i] ?? "";
    return obj;
  });
}
