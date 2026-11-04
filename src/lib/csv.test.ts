import { describe, expect, it } from "vitest";
import { csvCell, csvRow } from "./csv";

describe("csvCell", () => {
  it("leaves plain values as they are", () => {
    expect(csvCell("gpt-4.1")).toBe("gpt-4.1");
    expect(csvCell(1200)).toBe("1200");
    expect(csvCell("0.006000")).toBe("0.006000");
  });

  it("writes null and undefined as empty cells", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("quotes commas, quotes and line breaks (RFC 4180)", () => {
    expect(csvCell("Acme, Inc.")).toBe('"Acme, Inc."');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell("cr\rlf")).toBe('"cr\rlf"');
  });

  it.each(["=SUM(A1:A9)", "+1+1", "-2+3", "@cmd", "\tx", "\rx"])(
    "neutralizes text a spreadsheet would run as a formula: %j",
    (value) => {
      const cell = csvCell(value);
      const unquoted = cell.startsWith('"')
        ? cell.slice(1, -1).replaceAll('""', '"')
        : cell;
      expect(unquoted).toBe(`'${value}`);
    },
  );

  it("quotes a neutralized formula that also needs quoting", () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(
      `"'=HYPERLINK(""http://x"",""y"")"`,
    );
  });

  it("keeps negative numbers as numbers", () => {
    expect(csvCell(-5)).toBe("-5");
  });
});

describe("csvRow", () => {
  it("joins cells with commas and ends with CRLF", () => {
    expect(csvRow(["a", 1, null, "b,c"])).toBe('a,1,,"b,c"\r\n');
  });
});
