const { createWorker } = require('./baseWorker');
const { getSource } = require('../lib/registry');
const { largestTable } = require('../lib/html');

const source = getSource('nasa_sbir');

/** NASA publishes open solicitations as a single HTML table, not an API. */
function parse(html) {
  const rows = largestTable(html);
  if (rows.length < 2) return [];

  const [header, ...body] = rows;
  return body
    .filter((cells) => cells.length >= 3 && cells[0])
    .map((cells) => {
      const record = {};
      header.forEach((name, index) => {
        record[name || `column_${index}`] = cells[index] ?? null;
      });
      record.agency = 'NASA';
      record.program = /sttr/i.test(cells[0]) ? 'STTR' : 'SBIR';
      return { externalId: cells[0], url: source.endpoint, record };
    });
}

module.exports = createWorker(source, parse);
