const GNE_ENDPOINT = '/api/gne/state';

let snapshotPromise = null;

async function getGneSnapshot({ refresh = false } = {}) {
  if (refresh || !snapshotPromise) {
    snapshotPromise = fetch(GNE_ENDPOINT, { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('GNE state unavailable');
      return response.json();
    }).catch((error) => {
      snapshotPromise = null;
      throw error;
    });
  }
  return snapshotPromise;
}

async function readArray(key) {
  const snapshot = await getGneSnapshot();
  return Array.isArray(snapshot[key]) ? snapshot[key] : [];
}

export const getGneSignals = () => readArray('gne_signals');
export const getGneSemantics = () => readArray('gne_semantics');
export const getGneClassifications = () => readArray('gne_classifications');
export const getGneForecasts = () => readArray('gne_forecasts');
export const getGneModernization = () => readArray('gne_modernization');
export const getGnePartners = () => readArray('gne_partners');

export async function getAllGneState({ refresh = false } = {}) {
  const snapshot = await getGneSnapshot({ refresh });
  return {
    signals: Array.isArray(snapshot.gne_signals) ? snapshot.gne_signals : [],
    semantics: Array.isArray(snapshot.gne_semantics) ? snapshot.gne_semantics : [],
    classifications: Array.isArray(snapshot.gne_classifications) ? snapshot.gne_classifications : [],
    forecasts: Array.isArray(snapshot.gne_forecasts) ? snapshot.gne_forecasts : [],
    modernization: Array.isArray(snapshot.gne_modernization) ? snapshot.gne_modernization : [],
    partners: Array.isArray(snapshot.gne_partners) ? snapshot.gne_partners : [],
  };
}

export async function refreshGne() {
  const response = await fetch('/api/gne/refresh', { method: 'POST' });
  if (!response.ok) throw new Error('GNE refresh failed');
  snapshotPromise = Promise.resolve(await response.json());
  return getAllGneState();
}
