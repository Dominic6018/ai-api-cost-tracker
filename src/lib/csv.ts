/**
 * CSV for spreadsheets: RFC 4180 quoting, plus protection against formula
 * injection, since some cells hold text chosen by API callers.
 */

/** Characters that make Excel, Sheets and LibreOffice treat a cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One cell. Text that a spreadsheet would run as a formula gets a leading
 * apostrophe, which spreadsheets show as plain text. Numbers are written as
 * they are, so negative amounts stay numbers.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One line, CRLF-terminated as RFC 4180 specifies. */
export function csvRow(
  values: readonly (string | number | null | undefined)[],
) {
  return `${values.map(csvCell).join(",")}\r\n`;
}
