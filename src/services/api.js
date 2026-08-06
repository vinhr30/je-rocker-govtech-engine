export const API_ENDPOINTS = {
  matches: '/api/matches',
  review: '/api/review',
  matchIntel: (id, source = 'primary') => `/api/match_intel/${id}?source=${source}`,
  opportunityIntel: (id) => `/api/intel/opportunity/${id}`,
  intelTable: (table) => `/api/intel/${table}`,
  scoredOpportunities: '/api/opportunities/scored',
  internalSearch: (query) => `/api/internal_search?q=${encodeURIComponent(query)}`,
  dashboardSummary: '/api/dashboard_summary',
};

export async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export async function searchInternalData(query) {
  if (!query || !String(query).trim()) return { type: 'empty', rows: [] };
  return fetchJson(API_ENDPOINTS.internalSearch(String(query).trim()));
}
