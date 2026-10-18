import React from 'react';

export function summarizeGneState({ signals = [], forecasts = [], modernization = [], partners = [] } = {}) {
  const sourceBreakdown = signals.reduce((counts, signal) => {
    const source = signal.source || 'Unknown';
    counts[source] = (counts[source] || 0) + 1;
    return counts;
  }, {});
  return {
    totalSignals: signals.length,
    totalForecasts: forecasts.length,
    modernizationCycles: modernization.filter((item) => item.cycle?.type === 'modernization').length,
    partnerEcosystems: partners.filter((item) => item.partners?.length).length,
    sourceBreakdown,
  };
}

export default function GneSummaryPanel(props) {
  const summary = summarizeGneState(props);
  const sources = Object.keys(summary.sourceBreakdown).sort();
  return (
    <section className="gne-panel gne-summary-panel" aria-labelledby="gne-summary-title">
      <h2 id="gne-summary-title">Grant Neural Engine Summary</h2>
      <div className="gne-summary-grid">
        <div><strong>{summary.totalSignals}</strong><span>Signals</span></div>
        <div><strong>{summary.totalForecasts}</strong><span>Forecasts</span></div>
        <div><strong>{summary.modernizationCycles}</strong><span>Modernization cycles</span></div>
        <div><strong>{summary.partnerEcosystems}</strong><span>Partner ecosystems</span></div>
      </div>
      <div className="gne-source-breakdown">
        {sources.length ? sources.map((source) => <span key={source}>{source}: {summary.sourceBreakdown[source]}</span>) : <span>No sources loaded</span>}
      </div>
    </section>
  );
}
