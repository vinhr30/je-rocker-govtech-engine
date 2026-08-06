import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const PANEL_META = {
  competitive: {
    title: 'Competitive Landscape Panel',
    module: 'Market Pressure Module',
    icon: '🧩',
    summaryEndpoint: '/api/primary/competitive-summary',
    intelEndpoint: '/api/primary/competitive-intel',
  },
  agency: {
    title: 'Agency Behavior Panel',
    module: 'Buying Motion Module',
    icon: '🏢',
    summaryEndpoint: '/api/primary/agency-summary',
    intelEndpoint: '/api/primary/agency-intel',
  },
  vendor: {
    title: 'Vendor History Panel',
    module: 'Past Performance Module',
    icon: '📚',
    summaryEndpoint: '/api/primary/vendor-summary',
    intelEndpoint: '/api/primary/vendor-intel',
  },
  capture: {
    title: 'Capture Plan Generator Panel',
    module: 'Action Design Module',
    icon: '📝',
    summaryEndpoint: '/api/primary/capture-summary',
    intelEndpoint: '/api/primary/capture-intel',
  },
  submission: {
    title: 'Submission Tracker Panel',
    module: 'Execution Module',
    icon: '📬',
    summaryEndpoint: '/api/primary/submission-summary',
    intelEndpoint: '/api/primary/submission-intel',
  },
};

function signalIcon(signal) {
  if (signal === 'up') return '▲';
  if (signal === 'alert') return '●';
  return '■';
}

function normalizeSummaryRows(payload) {
  if (!payload || !Array.isArray(payload.summary)) return [];
  return payload.summary.map((row) => ({
    label: String(row.label || 'metric'),
    value: String(row.value || 'N/A'),
    signal: row.signal || 'steady',
  }));
}

function normalizeIntelRows(payload) {
  if (!payload || !payload.intel || typeof payload.intel !== 'object') return [];
  return Object.entries(payload.intel).map(([group, rows]) => ({
    group,
    rows: Array.isArray(rows)
      ? rows.map((row) => ({
          label: String(row.label || 'item'),
          value: String(row.value || 'N/A'),
        }))
      : [],
  }));
}

