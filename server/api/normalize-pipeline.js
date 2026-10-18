const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const JE_ROOT = '/Volumes/Data Drive/Govtech/JE ROCKER';
const INTAKE_PATH = path.join(JE_ROOT, 'db/veteran_intake.json');
const CANDIDATE_DIRECTORY = path.join(JE_ROOT, 'data/candidates');
const EXPORT_DIRECTORY = path.join(JE_ROOT, 'data/exports');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.NORMALIZE_PIPELINE_MODEL || process.env.OLLAMA_MODEL || 'llama3:8b';
const OLLAMA_FALLBACK_MODEL = 'llama3.2:latest';
const MAX_CANDIDATE_ID_LENGTH = 200;
const MAX_PROFILE_LENGTH = 50000;

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function readIntake() {
  if (!fs.existsSync(INTAKE_PATH)) return { candidates: [] };
  const parsed = JSON.parse(fs.readFileSync(INTAKE_PATH, 'utf8'));
  if (Array.isArray(parsed)) return { candidates: parsed };
  if (!parsed || !Array.isArray(parsed.candidates)) throw new Error('Veteran intake store must contain a candidates array.');
  return parsed;
}

function gapKeys(candidate) {
  const values = candidate.active_qdrant_match_gap_keys
    || candidate.match_gap_keys
    || candidate.gap_keys
    || candidate.missing_skills
    || candidate.missing_tokens
    || [];
  return Array.isArray(values) ? values.map((value) => String(value).trim()).filter(Boolean).slice(0, 100) : [];
}

function candidateProfile(candidate) {
  const inline = candidate.raw_profile_text
    || candidate.raw_text
    || candidate.profile_text
    || candidate.resume_text
    || candidate.text;
  if (inline) return String(inline);

  const relativePath = String(candidate.parsed_resume_path || '').trim();
  const artifactPath = path.resolve(JE_ROOT, relativePath);
  const relativeToCandidates = path.relative(CANDIDATE_DIRECTORY, artifactPath);
  if (!relativePath || relativeToCandidates.startsWith('..') || path.isAbsolute(relativeToCandidates)) {
    throw new Error('Candidate resume artifact is outside the approved candidate directory.');
  }
  if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
    throw new Error('Candidate resume artifact is unavailable.');
  }
  return fs.readFileSync(artifactPath, 'utf8');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function findCandidate(candidateId) {
  const candidate = readIntake().candidates.find(
    (item) => String(item?.candidate_id || item?.id || '') === candidateId,
  );
  if (candidate) return candidate;

  const artifactName = candidateId.endsWith('.txt') ? candidateId : `${candidateId}.txt`;
  const artifactPath = path.join(CANDIDATE_DIRECTORY, artifactName);
  const relativePath = path.relative(CANDIDATE_DIRECTORY, artifactPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath) || !fs.existsSync(artifactPath)) return null;
  return { candidate_id: candidateId, resume_text: fs.readFileSync(artifactPath, 'utf8') };
}

async function generateRewrite(profile, gaps) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const prompt = [
    'Rewrite the raw candidate profile into a hardened corporate technical resume layout in Markdown.',
    'Preserve every historical fact exactly. Do not fabricate employers, dates, titles, metrics, certifications, clearance, or tools.',
    'Use the missing-skill tokens only as gap-analysis context; never claim a missing skill is already possessed.',
    'Keep the result broadly useful for multiple truthful job matches, not tailored to one invented role.',
    `QDRANT GAP-ANALYSIS TOKENS: ${gaps.length ? gaps.join(', ') : 'none supplied'}`,
    '',
    'RAW RESUME:',
    profile,
  ].join('\n');
  try {
    const request = (model) => fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });
    let modelUsed = OLLAMA_MODEL;
    let response = await request(modelUsed);
    if (response.status === 404 && OLLAMA_MODEL === 'llama3:8b') {
      modelUsed = OLLAMA_FALLBACK_MODEL;
      response = await request(modelUsed);
    }
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
    const payload = await response.json();
    const rewritten = String(payload.response || '').trim();
    if (!rewritten) throw new Error('Ollama returned an empty rewrite.');
    return { text: rewritten, model: modelUsed };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Ollama request timed out.');
    throw new Error(`Ollama request failed: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function openInWord(filePath) {
  return new Promise((resolve, reject) => {
    const command = `open -a "Microsoft Word" ${shellQuote(filePath)}`;
    exec(command, { cwd: JE_ROOT, timeout: 15000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr.trim() || error.message));
      return resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function registerNormalizePipelineRoute(app, localDashboardOnly) {
  app.post('/api/normalize-pipeline', localDashboardOnly, async (req, res) => {
    try {
      const candidateId = String(req.body?.candidate_id || '').trim();
      if (!candidateId) throw badRequest('candidate_id is required.');
      if (candidateId.length > MAX_CANDIDATE_ID_LENGTH || !/^[A-Za-z0-9_.-]+$/.test(candidateId)) {
        throw badRequest('candidate_id contains unsupported characters.');
      }

      const candidate = findCandidate(candidateId);
      if (!candidate) return res.status(404).json({ error: `Candidate ${candidateId} was not found.` });
      const profile = candidateProfile(candidate).trim();
      if (!profile) throw badRequest('Candidate resume text is empty.');
      if (profile.length > MAX_PROFILE_LENGTH) throw badRequest('Candidate resume text exceeds its maximum length.');

      const rewritten = await generateRewrite(profile, gapKeys(candidate));
      fs.mkdirSync(EXPORT_DIRECTORY, { recursive: true });
      const exportPath = path.join(EXPORT_DIRECTORY, `temp_review_${candidateId}.md`);
      const temporaryPath = `${exportPath}.tmp-${process.pid}`;
      fs.writeFileSync(temporaryPath, `${rewritten.text}\n`, 'utf8');
      fs.renameSync(temporaryPath, exportPath);
      await openInWord(exportPath);

      return res.status(200).json({
        candidate_id: candidateId,
        model: rewritten.model,
        export_path: exportPath,
        status: 'opened_for_manual_review',
      });
    } catch (error) {
      return res.status(error.statusCode || 502).json({ error: error.message });
    }
  });
}

module.exports = { registerNormalizePipelineRoute };