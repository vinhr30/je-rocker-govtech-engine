import { searchInternalData } from '../services/api.js';

export async function performInternalSearch(query) {
  return searchInternalData(query);
}