export default function PrimaryDashboardPage() {
  const [expandedPanel, setExpandedPanel] = useState('competitive');

  const [competitiveSummary, setCompetitiveSummary] = useState([]);
  const [agencySummary, setAgencySummary] = useState([]);
  const [vendorSummary, setVendorSummary] = useState([]);
  const [captureSummary, setCaptureSummary] = useState([]);
  const [submissionSummary, setSubmissionSummary] = useState([]);

  const [competitiveIntel, setCompetitiveIntel] = useState([]);
  const [agencyIntel, setAgencyIntel] = useState([]);
  const [vendorIntel, setVendorIntel] = useState([]);
  const [captureIntel, setCaptureIntel] = useState([]);
  const [submissionIntel, setSubmissionIntel] = useState([]);

  const [isLoadingCompetitiveIntel, setIsLoadingCompetitiveIntel] = useState(false);
  const [competitiveError, setCompetitiveError] = useState('');
  const [isLoadingAgencyIntel, setIsLoadingAgencyIntel] = useState(false);
  const [agencyError, setAgencyError] = useState('');
  const [isLoadingVendorIntel, setIsLoadingVendorIntel] = useState(false);
  const [vendorError, setVendorError] = useState('');
  const [isLoadingCaptureIntel, setIsLoadingCaptureIntel] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const [isLoadingSubmissionIntel, setIsLoadingSubmissionIntel] = useState(false);
  const [submissionError, setSubmissionError] = useState('');

  const [summaryStatus, setSummaryStatus] = useState({
    competitive: 'Loading summary...',
    agency: 'Loading summary...',
    vendor: 'Loading summary...',
    capture: 'Loading summary...',
    submission: 'Loading summary...',
  });

  const [intelStatus, setIntelStatus] = useState({
    competitive: 'Summary loaded',
    agency: 'Summary loaded',
    vendor: 'Summary loaded',
    capture: 'Summary loaded',
    submission: 'Summary loaded',
  });

  const loadedDeepRef = useRef({
    competitive: false,
    agency: false,
    vendor: false,
    capture: false,
    submission: false,
  });

  const controllersRef = useRef({
    competitive: null,
    agency: null,
    vendor: null,
    capture: null,
    submission: null,
  });

  const summarySetters = useMemo(
    () => ({
      competitive: setCompetitiveSummary,
      agency: setAgencySummary,
      vendor: setVendorSummary,
      capture: setCaptureSummary,
      submission: setSubmissionSummary,
    }),
    []
  );

  const intelSetters = useMemo(
    () => ({
      competitive: setCompetitiveIntel,
      agency: setAgencyIntel,
      vendor: setVendorIntel,
      capture: setCaptureIntel,
      submission: setSubmissionIntel,
    }),
    []
  );

  const loadingSetters = useMemo(
    () => ({
      competitive: setIsLoadingCompetitiveIntel,
      agency: setIsLoadingAgencyIntel,
      vendor: setIsLoadingVendorIntel,
      capture: setIsLoadingCaptureIntel,
      submission: setIsLoadingSubmissionIntel,
    }),
    []
  );

  const errorSetters = useMemo(
    () => ({
      competitive: setCompetitiveError,
      agency: setAgencyError,
      vendor: setVendorError,
      capture: setCaptureError,
      submission: setSubmissionError,
    }),
    []
  );

  const loadSummary = useCallback(
    async (key) => {
      try {
        setSummaryStatus((prev) => ({ ...prev, [key]: 'Loading summary...' }));
        const res = await fetch(PANEL_META[key].summaryEndpoint, { cache: 'no-store' });
        if (!res.ok) throw new Error('Summary request failed');
        const payload = await res.json();
        summarySetters[key](normalizeSummaryRows(payload));
        setSummaryStatus((prev) => ({ ...prev, [key]: 'Summary loaded' }));
      } catch (_error) {
        setSummaryStatus((prev) => ({ ...prev, [key]: 'Unable to load summary' }));
      }
    },
    [summarySetters]
  );

  const loadIntel = useCallback(
    async (key) => {
      if (controllersRef.current[key]) {
        controllersRef.current[key].abort();
      }

      const controller = new AbortController();
      controllersRef.current[key] = controller;
      loadingSetters[key](true);
      errorSetters[key]('');
      setIntelStatus((prev) => ({ ...prev, [key]: 'Loading deeper intelligence...' }));

      try {
        const res = await fetch(PANEL_META[key].intelEndpoint, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('Intel request failed');
        const payload = await res.json();
        intelSetters[key](normalizeIntelRows(payload));

        if (payload.status === 'summary_only') {
          setIntelStatus((prev) => ({ ...prev, [key]: 'Summary loaded' }));
        } else {
          loadedDeepRef.current[key] = true;
          setIntelStatus((prev) => ({ ...prev, [key]: 'Intelligence ready' }));
        }
      } catch (error) {
        if (error && error.name === 'AbortError') {
          return;
        }
        errorSetters[key]('Unable to load intelligence');
        setIntelStatus((prev) => ({ ...prev, [key]: 'Unable to load intelligence' }));
      } finally {
        loadingSetters[key](false);
      }
    },
    [errorSetters, intelSetters, loadingSetters]
  );

  useEffect(() => {
    Object.keys(PANEL_META).forEach((key) => {
      loadSummary(key);
    });
  }, [loadSummary]);

  useEffect(() => {
    if (!expandedPanel) return;
    if (!loadedDeepRef.current[expandedPanel]) {
      loadIntel(expandedPanel);
    }
  }, [expandedPanel, loadIntel]);

  useEffect(() => {
    return () => {
      Object.values(controllersRef.current).forEach((controller) => {
        if (controller) controller.abort();
      });
    };
  }, []);

  const panelModels = [
    {
      key: 'competitive',
      summary: competitiveSummary,
      intel: competitiveIntel,
      isLoadingIntel: isLoadingCompetitiveIntel,
      error: competitiveError,
    },
    {
      key: 'agency',
      summary: agencySummary,
      intel: agencyIntel,
      isLoadingIntel: isLoadingAgencyIntel,
      error: agencyError,
    },
    {
      key: 'vendor',
      summary: vendorSummary,
      intel: vendorIntel,
      isLoadingIntel: isLoadingVendorIntel,
      error: vendorError,
    },
    {
      key: 'capture',
      summary: captureSummary,
      intel: captureIntel,
      isLoadingIntel: isLoadingCaptureIntel,
      error: captureError,
    },
    {
      key: 'submission',
      summary: submissionSummary,
      intel: submissionIntel,
      isLoadingIntel: isLoadingSubmissionIntel,
      error: submissionError,
    },
  ];

  return (
    <div className="dashboard-shell">
      {panelModels.map((panel) => {
        const meta = PANEL_META[panel.key];
        const isExpanded = expandedPanel === panel.key;
        const statusText = panel.isLoadingIntel ? 'Loading deeper intelligence...' : (panel.error ? 'Unable to load intelligence' : intelStatus[panel.key]);

        return (
          <section className={`polish-panel ${isExpanded ? 'polish-panel-expanded' : ''}`} key={panel.key}>
            <button
              className="polish-panel-header"
              type="button"
              onClick={() => setExpandedPanel((prev) => (prev === panel.key ? '' : panel.key))}
            >
              <span className="polish-panel-icon">{meta.icon}</span>
              <span>{meta.title}</span>
              <span className="polish-panel-module">{meta.module}</span>
            </button>

            <div className="polish-panel-body pd-intel-panel">
              <div className="pd-intel-status">{summaryStatus[panel.key]} • {statusText}</div>

              <div className="pd-intel-summary">
                {panel.summary.map((row) => (
                  <div className="kv" key={`${panel.key}-${row.label}`}>
                    <span>{row.label}</span>
                    <span><span className="pd-signal">{signalIcon(row.signal)}</span> {row.value}</span>
                  </div>
                ))}
              </div>

              <button
                className="pd-intel-load-button"
                type="button"
                disabled={panel.isLoadingIntel}
                onClick={() => loadIntel(panel.key)}
              >
                {panel.isLoadingIntel ? 'Loading...' : 'Load Intelligence'}
              </button>

              {panel.isLoadingIntel && <div className="pd-intel-loading">Loading deeper intelligence...</div>}
              {panel.error && <div className="pd-intel-error">{panel.error}</div>}

              <div className="pd-intel-deep" hidden={!panel.intel.length}>
                {panel.intel.map((group) => (
                  <div className="pd-intel-group" key={`${panel.key}-${group.group}`}>
                    <div className="pd-intel-group-title">{group.group.replaceAll('_', ' ')}</div>
                    {group.rows.map((row) => (
                      <div className="kv" key={`${panel.key}-${group.group}-${row.label}`}>
                        <span>{row.label}</span>
                        <span>{row.value}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
