const fs = require('fs');
const path = require('path');

const JE_ROOT = '/Volumes/Data Drive/Govtech/JE ROCKER';
const INTAKE_PATH = path.join(JE_ROOT, 'db/veteran_intake.json');
const CANDIDATE_DIRECTORY = path.join(JE_ROOT, 'data/candidates');
const MAX_CANDIDATE_ID_LENGTH = 200;
const MAX_RESUME_LENGTH = 100000;

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

function findCandidate(candidateId) {
  const candidate = readIntake().candidates.find(
    (candidate) => String(candidate?.candidate_id || candidate?.id || '') === candidateId,
  );
  if (candidate) return candidate;
  const artifactName = candidateId.endsWith('.txt') ? candidateId : `${candidateId}.txt`;
  const artifactPath = path.join(CANDIDATE_DIRECTORY, artifactName);
  const relativePath = path.relative(CANDIDATE_DIRECTORY, artifactPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath) || !fs.existsSync(artifactPath)) return null;
  return { candidate_id: candidateId, resume_text: fs.readFileSync(artifactPath, 'utf8') };
}

function matchRows(candidate, suppliedRows) {
  if (Array.isArray(suppliedRows)) return suppliedRows.slice(0, 10);
  const values = candidate.qualified_matches
    || candidate.match_results
    || candidate.matches
    || candidate.latest_match_rows
    || candidate.top_vector_rows
    || [];
  return Array.isArray(values) ? values.slice(0, 10) : [];
}

function matchTitle(row) {
  return String(row?.job_title || row?.title || row?.role || '').trim();
}

function sectorForTitle(title) {
  const value = title.toLowerCase();
  if (/health|medical|clinical|care|economic/.test(value)) return 'Healthcare Analytics / Medical Economics (Healthcare Sector)';
  if (/engineer|systems|software|technical|technology|cyber|network|infrastructure/.test(value)) return 'Systems Operations / Engineering Requisition (Technology and Mission Systems Sector)';
  if (/finance|financial|treasury|account|budget|economic|business analyst|data analyst/.test(value)) return 'Financial Analysis / Business Intelligence (Enterprise Services Sector)';
  if (/contract|procurement|workforce|operations|program|project/.test(value)) return 'Contract and Program Operations (Enterprise Services Sector)';
  return 'Business Operations / Analytics Requisition (Enterprise Sector)';
}

function broadHighlights(rows) {
  const highlights = [];
  rows.forEach((row) => {
    const highlight = sectorForTitle(matchTitle(row));
    if (!highlights.includes(highlight)) highlights.push(highlight);
  });
  const fallbacks = [
    'Business Intelligence / Data Analysis (Enterprise Services Sector)',
    'Program and Operations Analysis (Enterprise Services Sector)',
    'Technical Systems Support (Technology Sector)',
  ];
  fallbacks.forEach((highlight) => {
    if (highlights.length < 3 && !highlights.includes(highlight)) highlights.push(highlight);
  });
  return highlights.slice(0, 3);
}

function countFrom(candidate, body, keys, fallback) {
  for (const key of keys) {
    const value = body?.[key] ?? candidate?.[key];
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return fallback;
}

function buildDeliveryPacket({ candidateId, candidate, approvedResume, rows, body }) {
  const originalCount = countFrom(candidate, body, ['original_match_count', 'baseline_match_count'], 'Not yet recorded');
  const normalizedCount = countFrom(candidate, body, ['post_normalization_match_count', 'normalized_match_count'], rows.length || 'Pending matcher run');
  const highlights = broadHighlights(rows);
  return [
    'J.E. ROCKER | CANDIDATE DELIVERY PACKET',
    '======================================================================',
    `Candidate tracking ID: ${candidateId}`,
    `Original resume qualified matches: ${originalCount}`,
    `Post-normalization qualified matches: ${normalizedCount}`,
    '',
    'BROAD TARGET SECTOR HIGHLIGHTS',
    ...highlights.map((highlight) => `- ${highlight}`),
    '',
    'PRIVATE CLUSTER PRIVACY ACTION',
    'This packet is prepared for private candidate review and controlled delivery only. Do not publish the candidate profile, expose identifying information, or forward the resume beyond authorized hiring contacts without the candidate\'s approval.',
    '',
    'APPROVED NORMALIZED RESUME',
    '----------------------------------------------------------------------',
    approvedResume,
    '----------------------------------------------------------------------',
    '',
    'Vinh L. Rocker',
    'Founder & CEO | J.E. Rocker',
    'JEROCKER@outlook.com',
    'Private candidate representation and delivery services',
  ].join('\n');
}

function registerCandidateDeliveryRoute(app, localDashboardOnly) {
  app.post('/api/candidate-delivery', localDashboardOnly, (req, res) => {
    try {
      const candidateId = String(req.body?.candidate_id || '').trim();
      const approvedResume = String(req.body?.approved_normalized_resume_text || '').trim();
      if (!candidateId) throw badRequest('candidate_id is required.');
      if (!approvedResume) throw badRequest('approved_normalized_resume_text is required.');
      if (candidateId.length > MAX_CANDIDATE_ID_LENGTH || !/^[A-Za-z0-9_.-]+$/.test(candidateId)) {
        throw badRequest('candidate_id contains unsupported characters.');
      }
      if (approvedResume.length > MAX_RESUME_LENGTH) throw badRequest('approved_normalized_resume_text exceeds its maximum length.');

      const candidate = findCandidate(candidateId);
      if (!candidate) return res.status(404).json({ error: `Candidate ${candidateId} was not found.` });
      const rows = matchRows(candidate, req.body?.qualified_matches);
      const deliveryPacket = buildDeliveryPacket({ candidateId, candidate, approvedResume, rows, body: req.body });
      return res.status(200).json({
        candidate_id: candidateId,
        original_match_count: countFrom(candidate, req.body, ['original_match_count', 'baseline_match_count'], null),
        post_normalization_match_count: countFrom(candidate, req.body, ['post_normalization_match_count', 'normalized_match_count'], rows.length || null),
        target_sector_highlights: broadHighlights(rows),
        delivery_packet: deliveryPacket,
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });
}

module.exports = { registerCandidateDeliveryRoute };