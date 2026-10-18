import React, { useEffect, useState } from 'react';

import { getAllGneState, refreshGne } from '../../core/api/gne_api';
import GneForecastPanel from '../components/gne/GneForecastPanel';
import GneModernizationPanel from '../components/gne/GneModernizationPanel';
import GnePartnersPanel from '../components/gne/GnePartnersPanel';
import GneSignalsTable from '../components/gne/GneSignalsTable';
import GneSummaryPanel from '../components/gne/GneSummaryPanel';

const EMPTY_STATE = { signals: [], semantics: [], classifications: [], forecasts: [], modernization: [], partners: [] };

export default function GrantNeuralEnginePage() {
  const [state, setState] = useState(EMPTY_STATE);
  const [status, setStatus] = useState('Loading Grant Neural Engine...');
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    getAllGneState({ refresh: true })
      .then((payload) => { if (active) { setState(payload); setStatus(''); } })
      .catch(() => { if (active) setStatus('Grant Neural Engine state is unavailable.'); });
    return () => { active = false; };
  }, []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setStatus('Refreshing all GNE sources...');
    try {
      setState(await refreshGne());
      setStatus('Refresh complete.');
    } catch {
      setStatus('Grant Neural Engine refresh failed.');
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <main className="gne-page">
      <header className="gne-page-header"><div><p>Grant Neural Engine</p><h1>Funding Signal Cockpit</h1><span>Signals, meaning, cycles, modernization, and ecosystem intelligence</span></div><button type="button" onClick={handleRefresh} disabled={isRefreshing}>{isRefreshing ? 'Refreshing...' : 'Refresh GNE'}</button></header>
      {status && <p className="gne-status" role="status">{status}</p>}
      <GneSummaryPanel signals={state.signals} forecasts={state.forecasts} modernization={state.modernization} partners={state.partners} />
      <div className="gne-primary-grid">
        <GneSignalsTable signals={state.signals} semantics={state.semantics} classifications={state.classifications} forecasts={state.forecasts} />
        <GneForecastPanel forecasts={state.forecasts} />
      </div>
      <div className="gne-secondary-grid">
        <GneModernizationPanel modernization={state.modernization} />
        <GnePartnersPanel partners={state.partners} />
      </div>
    </main>
  );
}
