import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCsv } from "../../src/core/usage/csv";

describe("usage csv parser", () => {
  it("parses a header and rows with LF and a trailing newline", () => {
    const r = parseCsv("a,b\n1,2\n3,4\n");
    assert.deepEqual(r.header, ["a", "b"]);
    assert.deepEqual(r.rows, [
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("handles CRLF, no trailing newline and blank lines", () => {
    const r = parseCsv("a,b\r\n1,2\r\n\r\n3,4");
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[1]?.b, "4");
  });

  it("handles quoted fields with commas, escaped quotes and newlines", () => {
    const r = parseCsv('a,b\n"x,y","he said ""hi"""\n"line1\nline2",z\n');
    assert.equal(r.rows[0]?.a, "x,y");
    assert.equal(r.rows[0]?.b, 'he said "hi"');
    assert.equal(r.rows[1]?.a, "line1\nline2");
  });

  it("strips a BOM and pads short rows", () => {
    const r = parseCsv("﻿a,b,c\n1,2\n");
    assert.deepEqual(r.header, ["a", "b", "c"]);
    assert.deepEqual(r.rows[0], { a: "1", b: "2", c: "" });
  });

  it("keeps empty fields and returns nothing for empty input", () => {
    assert.deepEqual(parseCsv("a,b\n,\n").rows[0], { a: "", b: "" });
    assert.deepEqual(parseCsv(""), { header: [], rows: [] });
    assert.deepEqual(parseCsv("\n\n").rows, []);
  });

  it("does not throw on an unterminated quote", () => {
    const r = parseCsv('a,b\n"oops,1\n');
    assert.equal(r.rows.length, 1);
  });
});
