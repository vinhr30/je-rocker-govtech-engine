const fs = require('fs');
const path = require('path');

const JE_ROOT = '/Volumes/Data Drive/Govtech/JE ROCKER';
const INTAKE_PATH = path.join(JE_ROOT, 'db/veteran_intake.json');
const EXPORT_DIRECTORY = path.join(JE_ROOT, 'data/exports');
const CANDIDATE_DIRECTORY = path.join(JE_ROOT, 'data/candidates');
const DEAL_LEDGER_PATH = path.join(JE_ROOT, 'db/deal_ledger.json');

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

function readDealLedger() {
  if (!fs.existsSync(DEAL_LEDGER_PATH)) {
    return {
      upfront_revenue_counter: { veteran_gross: 0, civilian_gross: 0, total_gross: 0 },
      active_deals: [],
    };
  }
  const parsed = JSON.parse(fs.readFileSync(DEAL_LEDGER_PATH, 'utf8'));
  if (!parsed || !parsed.upfront_revenue_counter || !Array.isArray(parsed.active_deals)) {
    throw new Error('Deal ledger has an invalid shape.');
  }
  return parsed;
}

function writeDealLedger(ledger) {
  fs.mkdirSync(path.dirname(DEAL_LEDGER_PATH), { recursive: true });
  const temporaryPath = `${DEAL_LEDGER_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, DEAL_LEDGER_PATH);
}

function findCandidate(candidateId) {
  const intake = readIntake();
  return intake.candidates.find(
    (item) => String(item?.candidate_id || item?.id || '').trim().toLowerCase() === String(candidateId).trim().toLowerCase()
  ) || null;
}

function findPolishedExport(candidateId) {
  if (!fs.existsSync(EXPORT_DIRECTORY)) return null;
  const files = fs.readdirSync(EXPORT_DIRECTORY)
    .filter((f) => !f.startsWith('~$') && !f.startsWith('.tmp') && (f.endsWith('.md') || f.endsWith('.txt')));
  
  if (!files.length) return null;

  // Try matching candidateId directly in filename
  if (candidateId) {
    const directMatch = files.find((f) => f.includes(candidateId));
    if (directMatch) return path.join(EXPORT_DIRECTORY, directMatch);
  }

  // Look for most recently modified file in exports
  let newestFile = null;
  let newestMtime = 0;
  for (const f of files) {
    const fullPath = path.join(EXPORT_DIRECTORY, f);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs > newestMtime) {
      newestMtime = stat.mtimeMs;
      newestFile = fullPath;
    }
  }
  return newestFile;
}

function unblindText(rawText, candidate) {
  const fullName = [candidate.first_name, candidate.last_name].filter(Boolean).join(' ').trim() || 'Candidate Name';
  const email = candidate.contact_email || 'contact@example.com';
  const phone = candidate.phone_number || '';
  const clearance = candidate.clearance_status_extracted || candidate.clearance || 'Active / Cleared';
  const rank = candidate.military_rank_extracted || candidate.rank || 'Veteran';

  const unblindedHeader = [
    `# ${fullName}`,
    `**Contact Information**: ${email}${phone ? ` | ${phone}` : ''}`,
    `**Status**: ${rank} | **Security Clearance**: ${clearance}`,
    `**Candidate Tracking ID**: ${candidate.candidate_id || ''}`,
    '',
    '---',
    '',
  ].join('\n');

  // If text starts with markdown headers or generic corporate headers, strip anonymized contact block
  let cleanedText = rawText;
  
  // Strip anonymous contact info sections if present
  cleanedText = cleanedText.replace(/###\s*Corporate Technical Resume[\s\S]*?####\s*Contact Information[\s\S]*?(?=####\s*Summary|###\s*Summary|\n#)/i, '');
  cleanedText = cleanedText.replace(/####\s*Contact Information[\s\S]*?(?=####\s*Summary|###\s*Summary|\n#)/i, '');
  cleanedText = cleanedText.replace(/^Rank:\s*.*?\nClearance:\s*.*?\n-+\n=+\nCANDIDATE PROFILE:.*?\n=+\n/is, '');

  return `${unblindedHeader}\n${cleanedText.trim()}\n`;
}

function unblindCandidateDossier({ candidate_id, deal_id }) {
  const candidateIdStr = String(candidate_id || '').trim();
  const dealIdStr = String(deal_id || '').trim();

  let candidate = findCandidate(candidateIdStr);

  // If candidate not found by ID directly, check if a deal has candidate email or ID
  const ledger = readDealLedger();
  let matchedDeal = null;

  if (dealIdStr) {
    matchedDeal = ledger.active_deals.find((d) => String(d.deal_id).trim() === dealIdStr);
  }
  if (!matchedDeal && candidateIdStr) {
    matchedDeal = ledger.active_deals.find((d) => String(d.candidate_id).trim() === candidateIdStr || String(d.candidate_email).trim().toLowerCase() === candidateIdStr.toLowerCase());
  }

  if (!candidate && matchedDeal) {
    const intake = readIntake();
    candidate = intake.candidates.find((c) => 
      c.candidate_id === matchedDeal.candidate_id || 
      (c.contact_email && matchedDeal.candidate_email && c.contact_email.toLowerCase() === matchedDeal.candidate_email.toLowerCase())
    );
  }

  if (!candidate) {
    // If there is only one staged candidate, fallback gracefully
    const intake = readIntake();
    if (intake.candidates.length === 1) {
      candidate = intake.candidates[0];
    } else {
      throw badRequest(`Candidate identity could not be resolved for ID: "${candidate_id || deal_id}".`);
    }
  }

  // Retrieve polished text from data/exports/
  const exportFilePath = findPolishedExport(candidate.candidate_id);
  let polishedText = '';
  if (exportFilePath && fs.existsSync(exportFilePath)) {
    polishedText = fs.readFileSync(exportFilePath, 'utf8');
  } else {
    // Fallback to candidate artifact if exports is empty
    const artifactPath = path.resolve(JE_ROOT, String(candidate.parsed_resume_path || ''));
    if (fs.existsSync(artifactPath)) {
      polishedText = fs.readFileSync(artifactPath, 'utf8');
    } else {
      throw new Error('Polished candidate export file could not be located in data/exports/.');
    }
  }

  // Text Transformation Matrix: strip placeholders & inject real credentials
  const unblindedContent = unblindText(polishedText, candidate);

  // Core Ledger Update: transition 'Pitched' or 'Pitch Prepared' to 'Interview Scheduled'
  let updatedStage = false;
  if (matchedDeal) {
    matchedDeal.current_pipeline_stage = 'Interview Scheduled';
    matchedDeal.unblinded_at = new Date().toISOString();
    updatedStage = true;
  } else if (ledger.active_deals.length > 0) {
    // Update any matching active deal for this candidate
    for (const d of ledger.active_deals) {
      if (d.candidate_id === candidate.candidate_id || (d.candidate_email && candidate.contact_email && d.candidate_email.toLowerCase() === candidate.contact_email.toLowerCase())) {
        d.current_pipeline_stage = 'Interview Scheduled';
        d.unblinded_at = new Date().toISOString();
        updatedStage = true;
      }
    }
  }

  if (updatedStage) {
    writeDealLedger(ledger);
  }

  return {
    candidate_id: candidate.candidate_id,
    deal_id: matchedDeal ? matchedDeal.deal_id : null,
    candidate_name: [candidate.first_name, candidate.last_name].filter(Boolean).join(' '),
    candidate_email: candidate.contact_email,
    pipeline_stage: 'Interview Scheduled',
    unblinded_dossier: unblindedContent,
    ledger: readDealLedger(),
  };
}

function registerUnblindDossierRoute(app, localDashboardOnly) {
  app.post('/api/unblind-dossier', localDashboardOnly, (req, res) => {
    try {
      const { candidate_id, deal_id } = req.body || {};
      if (!candidate_id && !deal_id) {
        throw badRequest('Either candidate_id or deal_id must be provided.');
      }
      const result = unblindCandidateDossier({ candidate_id, deal_id });
      return res.status(200).json(result);
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });
}

module.exports = {
  registerUnblindDossierRoute,
  unblindCandidateDossier,
  unblindText,
};
