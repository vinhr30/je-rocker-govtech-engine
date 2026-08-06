export function searchResultSections(type) {
  if (type === 'agency') return ['spend history', 'vendors', 'trends'];
  if (type === 'vendor') return ['awards', 'agencies', 'spend', 'modifications'];
  if (type === 'naics' || type === 'psc') return ['agencies', 'vendors', 'spend', 'trends'];
  if (type === 'opportunity') return ['full details', 'matches'];
  return ['results'];
}
