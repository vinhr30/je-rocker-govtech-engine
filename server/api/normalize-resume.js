const fs = require('fs');
const path = require('path');

const JE_ROOT = '/Volumes/Data Drive/Govtech/JE ROCKER';
const INTAKE_PATH = path.join(JE_ROOT, 'db/veteran_intake.json');
const CANDIDATE_ARTIFACT_DIRECTORY = path.join(JE_ROOT, 'data/candidates');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:latest';
const MAX_PROFILE_CHARS = 50000;
const MAX_EDITED_TEXT_CHARS = 100000;

const FINAL_DISCLAIMER = `------------------------------------------------------------------------------
🔒 CUSTOMER ACCURACY & VERIFICATION DISCLAIMER:
This document has been semantically optimized for corporate keyword alignment based on our proprietary local data cores. While our engines enforce strict layout fidelity, the candidate retains 100% ownership and final responsibility for the historical truth of this profile. Please review all employment dates, titles, and metrics carefully for absolute accuracy prior to routing this file to active hiring authorities.
------------------------------------------------------------------------------`;

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

function requiredString(value, field, maxLength) {
  const result = String(value || '').trim();
  if (!result) throw badRequest(`${field} is required.`);
  if (result.length > maxLength) throw badRequest(`${field} exceeds its maximum length.`);
  return result;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${filePath}: ${error.message}`);
  }
}

function intakeCandidates() {
  if (!fs.existsSync(INTAKE_PATH)) return [];
  const intake = readJson(INTAKE_PATH);
  if (Array.isArray(intake)) return intake;
  if (intake && Array.isArray(intake.candidates)) return intake.candidates;
  throw new Error('Veteran intake must contain a candidates array.');
}

function candidateById(candidateId) {
  const candidate = intakeCandidates().find((item) => String(item?.candidate_id || item?.id || '') === candidateId);
  if (candidate) return candidate;

  const safeId = candidateId.replace(/[^A-Za-z0-9_.-]/g, '');
  if (!safeId || safeId !== candidateId) throw notFound(`Candidate ${candidateId} was not found.`);
  const artifactPath = path.join(CANDIDATE_ARTIFACT_DIRECTORY, safeId.endsWith('.txt') ? safeId : `${safeId}.txt`);
  if (!artifactPath.startsWith(`${CANDIDATE_ARTIFACT_DIRECTORY}${path.sep}`) || !fs.existsSync(artifactPath)) {
    throw notFound(`Candidate ${candidateId} was not found.`);
  }
  return { candidate_id: candidateId, raw_profile_text: fs.readFileSync(artifactPath, 'utf8') };
}

function rawProfileText(candidate) {
  return candidate.raw_profile_text || candidate.raw_text || candidate.profile_text || candidate.resume_text || candidate.text || '';
}

function gapKeys(candidate) {
  const value = candidate.active_qdrant_match_gap_keys
    || candidate.match_gap_keys
    || candidate.gap_keys
    || candidate.missing_skills
    || candidate.missing_tokens
    || [];
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, 100) : [];
}

async function generate(prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
    const payload = await response.json();
    const responseText = String(payload.response || '').trim();
    if (!responseText) throw new Error('Ollama returned an empty response.');
    return responseText;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Ollama request timed out.');
    throw new Error(`Ollama request failed: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function buildDraftPrompt(profile, gaps, targetRole = '', targetCategory = '') {
  return [
    'Rewrite the candidate profile below into a broad-category-targeted resume draft in Markdown.',
    'Preserve every factual claim. Do not invent employers, dates, titles, metrics, certifications, or tools.',
    targetCategory ? `Target career category: ${targetCategory}` : '',
    targetRole ? `Optional example role from the local jobs database: ${targetRole}` : '',
    'Optimize for multiple truthful matches within the category. Do not rewrite the resume as if the candidate held the example role.',
    'Where accurate and natural, make the following job-gap tokens explicit: ' + (gaps.length ? gaps.join(', ') : 'none supplied') + '.',
    '',
    'CANDIDATE PROFILE:',
    profile,
  ].join('\n');
}

function buildSanitizePrompt(editedText) {
  return [
    'Review this hand-polished resume text for layout consistency.',
    'Preserve all sentence content exactly. Remove only weird Markdown formatting anomalies.',
    'Do not add facts, remove facts, rewrite claims, or change dates, titles, metrics, or tools.',
    '',
    'HAND-POLISHED RESUME:',
    editedText,
  ].join('\n');
}

async function createDraft(candidateId, profileText, targetRole, targetCategory, suppliedGaps) {
  const candidate = candidateId ? candidateById(candidateId) : {};
  const profile = requiredString(profileText || rawProfileText(candidate), 'candidate profile text', MAX_PROFILE_CHARS);
  const gaps = suppliedGaps || gapKeys(candidate);
  return {
    phase: 'draft',
    candidate_id: candidateId || null,
    target_role: targetRole || null,
    target_category: targetCategory || null,
    gap_keys: gaps,
    model: OLLAMA_MODEL,
    draft_markdown: await generate(buildDraftPrompt(profile, gaps, targetRole, targetCategory)),
  };
}

async function sanitize(editedText) {
  const text = requiredString(editedText, 'edited_text', MAX_EDITED_TEXT_CHARS);
  const sanitized = await generate(buildSanitizePrompt(text));
  return {
    phase: 'sanitized',
    model: OLLAMA_MODEL,
    finalized_text: `${sanitized.replace(/\s+$/, '')}\n\n${FINAL_DISCLAIMER}`,
  };
}

function registerNormalizeResumeRoutes(app, localDashboardOnly) {
  app.post('/api/normalize/draft', localDashboardOnly, async (req, res) => {
    try {
      const candidateId = req.body?.candidate_id ? requiredString(req.body.candidate_id, 'candidate_id', 200) : null;
      const profileText = req.body?.profile_text || req.body?.raw_profile_text;
      if (!candidateId && !profileText) throw badRequest('candidate_id or profile_text is required.');
      const targetRole = req.body?.target_role ? requiredString(req.body.target_role, 'target_role', 300) : '';
      const targetCategory = req.body?.target_category
        ? requiredString(req.body.target_category, 'target_category', 300)
        : '';
      const suppliedGaps = Array.isArray(req.body?.gap_keys)
        ? req.body.gap_keys.map((item) => String(item).trim()).filter(Boolean).slice(0, 100)
        : null;
      return res.json(await createDraft(candidateId, profileText, targetRole, targetCategory, suppliedGaps));
    } catch (error) {
      return res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post('/api/normalize/sanitize', localDashboardOnly, async (req, res) => {
    try {
      return res.json(await sanitize(req.body?.edited_text || req.body?.text));
    } catch (error) {
      return res.status(error.statusCode || 502).json({ error: error.message });
    }
  });
}

module.exports = {
  FINAL_DISCLAIMER,
  buildDraftPrompt,
  buildSanitizePrompt,
  registerNormalizeResumeRoutes,
  sanitize,
};