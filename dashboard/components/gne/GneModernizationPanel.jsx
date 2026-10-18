import React from 'react';

export default function GneModernizationPanel({ modernization = [] }) {
  return (
    <section className="gne-panel" aria-labelledby="gne-modernization-title">
      <h2 id="gne-modernization-title">Modernization Intelligence</h2>
      <div className="gne-tile-list">
        {modernization.length ? modernization.map((item) => (
          <article className="gne-tile" key={`${item.source}-${item.title}`}>
            <h3>{item.title}</h3>
            <p>Density <strong>{Math.round((item.density || 0) * 100)}%</strong> · Relevance <strong>{item.relevance || 0}</strong></p>
            <p>{item.cycle?.type === 'modernization' ? `${item.cycle.start} to ${item.cycle.end}` : 'No modernization cycle detected'}</p>
            <div className="gne-tags">{(item.alignment || []).map((tag) => <span key={tag}>{tag}</span>)}</div>
          </article>
        )) : <p className="gne-empty">No modernization intelligence available.</p>}
      </div>
    </section>
  );
}
