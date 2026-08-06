import { useEffect, useMemo, useState } from 'react';

const quickLinks = [
  { label: 'SAM.gov', href: 'https://sam.gov', icon: '🏛️' },
  { label: 'FPDS / FPDS-NG', href: 'https://www.fpds.gov', icon: '📑' },
  { label: 'USAspending.gov', href: 'https://www.usaspending.gov', icon: '💵' },
  { label: 'Acquisition.gov', href: 'https://www.acquisition.gov', icon: '📘' },
  { label: 'Agency Forecasts', href: '#', icon: '🛰️' },
  { label: 'SBA Size Standards', href: 'https://www.sba.gov/federal-contracting/contracting-guide/size-standards', icon: '📏' },
  { label: 'JE ROCKER LC Cover Page', href: '/cover', icon: '🏠' },
  { label: 'Primary Dashboard', href: '/primary-dashboard', icon: '📊' },
  { label: 'Client Dashboard', href: '/client-dashboard', icon: '🤝' },
];

const founderTracks = [
  {
    id: 'track1',
    title: 'Track 1 - GovTech Ingestion Engine',
    description: 'Keep ingestion quality high and weekly refreshes consistent.',
    bullets: [
      'Tighten opportunity extraction fidelity',
      'Validate match confidence drift each cycle',
      'Improve suppression precision by agency context',
    ],
  },
  {
    id: 'track2',
    title: 'Track 2 - Client Intelligence & Consulting',
    description: 'Translate signals into practical guidance for clients.',
    bullets: [
      'Convert raw results into executive-ready summaries',
      'Prioritize opportunities by readiness and fit',
      'Build repeatable weekly briefing cadence',
    ],
  },
  {
    id: 'track3',
    title: 'Track 3 - Elder Independence Concierge',
    description: 'Maintain strategy framing and roadmap checkpoints.',
    bullets: [
      'Document pilot workflows and service boundaries',
      'Identify strategic partners and integration needs',
      'Track compliance and policy requirements',
    ],
  },
  {
    id: 'track4',
    title: 'Track 4 - National Health ID System',
    description: 'Research alignment opportunities and program pathways.',
    bullets: [
      'Map federal stakeholders and policy levers',
      'Monitor related modernization solicitations',
      'Develop phased concept narrative',
    ],
  },
];

function toKvRows(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item, idx) => ({
      label: `item_${idx + 1}`,
      value: typeof item === 'object' ? JSON.stringify(item) : String(item),
    }));
  }
  if (typeof value === 'object') {
    return Object.entries(value).slice(0, 10).map(([k, v]) => ({
      label: k,
      value: typeof v === 'object' ? JSON.stringify(v) : String(v ?? 'N/A'),
    }));
  }
  return [{ label: 'result', value: String(value) }];
}

function SearchHud({ searchPayload }) {
  if (!searchPayload) {
    return <p>Run a search to see agency/vendor/NAICS/PSC/opportunity intelligence.</p>;
  }

  const { type, rows } = searchPayload;

  if (type === 'opportunity' && rows && typeof rows === 'object') {
    const opportunities = Array.isArray(rows.opportunities) ? rows.opportunities : [];
    const matches = Array.isArray(rows.matches) ? rows.matches : [];
    return (
      <div>
        <p><strong>Opportunity Results:</strong> {opportunities.length}</p>
        {opportunities.slice(0, 3).map((row, idx) => (
          <div className="kv" key={`opp-${idx}`}>
            <span>{row.notice_id || 'opportunity'}</span>
            <span>{row.title || row.agency || 'N/A'}</span>
          </div>
        ))}
        <p style={{ marginTop: 10 }}><strong>Matches:</strong> {matches.length}</p>
        {matches.slice(0, 3).map((row, idx) => (
          <div className="kv" key={`match-${idx}`}>
            <span>{row.opportunity_id || 'match'}</span>
            <span>{row.opportunity_title || row.fpds_agency || 'N/A'}</span>
          </div>
        ))}
      </div>
    );
  }

  const rowsAsKv = toKvRows(rows);
  return (
    <div>
      <p><strong>Result Type:</strong> {type || 'unknown'}</p>
      {rowsAsKv.length === 0 ? <p>No rows found.</p> : rowsAsKv.map((row, idx) => (
        <div className="kv" key={`${row.label}-${idx}`}>
          <span>{row.label}</span>
          <span>{row.value}</span>
        </div>
      ))}
    </div>
  );
}

