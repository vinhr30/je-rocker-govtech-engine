import { useMemo, useRef, useState } from 'react';
import '../styles/client.css';

const MODULES = [
  { key: 'weekly', label: 'Weekly Intelligence Report Panel' },
  { key: 'opportunities', label: 'Opportunity Feed Panel' },
  { key: 'matches', label: 'Matches Panel' },
  { key: 'spend', label: 'Spend Trends Panel' },
  { key: 'vendors', label: 'Vendor Profiles Panel' },
  { key: 'capture', label: 'Capture Plan Recommendations Panel' },
];

function defaultModuleState() {
  return {
    summary: [],
    deep: null,
    status: 'Waiting for client...',
    loadingSummary: false,
    loadingDeep: false,
    error: '',
  };
}

export default function ClientDashboardPage() {
  const [searchTerm, setSearchTerm] = useState('');
  const [searchStatus, setSearchStatus] = useState('Waiting for client...');
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
  const moduleAbortRef = useRef({});
  const opportunityAbortRef = useRef(null);

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

  function resetModules(waitingText = 'Waiting for client...') {
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

  async function loadModuleSummary(moduleKey, clientId) {
    setModuleState((prev) => ({
      ...prev,
      [moduleKey]: {
        ...prev[moduleKey],
        loadingSummary: true,
        status: 'Loading summary...',
        error: '',
      },
    }));

    try {
      const res = await fetch(`/api/client/intel/${moduleKey}?client_id=${encodeURIComponent(String(clientId))}&view=summary`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Summary request failed');
      const payload = await res.json();
      setModuleState((prev) => ({
        ...prev,
        [moduleKey]: {
          ...prev[moduleKey],
          summary: payload.summary || [],
          status: 'Summary loaded',
          loadingSummary: false,
        },
      }));
    } catch (_error) {
      setModuleState((prev) => ({
        ...prev,
        [moduleKey]: {
          ...prev[moduleKey],
          loadingSummary: false,
          status: 'Unable to load summary',
          error: 'Unable to load summary',
        },
      }));
    }
  }

  async function loadModuleDeep(moduleKey) {
    if (!activeClient?.client_id) return;

    if (moduleAbortRef.current[moduleKey]) {
      moduleAbortRef.current[moduleKey].abort();
    }
    const controller = new AbortController();
    moduleAbortRef.current[moduleKey] = controller;

    setModuleState((prev) => ({
      ...prev,
      [moduleKey]: {
        ...prev[moduleKey],
        loadingDeep: true,
        status: 'Loading deeper intelligence...',
        error: '',
      },
    }));

    try {
      const res = await fetch(`/api/client/intel/${moduleKey}?client_id=${encodeURIComponent(String(activeClient.client_id))}&view=deep`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('Deep intel request failed');
      const payload = await res.json();
      setModuleState((prev) => ({
        ...prev,
        [moduleKey]: {
          ...prev[moduleKey],
          deep: payload.deep || null,
          loadingDeep: false,
          status: 'Intelligence ready',
        },
      }));
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setModuleState((prev) => ({
        ...prev,
        [moduleKey]: {
          ...prev[moduleKey],
          loadingDeep: false,
          status: 'Unable to load intelligence',
          error: 'Unable to load intelligence',
        },
      }));
    }
  }

  async function activateClient(clientLite) {
    const res = await fetch(`/api/client/${encodeURIComponent(String(clientLite.client_id))}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('Unable to load client profile');
    const client = await res.json();

    setActiveClient(client);
    setClientProfile(client);
    setClientOpportunities([]);
    setClientOpportunityIntel(null);
    setSearchResults([]);
    setSearchStatus(`Active client: ${client.client_name || `Client #${client.client_id}`}`);

    resetModules('Loading summary...');

    await Promise.all(MODULES.map((module) => loadModuleSummary(module.key, client.client_id)));

    const opportunitiesRes = await fetch(`/api/client/intel/opportunities?client_id=${encodeURIComponent(String(client.client_id))}&view=deep`, {
      cache: 'no-store',
    });
    if (!opportunitiesRes.ok) throw new Error('Unable to load opportunities');
    const opportunitiesPayload = await opportunitiesRes.json();
    setClientOpportunities(opportunitiesPayload.opportunities || []);
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
        setSearchStatus('Client found. Activating context...');
        await activateClient(clients[0]);
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

  async function loadOpportunityIntel(opportunityId) {
    if (!activeClient?.client_id || !opportunityId) return;

    if (opportunityAbortRef.current) {
      opportunityAbortRef.current.abort();
    }
    const controller = new AbortController();
    opportunityAbortRef.current = controller;

    setClientOpportunityIntel({ loading: 'Loading opportunity intelligence...' });

    try {
      const res = await fetch(`/api/client/intel/opportunity/${encodeURIComponent(String(opportunityId))}?client_id=${encodeURIComponent(String(activeClient.client_id))}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('Opportunity intel request failed');
      const payload = await res.json();
      setClientOpportunityIntel(payload.intel || null);
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setClientOpportunityIntel({ error: 'Unable to load opportunity intelligence.' });
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
              onClick={() => activateClient(client)}
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
                <div className="pd-intel-status">{state.status}</div>
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
                  disabled={!activeClient || state.loadingDeep}
                  onClick={() => loadModuleDeep(module.key)}
                >
                  Load Intelligence
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
            {!activeClient && 'Waiting for client...'}
            {activeClient && !clientOpportunities.length && 'No opportunities loaded.'}
            {clientOpportunities.map((row) => (
              <button
                key={row.opportunity_id || row.title}
                type="button"
                className="client-opportunity-card"
                onClick={() => loadOpportunityIntel(row.opportunity_id || row.title)}
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
            {!activeClient && 'Waiting for opportunity selection...'}
            {activeClient && !clientOpportunityIntel && 'Click an opportunity to load intelligence.'}
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
