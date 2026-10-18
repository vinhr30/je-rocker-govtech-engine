import React, { useState } from 'react';

function recordKey(item = {}) {
  return `${item.source || ''}|${item.title || ''}|${item.published_date || ''}`;
}

export function buildSignalRows(signals = [], semantics = [], classifications = [], forecasts = []) {
  const semanticMap = new Map(semantics.map((item) => [recordKey(item), item]));
  const classificationMap = new Map(classifications.map((item) => [recordKey(item), item]));
  const forecastMap = new Map(forecasts.map((item) => [recordKey(item), item]));
  return signals.map((signal) => {
    const key = recordKey(signal);
    return {
      ...signal,
      funding_amount: semanticMap.get(key)?.funding_amount ?? null,
      categories: classificationMap.get(key)?.categories || [],
      probability: forecastMap.get(key)?.probability ?? null,
    };
  });
}

function formatFunding(value) {
  if (value === null || value === undefined) return 'Not extracted';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

export default function GneSignalsTable({ signals = [], semantics = [], classifications = [], forecasts = [] }) {
  const [selected, setSelected] = useState(null);
  const rows = buildSignalRows(signals, semantics, classifications, forecasts);
  return (
    <section className="gne-panel gne-signals-panel" aria-labelledby="gne-signals-title">
      <h2 id="gne-signals-title">Grant Signals</h2>
      {rows.length ? (
        <div className="gne-table-wrap">
          <table>
            <thead><tr><th>Source</th><th>Title</th><th>Published</th><th>Funding</th><th>Categories</th><th>Probability</th></tr></thead>
            <tbody>{rows.map((row) => (
              <tr key={recordKey(row)} tabIndex="0" onClick={() => setSelected(row)} onKeyDown={(event) => { if (event.key === 'Enter') setSelected(row); }}>
                <td>{row.source}</td><td>{row.title}</td><td>{row.published_date}</td><td>{formatFunding(row.funding_amount)}</td><td>{row.categories.join(', ') || 'general'}</td><td>{row.probability === null ? 'N/A' : `${Math.round(row.probability * 100)}%`}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className="gne-empty">No grant signals available.</p>}
      {selected && (
        <div className="gne-modal" role="dialog" aria-modal="true" aria-labelledby="gne-modal-title" onClick={() => setSelected(null)}>
          <article className="gne-modal-content" onClick={(event) => event.stopPropagation()}>
            <button type="button" aria-label="Close signal detail" onClick={() => setSelected(null)}>×</button>
            <h3 id="gne-modal-title">{selected.title}</h3>
            <p>{selected.raw_text || 'No article text available.'}</p>
          </article>
        </div>
      )}
    </section>
  );
}
