import React from 'react';

export default function GneForecastPanel({ forecasts = [] }) {
  return (
    <section className="gne-panel" aria-labelledby="gne-forecast-title">
      <h2 id="gne-forecast-title">Funding Forecasts</h2>
      <div className="gne-tile-list">
        {forecasts.length ? forecasts.map((forecast) => (
          <article className="gne-tile" key={`${forecast.source}-${forecast.title}`}>
            <h3>{forecast.title}</h3>
            <dl>
              <div><dt>Cycle</dt><dd>{forecast.cycle?.cycle_type || 'Unknown'}</dd></div>
              <div><dt>Probability</dt><dd>{Math.round((forecast.probability || 0) * 100)}%</dd></div>
              <div><dt>Volatility</dt><dd>{forecast.volatility || 'Unknown'}</dd></div>
              <div><dt>Expected release</dt><dd>{forecast.timeline?.expected_release_quarter || 'Unknown'}</dd></div>
            </dl>
          </article>
        )) : <p className="gne-empty">No GNE forecasts available.</p>}
      </div>
    </section>
  );
}
