import { useEffect, useMemo, useRef, useState } from 'react';
import '../styles/client.css';

const MODULES = [
  { key: 'weekly', label: 'Weekly Intelligence Report Panel', placeholder: 'Weekly intelligence is pending.' },
  { key: 'opportunities', label: 'Opportunity Feed Panel', placeholder: 'Opportunity analysis is pending.' },
  { key: 'matches', label: 'Matches Panel', placeholder: 'Match analysis is pending.' },
  { key: 'spend', label: 'Spend Trends Panel', placeholder: 'Spend analysis is pending.' },
  { key: 'vendors', label: 'Vendor Profiles Panel', placeholder: 'Vendor analysis is pending.' },
  { key: 'capture', label: 'Capture Plan Recommendations Panel', placeholder: 'Capture planning is pending.' },
];

function defaultModuleState() {
  return {
    summary: [],
    deep: null,
    status: 'Pending',
    loadingSummary: false,
    loadingDeep: false,
    error: '',
  };
}

export default function ClientDashboardPage() {
  const [searchTerm, setSearchTerm] = useState('');
  const [searchStatus, setSearchStatus] = useState('Pending client context');
  const [searchResults, setSearchResults] = useState([]);

  const [activeClient, setActiveClient] = useState(null);
  const [clientProfile, setClientProfile] = useState(null);
  const [clientOpportunities, setClientOpportunities] = useState([]);
  const [clientOpportunityIntel, setClientOpportunityIntel] = useState(null);

  const [moduleState, setModuleState] = useState(() => {
    const state = {};
    MODULES.forEach((module) => {
      state[module.key] = defaultModuleState();
    });
    return state;
  });

  const searchAbortRef = useRef(null);
  useEffect(() => {
    const clientId = new URLSearchParams(window.location.search).get('client_id');
    if (!clientId) return;

    activatePendingClient(clientId).catch(() => setSearchStatus('Unable to load linked client'));
  }, []);

  const canSearch = searchTerm.trim().length >= 2;

  const profileRows = useMemo(() => {
    if (!clientProfile) return [];
    return [
      ['client_name', clientProfile.client_name],
      ['UEI', clientProfile.uei],
      ['DUNS', clientProfile.duns],
      ['NAICS', clientProfile.naics],
      ['keywords', clientProfile.keywords],
      ['preferred agencies', clientProfile.preferred_agencies],
      ['past performance', clientProfile.past_performance],
      ['notes', clientProfile.notes],
    ];
  }, [clientProfile]);

  function resetModules(waitingText = 'Pending') {
    setModuleState(() => {
      const next = {};
      MODULES.forEach((module) => {
        next[module.key] = {
          ...defaultModuleState(),
          status: waitingText,
        };
      });
      return next;
    });
  }

  async function activatePendingClient(clientId) {
    const res = await fetch(`/api/client/${encodeURIComponent(String(clientId))}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('Unable to load client profile');
    const client = await res.json();

    setActiveClient(client);
    setClientProfile(client);
    setClientOpportunities([]);
    setClientOpportunityIntel(null);
    setSearchResults([]);
    setSearchStatus(`Pending client: ${client.client_name || `Client #${client.client_id}`}`);
    resetModules('Pending');
  }

  async function runSearch() {
    const term = searchTerm.trim();
    if (term.length < 2) {
      setSearchStatus('Enter at least 2 characters');
      setSearchResults([]);
      return;
    }

    if (searchAbortRef.current) {
      searchAbortRef.current.abort();
    }
    const controller = new AbortController();
    searchAbortRef.current = controller;

    setSearchStatus('Searching clients...');

    try {
      const res = await fetch(`/api/client/search?term=${encodeURIComponent(term)}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('Search request failed');
      const payload = await res.json();
      const clients = payload.clients || [];

      if (clients.length === 0) {
        setSearchStatus('No client found - create new client?');
        setSearchResults([]);
        return;
      }

      if (clients.length === 1) {
        await activatePendingClient(clients[0].client_id);
        return;
      }

      setSearchStatus('Multiple clients found. Select one.');
      setSearchResults(clients);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setSearchStatus('Client search unavailable');
      setSearchResults([]);
    }
  }

  return (
    <div className="dashboard-shell">
      <section className="page-hero">
        <p className="page-kicker">Client Intelligence Surface</p>
        <h1 className="page-hero-title">Client Dashboard</h1>
        <p className="page-hero-subtitle">Activate a client context to load intelligence modules and opportunity detail.</p>
      </section>

      <section className="client-search-bar">
        <input
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') runSearch();
          }}
          placeholder="Search client by name, UEI, DUNS, NAICS, or keyword"
        />
        <button onClick={runSearch} disabled={!canSearch}>Search Client</button>
      </section>

      <div className="pd-intel-status">{searchStatus}</div>

      {searchResults.length > 1 && (
        <div className="client-search-results">
          {searchResults.map((client) => (
            <button
              key={client.client_id}
              type="button"
              className="client-opportunity-card"
              onClick={() => activatePendingClient(client.client_id)}
            >
              <div><strong>{client.client_name || `Client #${client.client_id}`}</strong></div>
              <div className="intel-count">{client.uei || 'No UEI'} | {client.naics || 'No NAICS'}</div>
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-2">
        {MODULES.map((module) => {
          const state = moduleState[module.key];
          return (
            <section className="polish-panel" key={module.key}>
              <button className="polish-panel-header" type="button">
                <span>{module.label}</span>
              </button>
              <div className="polish-panel-body pd-intel-panel">
                <div className="pd-intel-status">{state.status}: {module.placeholder}</div>
                <div className="pd-intel-summary">
                  {(state.summary || []).map((row) => (
                    <div className="kv" key={row.label}>
                      <span>{row.label}</span>
                      <span>{row.value}</span>
                    </div>
                  ))}
                </div>
                <button
                  className="pd-intel-load-button"
                  type="button"
                  disabled
                >
                  Pending
                </button>
                {state.error ? <div className="pd-intel-error">{state.error}</div> : null}
              </div>
            </section>
          );
        })}
      </div>

      <section className="client-dashboard-container">
        <article className="client-profile-panel">
          <div className="client-panel-header">Client Profile</div>
          <div className="client-panel-body">
            {!profileRows.length ? 'Waiting for client...' : profileRows.map((row) => (
              <div className="kv" key={row[0]}>
                <span>{row[0]}</span>
                <span>{row[1] || 'N/A'}</span>
              </div>
            ))}
          </div>
        </article>

        <article className="client-opportunities-panel">
          <div className="client-panel-header">Top 10 Opportunities</div>
          <div className="client-panel-body">
            {!activeClient && 'Pending client activation.'}
            {activeClient && !clientOpportunities.length && 'Opportunity analysis is pending.'}
            {clientOpportunities.map((row) => (
              <button
                key={row.opportunity_id || row.title}
                type="button"
                className="client-opportunity-card"
                disabled
              >
                <div><strong>{row.title}</strong></div>
                <div className="intel-count">{row.agency} | PSC {row.psc}</div>
                <div className="intel-count">Relevance {row.relevance_score}% | Due {row.due_date || 'N/A'}</div>
                <div className="intel-count">Risk: {row.risk_indicators} | Confidence: {row.match_confidence}</div>
              </button>
            ))}
          </div>
        </article>

        <article className="client-opportunity-intel-panel">
          <div className="client-panel-header">Opportunity Intel</div>
          <div className="client-panel-body">
            {!activeClient && 'Pending client activation.'}
            {activeClient && !clientOpportunityIntel && 'Opportunity intelligence is pending.'}
            {clientOpportunityIntel && Object.entries(clientOpportunityIntel).map(([key, value]) => (
              <div className="kv" key={key}>
                <span>{key.replaceAll('_', ' ')}</span>
                <span>{String(value)}</span>
              </div>
            ))}
          </div>
        </article>
      </section>
    </div>
  );
}
