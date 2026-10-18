import React from 'react';

export default function GnePartnersPanel({ partners = [] }) {
  return (
    <section className="gne-panel" aria-labelledby="gne-partners-title">
      <h2 id="gne-partners-title">Partner Ecosystems</h2>
      <div className="gne-tile-list">
        {partners.length ? partners.map((item) => (
          <article className="gne-tile" key={`${item.source}-${item.title}`}>
            <h3>{item.title}</h3>
            <p>Density <strong>{Math.round((item.ecosystem_density || 0) * 100)}%</strong> · Relevance <strong>{item.relevance || 0}</strong></p>
            <ul>{(item.partners || []).map((partner) => <li key={partner}>{partner}</li>)}</ul>
            <div className="gne-tags">{(item.alignment || []).map((tag) => <span key={tag}>{tag}</span>)}</div>
          </article>
        )) : <p className="gne-empty">No partner ecosystems available.</p>}
      </div>
    </section>
  );
}