function CockpitPanel({ id, icon, title, moduleName, rows, expandedPanel, setExpandedPanel }) {
  const isExpanded = expandedPanel === id;
  return (
    <section className={`bd-panel ${isExpanded ? 'bd-panel-expanded' : ''}`}>
      <button className="bd-panel-header" type="button" onClick={() => setExpandedPanel(isExpanded ? null : id)}>
        <span className="bd-panel-header-icon" aria-hidden="true">{icon}</span>
        <span>{title}</span>
        <span style={{ marginLeft: 'auto', opacity: 0.78 }}>{moduleName}</span>
      </button>
      <div className="bd-panel-body">
        {rows}
        {isExpanded && (
          <p style={{ marginTop: 10, color: '#67e8f9' }}>
            Expanded module view: additional operational detail can be surfaced here.
          </p>
        )}
      </div>
    </section>
  );
}

export function BusinessDriverPage() {
  const [summary, setSummary] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchPayload, setSearchPayload] = useState(null);
  const [searchHistory, setSearchHistory] = useState([]);
  const [expandedPanel, setExpandedPanel] = useState('hud');
  const [expandedTrack, setExpandedTrack] = useState('track1');
  const [agencyRadar, setAgencyRadar] = useState([]);
  const [vendorRadar, setVendorRadar] = useState([]);

  useEffect(() => {
    fetch('/api/dashboard_summary')
      .then((r) => r.json())
      .then((data) => setSummary(data))
      .catch(() => setSummary(null));

    fetch('/api/intel/agencies')
      .then((r) => r.json())
      .then((rows) => setAgencyRadar(Array.isArray(rows) ? rows.slice(0, 5) : []))
      .catch(() => setAgencyRadar([]));

    fetch('/api/intel/vendors')
      .then((r) => r.json())
      .then((rows) => setVendorRadar(Array.isArray(rows) ? rows.slice(0, 5) : []))
      .catch(() => setVendorRadar([]));
  }, []);

  const engineStatus = summary?.pipeline_status || 'Ready';
  const systemHealth = (engineStatus === 'Ready' && (summary?.forecasting_signals || 'Active') !== 'Down') ? 'Healthy' : 'Check';

  const runSearch = async () => {
    const trimmed = searchQuery.trim();
    if (!trimmed) return;
    const response = await fetch(`/api/internal_search?q=${encodeURIComponent(trimmed)}`);
    const payload = await response.json();
    setSearchPayload(payload);
    setSearchHistory((prev) => [trimmed, ...prev.filter((x) => x !== trimmed)].slice(0, 5));
  };

  const historyText = useMemo(() => {
    if (!searchHistory.length) return 'History: none yet';
    return `History: ${searchHistory.join(' • ')}`;
  }, [searchHistory]);

  return (
    <div className="business-driver-container">
      <aside className="bd-left-rail">
        <h3 className="bd-left-rail-title">Quick Links</h3>
        {quickLinks.map((link) => (
          <a className="bd-left-rail-link" key={link.label} href={link.href} target={link.href.startsWith('http') ? '_blank' : '_self'} rel="noreferrer">
            <span>{link.icon}</span>
            <span>{link.label}</span>
          </a>
        ))}
      </aside>

      <main>
        <h2 style={{ marginTop: 0 }}>Business Driver - Internal Cockpit</h2>

        <section className="bd-top-cluster">
          <div className="bd-top-cluster-item">🟢 <strong>engine_status</strong>: {engineStatus}</div>
          <div className="bd-top-cluster-item">🕒 <strong>last_scraper_run</strong>: {summary?.last_scraper_run || 'N/A'}</div>
          <div className="bd-top-cluster-item">⚙️ <strong>last_matcher_run</strong>: {summary?.last_matcher_run || 'N/A'}</div>
          <div className="bd-top-cluster-item">📅 <strong>next_refresh</strong>: Next refresh: Scheduled</div>
          <div className="bd-top-cluster-item">💚 <strong>system_health</strong>: {systemHealth}</div>
        </section>

        <div className="cover-divider-band" aria-hidden="true" />

        <section className="bd-command-console">
          <div className="search-row">
            <input
              className="bd-search-input"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
              placeholder="Search internal data: agencies, vendors, NAICS, PSC, opportunity ID, award ID, keywords, fiscal years"
            />
            <button type="button" onClick={runSearch}>Search</button>
          </div>
          <div className="bd-search-filters">Filters: agencies • vendors • NAICS • PSC • FY • keywords</div>
          <div className="bd-search-history">{historyText}</div>
        </section>

        <div className="cover-divider-band" aria-hidden="true" />

        <section className="bd-cockpit-grid">
          <CockpitPanel
            id="ingestion"
            icon="🧪"
            title="Ingestion Status"
            moduleName="Engine Health Module"
            expandedPanel={expandedPanel}
            setExpandedPanel={setExpandedPanel}
            rows={(
              <>
                <div className="kv"><span>total opportunities</span><span>{summary?.total_opportunities || 'N/A'}</span></div>
                <div className="kv"><span>last scraper run</span><span>{summary?.last_scraper_run || 'N/A'}</span></div>
                <div className="kv"><span>last matcher run</span><span>{summary?.last_matcher_run || 'N/A'}</span></div>
                <div className="kv"><span>pipeline status</span><span>{summary?.pipeline_status || 'Ready'}</span></div>
              </>
            )}
          />

          <CockpitPanel
            id="metrics"
            icon="📡"
            title="Engine Metrics"
            moduleName="Telemetry Module"
            expandedPanel={expandedPanel}
            setExpandedPanel={setExpandedPanel}
            rows={(
              <>
                <div className="kv"><span>total matches</span><span>{summary?.total_matches || 'N/A'}</span></div>
                <div className="kv"><span>matched opportunities</span><span>{summary?.matched_opportunities || 'N/A'}</span></div>
                <div className="kv"><span>match coverage</span><span>{summary?.match_coverage || 'N/A'}</span></div>
                <div className="kv"><span>forecasting signals</span><span>{summary?.forecasting_signals || 'Active'}</span></div>
              </>
            )}
          />

          <CockpitPanel
            id="spend"
            icon="⛽"
            title="Spend Status"
            moduleName="Systems/Fuel Module"
            expandedPanel={expandedPanel}
            setExpandedPanel={setExpandedPanel}
            rows={(
              <>
                <div className="kv"><span>spend ingestion status</span><span>{summary?.spend_ingestion_status || 'Loaded'}</span></div>
                <div className="kv"><span>years loaded</span><span>{summary?.years_loaded || '2019-2026'}</span></div>
                <div className="kv"><span>vendor updates</span><span>{summary?.vendor_updates || 'Available'}</span></div>
                <div className="kv"><span>agency spend updates</span><span>{summary?.agency_spend_updates || 'Available'}</span></div>
              </>
            )}
          />

          <CockpitPanel
            id="hud"
            icon="🧭"
            title="Search Results"
            moduleName="HUD Module"
            expandedPanel={expandedPanel}
            setExpandedPanel={setExpandedPanel}
            rows={<SearchHud searchPayload={searchPayload} />}
          />

          <CockpitPanel
            id="agency-radar"
            icon="🛰️"
            title="Agency Spend Trends"
            moduleName="Agency Radar Module"
            expandedPanel={expandedPanel}
            setExpandedPanel={setExpandedPanel}
            rows={agencyRadar.length ? agencyRadar.map((row, idx) => (
              <div className="kv" key={`agency-${idx}`}>
                <span>{row.name || row.agency || `agency_${idx + 1}`}</span>
                <span>{row.obligated || row.count || row.amount || 'N/A'}</span>
              </div>
            )) : <p>No agency radar data available.</p>}
          />

          <CockpitPanel
            id="vendor-radar"
            icon="📈"
            title="Vendor Activity"
            moduleName="Vendor Radar Module"
            expandedPanel={expandedPanel}
            setExpandedPanel={setExpandedPanel}
            rows={vendorRadar.length ? vendorRadar.map((row, idx) => (
              <div className="kv" key={`vendor-${idx}`}>
                <span>{row.name || row.vendor || `vendor_${idx + 1}`}</span>
                <span>{row.obligated || row.count || row.amount || 'N/A'}</span>
              </div>
            )) : <p>No vendor radar data available.</p>}
          />
        </section>
      </main>

      <aside className="bd-right-rail">
        <h3 className="bd-right-rail-title bd-right-rail-title-rail">Mission Panels</h3>
        <section className="bd-right-rail-panel">
          <h3 className="bd-right-rail-title">My Stats (Pilot Status Module)</h3>
          <div className="bd-right-rail-body">
            <div className="kv"><span>searches_today</span><span>0</span></div>
            <div className="kv"><span>opportunities_reviewed</span><span>0</span></div>
            <div className="kv"><span>clients_touched</span><span>0</span></div>
            <div className="kv"><span>ingestion_checks</span><span>0</span></div>
            <p>Your activity inside the JE ROCKER engine.</p>
          </div>
        </section>

        <section className="bd-right-rail-panel">
          <h3 className="bd-right-rail-title">Client Stats (Client Intelligence Module)</h3>
          <div className="bd-right-rail-body">
            <div className="kv"><span>active_clients</span><span>0</span></div>
            <div className="kv"><span>open_opportunities_for_clients</span><span>0</span></div>
            <div className="kv"><span>proposals_in_progress</span><span>0</span></div>
            <p>Snapshot of client-facing work.</p>
          </div>
        </section>

        <section className="bd-right-rail-panel">
          <h3 className="bd-right-rail-title">To-Do List (Mission Checklist Module)</h3>
          <div className="bd-right-rail-body bd-todo-list">
            {[
              'Review new matched opportunities',
              'Update client intelligence summaries',
              'Check agency spend trends',
              'Prepare weekly briefing',
            ].map((item) => (
              <label key={item} className="bd-todo-item">
                <input type="checkbox" />
                <span>{item}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="bd-right-rail-panel">
          <h3 className="bd-right-rail-title">Founder Tracks</h3>
          <div className="bd-right-rail-body">
            {founderTracks.map((track) => {
              const isOpen = expandedTrack === track.id;
              const trackIcon = track.id === 'track1' ? '🧩' : track.id === 'track2' ? '📈' : track.id === 'track3' ? '🧓' : '🪪';
              return (
                <article className="bd-track-panel" key={track.id}>
                  <button
                    className="bd-track-title"
                    type="button"
                    onClick={() => setExpandedTrack(isOpen ? null : track.id)}
                  >
                    <span>{trackIcon}</span>
                    <span>{track.title}</span>
                  </button>
                  {isOpen && (
                    <div className="bd-track-body">
                      <p>{track.description}</p>
                      <ul>
                        {track.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
                      </ul>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      </aside>

      <div className="bd-footer-tagline">JE ROCKER LC • Internal Intelligence Cockpit</div>
    </div>
  );
}

export default BusinessDriverPage;
