export class CsvParseError extends Error {}

// Deliberately reject multiline quoted fields: M2 only promises one business row per line.
export function parseCsv(content) {
  const source = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const rows = [];
  let cells = [];
  let field = "";
  let quoted = false;
  let justClosedQuote = false;
  let atFieldStart = true;
  let line = 1;

  function finishField() {
    cells.push(field);
    field = "";
    justClosedQuote = false;
    atFieldStart = true;
  }

  function finishRow() {
    finishField();
    rows.push({ rowNumber: line, cells });
    cells = [];
    line += 1;
  }

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\0") throw new CsvParseError("CSV 包含不支持的控制字符。");

    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
          justClosedQuote = true;
        }
      } else if (char === "\n" || char === "\r") {
        throw new CsvParseError(`第 ${line} 行包含不支持的跨行引号字段。`);
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      if (!atFieldStart || justClosedQuote) {
        throw new CsvParseError(`第 ${line} 行引号格式不正确。`);
      }
      quoted = true;
      atFieldStart = false;
      continue;
    }
    if (justClosedQuote && char !== "," && char !== "\n" && char !== "\r") {
      throw new CsvParseError(`第 ${line} 行引号结束后存在意外字符。`);
    }
    if (char === ",") {
      finishField();
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r") {
        if (source[i + 1] !== "\n") {
          throw new CsvParseError(`第 ${line} 行使用了不支持的换行格式。`);
        }
        i += 1;
      }
      finishRow();
      continue;
    }
    field += char;
    atFieldStart = false;
  }
  if (quoted) throw new CsvParseError(`第 ${line} 行引号未闭合。`);
  if (field.length || cells.length || justClosedQuote) finishRow();
  return rows;
}
