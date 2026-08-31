function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function extractTables(html) {
  return String(html).match(/<table[\s\S]*?<\/table>/gi) || [];
}

/** Returns each row as an array of cell strings, header row included. */
function extractRows(tableHtml) {
  return (String(tableHtml).match(/<tr[\s\S]*?<\/tr>/gi) || []).map((row) =>
    (row.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || []).map(stripTags),
  );
}

function extractLinks(html, baseUrl) {
  const links = [];
  for (const match of String(html).matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = stripTags(match[2]);
    if (!text) continue;
    let href = decodeEntities(match[1]);
    if (baseUrl) {
      try {
        href = new URL(href, baseUrl).toString();
      } catch {
        continue;
      }
    }
    links.push({ href, text });
  }
  return links;
}

/** Picks the table containing the most data rows, used for listing pages. */
function largestTable(html) {
  let best = null;
  for (const table of extractTables(html)) {
    const rows = extractRows(table);
    if (!best || rows.length > best.length) best = rows;
  }
  return best || [];
}

module.exports = {
  decodeEntities,
  extractLinks,
  extractRows,
  extractTables,
  largestTable,
  stripTags,
};
