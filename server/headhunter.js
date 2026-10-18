const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { registerSemanticScoutRoute, rankRecruiters } = require('./api/semantic-scout');
const { scoutRecruiterProfiles } = require('./api/browser-ingestion-bridge');
const { registerNormalizeResumeRoutes } = require('./api/normalize-resume');
const { registerNormalizePipelineRoute } = require('./api/normalize-pipeline');
const { registerCandidateDeliveryRoute } = require('./api/candidate-delivery');
const { registerUnblindDossierRoute, unblindCandidateDossier } = require('./api/unblind-dossier');
const { buildSemanticAutoresponder, buildPaymentReceipt, STRIPE_LINKS: SEMANTIC_STRIPE_LINKS } = require('./semantic-autoresponder');

// PRODUCTION STRIPE PAYMENT LINKS
const STRIPE_LINKS = SEMANTIC_STRIPE_LINKS || {
  veteran: "https://buy.stripe.com/7sY9AT9Na09O7x6flBbll00",
  civilian: "https://buy.stripe.com/8x27sLaRe09O9FeflBbll01",
};

const JE_ROOT = '/Volumes/Data Drive/Govtech/JE ROCKER';
const JE_PYTHON = path.join(JE_ROOT, '.venv/bin/python');
const MAL = 'vinhrocker@Mac-Mal.local';
const MAL_MATCH_COMMAND = `cd '${JE_ROOT}' && ~/.venvs/jerocker/bin/python scripts/match_veteran_pitch.py`;
const MAL_INSPECT_COMMAND = `cd '${JE_ROOT}' && ~/.venvs/jerocker/bin/python scripts/inspect_job_index.py`;
const INSPECT_TIMEOUT_MS = 60000;
const MAX_INSPECT_BYTES = 20 * 1024 * 1024;
const CLIENT_HEADER = 'x-requested-by';
const CLIENT_HEADER_VALUE = 'je-rocker-dashboard';
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const MAX_LOG_CHARS = 200000;
const MAX_PROFILE_CHARS = 20000;
const LEADS_PATH = path.join(JE_ROOT, 'db/b2b_leads.json');
const DEAL_LEDGER_PATH = path.join(JE_ROOT, 'db/deal_ledger.json');
const DEAL_LEDGER_SCRIPT = path.join(JE_ROOT, 'scripts/update_deal_ledger.py');
const VETERAN_INTAKE_PATH = path.join(JE_ROOT, 'db/veteran_intake.json');
const CANDIDATE_ARTIFACT_DIRECTORY = path.resolve(JE_ROOT, 'data/candidates');
const CORPORATE_EMAIL_PATTERNS = {
  'google.com': '{first}{last}@google.com',
  'microsoft.com': '{first}.{last}@microsoft.com',
  'amazon.com': '{last}{first_initial}@amazon.com',
  'lmco.com': '{first}.{m_initial}.{last}@lmco.com',
};
const DEFENSE_COMPANIES = ['lockheed', 'lmco.com', 'gdit', 'general dynamics information technology', 'rtx', 'l3harris'];
const TIER_ONE_TECH_COMPANIES = ['google', 'microsoft', 'amazon', 'verizon'];

// One job at a time: the pipeline and the matcher share Mal's Qdrant index, which allows a single writer.
const job = { kind: null, running: false, startedAt: null, finishedAt: null, exitCode: null, status: 'idle', cancelRequested: false, log: '' };
let activeChild = null;

function appendLog(text) {
  job.log = (job.log + text).slice(-MAX_LOG_CHARS);
}

function scoutingUrl(companyName, jobTitle, location) {
  const roleTerms = jobTitle.split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
  const companyTerms = companyName.toLowerCase().includes('general dynamics information technology')
    ? '"General Dynamics Information Technology" OR GDIT'
    : '"' + companyName + '"';
  const query = 'site:linkedin.com/in (' + companyTerms + ') ('
    + 'recruiter OR "talent acquisition" OR "technical recruiter" OR sourcer OR "hiring manager"'
    + ') ("' + roleTerms + '" OR "' + roleTerms.replace(/s\b/i, '') + '")';
  return 'https://www.google.com/search?' + new URLSearchParams({ q: query }).toString();
}

function readLeadStore() {
  if (!fs.existsSync(LEADS_PATH)) return { leads: [] };
  const parsed = JSON.parse(fs.readFileSync(LEADS_PATH, 'utf8'));
  if (!parsed || !Array.isArray(parsed.leads)) throw new Error('Lead store must contain a leads array.');
  return parsed;
}

function writeLeadStore(store) {
  fs.mkdirSync(path.dirname(LEADS_PATH), { recursive: true });
  const temporary = LEADS_PATH + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, LEADS_PATH);
}

function emptyDealLedger() {
  return {
    upfront_revenue_counter: { veteran_gross: 0, civilian_gross: 0, total_gross: 0 },
    active_deals: [],
  };
}

function readDealLedger() {
  try {
    if (!fs.existsSync(DEAL_LEDGER_PATH)) return emptyDealLedger();
    const parsed = JSON.parse(fs.readFileSync(DEAL_LEDGER_PATH, 'utf8'));
    if (!parsed || !parsed.upfront_revenue_counter || !Array.isArray(parsed.active_deals)) {
      throw new Error('Deal ledger has an invalid shape.');
    }
    return parsed;
  } catch (error) {
    console.error(`[dealLedger] ${error.message}`);
    return emptyDealLedger();
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function formatCurrency(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '$0.00';
}

function renderRevenueRibbon(ledger = readDealLedger()) {
  const counter = ledger.upfront_revenue_counter;
  return `<section class="revenue-tracker-ribbon" aria-label="Revenue tracker">
    <div class="revenue-tracker-heading"><span>Live Revenue Tracker</span><small>Upfront optimization receipts</small></div>
    <div class="revenue-metric"><span>Veteran Optimization Gross</span><strong>${formatCurrency(counter.veteran_gross)}</strong></div>
    <div class="revenue-metric"><span>Civilian Optimization Gross</span><strong>${formatCurrency(counter.civilian_gross)}</strong></div>
    <div class="revenue-metric revenue-metric-total"><span>Total Cumulative System Gross</span><strong>${formatCurrency(counter.total_gross)}</strong></div>
  </section>`;
}

function renderDealLedgerTable(ledger = readDealLedger()) {
  const rows = ledger.active_deals.map((deal) => {
    const stage = deal.current_pipeline_stage === 'Pitch Prepared' ? 'Pitched' : (deal.current_pipeline_stage || 'Staged');
    const dealId = escapeHtml(deal.deal_id || '');
    const candId = escapeHtml(deal.candidate_id || '');
    return `<tr>
    <td>${escapeHtml(deal.candidate_email || deal.candidate_id || 'Unassigned')}</td>
    <td>${escapeHtml(deal.company_name || 'Pending company')}</td>
    <td>${escapeHtml(deal.recruiter_name || 'Pending recruiter')}</td>
    <td><span class="deal-stage-badge">${escapeHtml(stage)}</span></td>
    <td>${formatCurrency(deal.projected_contingency_fee)}</td>
    <td><button type="button" class="headhunter-button headhunter-button-secondary btn-unblind-dossier" data-deal-id="${dealId}" data-candidate-id="${candId}">📁 Un-Blind &amp; Copy Corporate Dossier</button></td>
  </tr>`;
  }).join('');
  return `<section id="live-placements-ledger" class="dark-block live-placements-ledger">
    <div class="headhunter-header"><h3 class="block-title">Live Placements Ledger</h3><span id="live-placements-count" class="headhunter-badge">${ledger.active_deals.length} active</span></div>
    <div class="inner-box"><div class="qa-table-container"><table class="qa-table revenue-ledger-table"><thead><tr><th>Candidate</th><th>Company</th><th>Recruiter</th><th>Pipeline Status</th><th>Projected Placement Fee</th><th>Actions</th></tr></thead><tbody id="live-placements-body">${rows || '<tr><td colspan="6" class="qa-empty">No active deals.</td></tr>'}</tbody></table></div></div>
  </section>`;
}

function appendLedgerDeal(payload) {
  const candidateEmail = String(payload.candidate_email || '').trim() || 'unassigned@pending.local';
  const candidateId = String(payload.candidate_id || '').trim() || `pending-${payload.target_job_id}`;
  const salary = Number(payload.annualized_base_salary || 0);
  if (!Number.isFinite(salary) || salary < 0) throw new Error('annualized_base_salary must be a non-negative number.');
  const result = spawnSync(JE_PYTHON, [DEAL_LEDGER_SCRIPT, 'add-deal', '--payload'], {
    input: JSON.stringify({
      candidate_email: candidateEmail,
      recruiter_name: String(payload.recruiter_name || '').trim(),
      candidate_id: candidateId,
      candidate_type: String(payload.candidate_type || 'Veteran'),
      normalization_service_paid: false,
      normalization_fee_amount: '0.00',
      recruiter_lead_id: String(payload.recruiter_lead_id || '').trim(),
      current_pipeline_stage: 'Pitch Prepared',
      annualized_base_salary: String(salary),
      company_name: String(payload.company_name || '').trim(),
      job_title: String(payload.job_title || '').trim(),
      location: String(payload.location || '').trim(),
    }),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Deal ledger update failed.');
  return JSON.parse(result.stdout);
}

function followUpVariant(lead) {
  const company = `${lead.company_name || ''} ${lead.company_domain || ''}`.toLowerCase();
  if (DEFENSE_COMPANIES.some((name) => company.includes(name))) return 'Defense & Aerospace';
  if (TIER_ONE_TECH_COMPANIES.some((name) => company.includes(name))) return 'Enterprise Tier 1 Tech';
  return 'Enterprise Tier 1 Tech';
}

function buildFollowUpTemplates(lead) {
  const recruiter = lead.recruiter_name || 'there';
  const jobTitle = lead.job_title || 'the matched role';
  const location = lead.location || 'the listed location';
  const company = lead.company_name || lead.company_domain || 'your organization';
  const variant = followUpVariant(lead);
  const context = variant === 'Defense & Aerospace'
    ? `I wanted to follow up on the ${jobTitle} opportunity with ${company} in ${location}. The candidate's systems, mission operations, and cleared-environment experience appear closely aligned with the role's requirements.`
    : `I wanted to follow up on the ${jobTitle} opportunity with ${company} in ${location}. The candidate's engineering and operations background appears closely aligned with the role's technical requirements.`;
  return {
    variant,
    day_1: `Subject: Follow-up: ${jobTitle} | ${company}\n\nHello ${recruiter},\n\n${context}\n\nWould you be open to a brief conversation about the appropriate submission process? I can provide a concise, role-aligned profile for review.\n\nBest regards,\nVinh L. Rocker\nJ.E. Rocker`,
    day_2: `Subject: Re: ${jobTitle} | Candidate alignment\n\nHello ${recruiter},\n\nI am checking back on the ${jobTitle} role in ${location}. I can answer any initial questions about the candidate's availability, technical scope, or authorization status before an introduction.\n\nIs this role still active, and are you the right contact for candidate submissions?\n\nBest regards,\nVinh L. Rocker\nJ.E. Rocker`,
    day_3: `Subject: Final follow-up: ${jobTitle}\n\nHello ${recruiter},\n\nThis is my final scheduled follow-up regarding the ${jobTitle} opportunity at ${company}. If the position is still open, please let me know the preferred next step for review. If ownership has moved to another recruiter, I would appreciate the correct contact.\n\nThank you,\nVinh L. Rocker\nJ.E. Rocker`,
  };
}

function readVeteranIntake() {
  if (!fs.existsSync(VETERAN_INTAKE_PATH)) return { candidates: [] };
  const parsed = JSON.parse(fs.readFileSync(VETERAN_INTAKE_PATH, 'utf8'));
  if (!parsed || !Array.isArray(parsed.candidates)) {
    throw new Error('Veteran intake store must contain a candidates array.');
  }
  return parsed;
}

function readCandidateArtifact(candidate) {
  const relativePath = String(candidate.parsed_resume_path || '').trim();
  const artifactPath = path.resolve(JE_ROOT, relativePath);
  const relativeToCandidates = path.relative(CANDIDATE_ARTIFACT_DIRECTORY, artifactPath);
  if (!relativePath || relativeToCandidates.startsWith('..') || path.isAbsolute(relativeToCandidates)) {
    throw new Error('Candidate resume artifact is outside the approved candidate directory.');
  }
  if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
    throw new Error('Candidate resume artifact is unavailable.');
  }
  return fs.readFileSync(artifactPath, 'utf8');
}

function writeVeteranIntake(store) {
  fs.mkdirSync(path.dirname(VETERAN_INTAKE_PATH), { recursive: true });
  const temporary = `${VETERAN_INTAKE_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, VETERAN_INTAKE_PATH);
}

function runResumeParser(resumeText) {
  const temporaryDirectory = fs.mkdtempSync(path.join(CANDIDATE_ARTIFACT_DIRECTORY, '.intake-'));
  const sourcePath = path.join(temporaryDirectory, 'resume.txt');
  fs.writeFileSync(sourcePath, resumeText, 'utf8');
  try {
    const result = spawnSync(JE_PYTHON, [
      path.join(JE_ROOT, 'scripts/parse_incoming_resume.py'),
      sourcePath,
      '--output-directory',
      CANDIDATE_ARTIFACT_DIRECTORY,
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.trim() || 'Resume parser failed.');
    const outputPath = result.stdout.trim().split('\n').pop();
    if (!outputPath) throw new Error('Resume parser did not return an output path.');
    return path.resolve(outputPath);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function post_manual_lead(input) {
  const companyDomain = String(input.company_domain || '').trim().toLowerCase();
  const recruiterName = String(input.recruiter_name || '').trim();
  const recruiterTitle = String(input.recruiter_title || '').trim();
  const recruiterEmail = String(input.recruiter_email || '').trim().toLowerCase();
  const companyName = String(input.company_name || '').trim();
  const jobTitle = String(input.job_title || '').trim();
  const location = String(input.location || '').trim();
  const targetJobId = String(input.target_job_id || '').trim();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+$/.test(companyDomain)) {
    throw new Error('company_domain must be a valid domain, not a URL.');
  }
  if (!recruiterName || !recruiterTitle || !targetJobId) {
    throw new Error('recruiter_name, recruiter_title, and target_job_id are required.');
  }
  if (recruiterEmail && !/^\S+@\S+\.\S+$/.test(recruiterEmail)) {
    throw new Error('recruiter_email must be a valid email address.');
  }
  const store = readLeadStore();
  const leadId = crypto.createHash('sha256').update(companyDomain).digest('hex');
  const existing = store.leads.find((lead) => lead.lead_id === leadId);
  const pattern = CORPORATE_EMAIL_PATTERNS[companyDomain] || null;
  const lead = {
    lead_id: leadId,
    company_name: companyName || existing?.company_name || companyDomain,
    company_domain: companyDomain,
    job_title: jobTitle || existing?.job_title || null,
    location: location || existing?.location || null,
    target_job_id: targetJobId,
    recruiter_name: recruiterName,
    recruiter_title: recruiterTitle,
    recruiter_email: recruiterEmail || existing?.recruiter_email || null,
    hashed_business_email: existing?.hashed_business_email || null,
    verification_status: existing?.verification_status === 'deliverability_verified_100%'
      ? existing.verification_status : 'pending_manual_input',
    outreach_sent: existing?.outreach_sent === true,
    email_pattern: pattern,
    scouting_url: input.scouting_url || null,
    outreach_history: existing?.outreach_history || {
      pitch_sent: false,
      last_contact_ts: null,
      response_received: false,
    },
  };
  store.leads = store.leads.filter((item) => item.lead_id !== leadId);
  store.leads.push(lead);
  writeLeadStore(store);
  return lead;
}

// These routes run commands on Miller and Mal, so only this Mac's own browser tab may call them.
function localDashboardOnly(req, res, next) {
  const fromLocal = LOCAL_ADDRESSES.has(req.socket.remoteAddress);
  const hostOk = LOCAL_HOSTS.test(req.get('host') || '');
  const headerOk = req.get(CLIENT_HEADER) === CLIENT_HEADER_VALUE;
  if (!fromLocal || !hostOk || !headerOk) {
    return res.status(403).json({ error: 'Headhunter controls are only available from the dashboard on this Mac.' });
  }
  return next();
}

function streamProcess(child, res, { keepLog }) {
  const forward = (chunk) => {
    const text = chunk.toString();
    if (keepLog) appendLog(text);
    if (!res.writableEnded) res.write(text);
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);
}

function startJob(kind) {
  Object.assign(job, { kind, running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, status: 'running', cancelRequested: false, log: '' });
}

function finishJob(code, status = code === 0 ? 'completed' : 'failed') {
  Object.assign(job, { running: false, finishedAt: new Date().toISOString(), exitCode: code, status });
  activeChild = null;
}

function terminateChild(child) {
  if (!child || child.exitCode !== null) return false;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') child.kill('SIGTERM');
  }
  setTimeout(() => {
    if (child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') child.kill('SIGKILL');
      }
    }
  }, 5000).unref();
  return true;
}

function indexStatus() {
  // The live index is on Mal's local disk; this Data Drive backup is refreshed after every successful index run.
  const indexPath = path.join(JE_ROOT, 'db/qdrant_backup/collection/opportunities');
  try {
    return { indexReady: fs.existsSync(indexPath), indexUpdatedAt: fs.statSync(indexPath).mtime.toISOString() };
  } catch {
    return { indexReady: false, indexUpdatedAt: null };
  }
}

function registerHeadhunterRoutes(app, htmlLayout) {
  registerSemanticScoutRoute(app, localDashboardOnly);
  registerNormalizeResumeRoutes(app, localDashboardOnly);
  registerNormalizePipelineRoute(app, localDashboardOnly);
  registerCandidateDeliveryRoute(app, localDashboardOnly);
  registerUnblindDossierRoute(app, localDashboardOnly);
  app.post('/api/headhunter/semantic-autoresponder', localDashboardOnly, (req, res) => {
    try {
      const responder = buildSemanticAutoresponder(req.body || {});
      return res.json({ subject: responder.subject, body: responder.body, responder, stripe_links: STRIPE_LINKS });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });
  app.post('/api/headhunter/receipt', localDashboardOnly, (req, res) => {
    try {
      const receipt = buildPaymentReceipt(req.body || {});
      return res.json({
        order_reference: receipt.order_reference,
        subject: receipt.subject,
        body: receipt.body,
        receipt
      });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });
  app.get('/api/headhunter/status', localDashboardOnly, (req, res) => {
    res.json({ ...indexStatus(), job: { ...job, log: job.kind === 'sync' || job.kind === 'leidos' ? job.log : '' } });
  });

  app.post('/api/headhunter/scouting-url', localDashboardOnly, (req, res) => {
    const companyName = String(req.body?.company_name || '').trim();
    const jobTitle = String(req.body?.job_title || '').trim();
    const location = String(req.body?.location || '').trim();
    if (!companyName || !jobTitle || !location) {
      return res.status(400).json({ error: 'company_name, job_title, and location are required.' });
    }
    return res.json({ url: scoutingUrl(companyName, jobTitle, location) });
  });

  app.post('/api/headhunter/scout-lead', localDashboardOnly, async (req, res) => {
    const companyName = String(req.body?.company_name || '').trim();
    const jobTitle = String(req.body?.job_title || '').trim();
    const location = String(req.body?.location || '').trim();
    if (!companyName || !jobTitle || !location) {
      return res.status(400).json({ error: 'company_name, job_title, and location are required.' });
    }
    try {
      const url = scoutingUrl(companyName, jobTitle, location);
      const { profiles, result_count: resultCount } = await scoutRecruiterProfiles({ url, companyName, jobTitle });
      const ranked = rankRecruiters({ job_title: jobTitle, company_name: companyName, scouted_profiles: profiles });
      return res.json({ ...ranked, source_url: url, result_count: resultCount, extracted_profile_count: profiles.length });
    } catch (error) {
      return res.status(error.statusCode || 502).json({ error: error.message });
    }
  });

  app.post('/api/headhunter/manual-lead', localDashboardOnly, (req, res) => {
    try {
      const lead = post_manual_lead(req.body || {});
      const deal = appendLedgerDeal({ ...req.body, recruiter_lead_id: lead.lead_id });
      return res.status(201).json({ lead, deal });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/headhunter/ledger', localDashboardOnly, (req, res) => {
    return res.status(200).json({ ledger: readDealLedger() });
  });

  app.get('/api/headhunter/leads', localDashboardOnly, (req, res) => {
    try {
      const leads = readLeadStore().leads.map((lead) => ({
        lead_id: lead.lead_id,
        company_name: lead.company_name || lead.company_domain,
        company_domain: lead.company_domain,
        job_title: lead.job_title || '',
        location: lead.location || '',
        target_job_id: lead.target_job_id,
        recruiter_name: lead.recruiter_name,
        recruiter_title: lead.recruiter_title,
        recruiter_email: lead.recruiter_email,
        follow_up: buildFollowUpTemplates(lead),
      }));
      return res.json({ leads });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/headhunter/sync', localDashboardOnly, (req, res) => {
    if (job.running) {
      return res.status(409).json({ error: `A ${job.kind} job is already running (started ${job.startedAt}).` });
    }
    startJob('sync');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    const child = spawn(JE_PYTHON, ['-u', 'scripts/run_pipeline.py'], { cwd: JE_ROOT, detached: true });
    activeChild = child;
    streamProcess(child, res, { keepLog: true });
    child.on('error', (error) => {
      appendLog(`\nFailed to start pipeline: ${error.message}\n`);
      finishJob(-1, job.cancelRequested ? 'cancelled' : 'failed');
      if (!res.writableEnded) res.end(`\nFailed to start pipeline: ${error.message}\n`);
    });
    child.on('close', (code) => {
      const status = job.cancelRequested ? 'cancelled' : code === 0 ? 'completed' : 'failed';
      const summary = `\nPipeline ${status} with exit code ${code}\n`;
      appendLog(summary);
      finishJob(code, status);
      if (!res.writableEnded) res.end(summary);
    });
    // The pipeline writes to shared databases, so it keeps running if the browser tab closes.
    return undefined;
  });

  app.post('/api/headhunter/leidos', localDashboardOnly, (req, res) => {
    if (job.running) {
      return res.status(409).json({ error: `A ${job.kind} job is already running (started ${job.startedAt}).` });
    }
    startJob('leidos');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    const child = spawn(JE_PYTHON, ['-u', 'scripts/run_leidos_manual_pipeline.py'], { cwd: JE_ROOT, detached: true });
    activeChild = child;
    streamProcess(child, res, { keepLog: true });
    child.on('error', (error) => {
      appendLog(`\nFailed to start Leidos run: ${error.message}\n`);
      finishJob(-1, 'failed');
      if (!res.writableEnded) res.end(`\nFailed to start Leidos run: ${error.message}\n`);
    });
    child.on('close', (code) => {
      const status = job.cancelRequested ? 'cancelled' : code === 0 ? 'completed' : 'failed';
      const summary = `\nLeidos manual run ${status} with exit code ${code}\n`;
      appendLog(summary);
      finishJob(code, status);
      if (!res.writableEnded) res.end(summary);
    });
    return undefined;
  });

  app.post('/api/headhunter/stop', localDashboardOnly, (req, res) => {
    if (!job.running || !activeChild) {
      return res.status(409).json({ error: 'No active headhunter run to stop.' });
    }
    job.cancelRequested = true;
    job.status = 'cancelling';
    appendLog('\nStop requested from the control hub. Terminating the active run...\n');
    terminateChild(activeChild);
    return res.json({ status: 'cancelling', kind: job.kind });
  });

  app.get('/ai-headhunter', (req, res) => {
    const content = `
      <main class="business-driver-page headhunter-page ai-headhunter-page">
        <header class="portal-hero" style="border-top: 4px solid #34d399; margin-bottom: 20px; padding: 22px 18px;">
          <span class="business-tag" style="background:rgba(52,211,153,0.15);color:#34d399;border:1px solid rgba(52,211,153,0.4);">Business 2 &bull; Standalone Staffing Dashboard</span>
          <h1 style="font-size:2.1rem;margin:8px 0 4px;color:#f8fafc;">AI HEADHUNTER COMMAND CENTER</h1>
          <p style="margin:0 auto 14px;font-size:0.92rem;color:#94a3b8;">Defense &amp; Aerospace Career Ingestion &bull; Semantic ATS Normalization &bull; Recruiter Outreach &bull; Deal Ledger</p>
          <div style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap;">
            <a href="/" class="headhunter-button headhunter-button-secondary">&larr; ⌂ Return to Master Portal</a>
            <a href="/headhunter/match" class="headhunter-button">Launch Placement Terminal &rarr;</a>
            <a href="/business-driver" class="headhunter-button headhunter-button-secondary">Business 1: GovTech</a>
            <a href="/executive-matchmaker" class="headhunter-button headhunter-button-secondary">Business 3: Exec Matchmaker</a>
          </div>
        </header>

        <section class="sync-status-strip" aria-label="AI Headhunter sync status">
          <div><span class="weekly-sync-label">Sync status</span><strong id="weekly-sync-status">Checking...</strong></div>
          <div><span class="weekly-sync-label">Last sync</span><strong id="weekly-sync-last-run">Checking...</strong></div>
        </section>
        ${renderRevenueRibbon()}
        ${renderDealLedgerTable()}
        <section class="dark-block weekly-sync-card" id="weekly-sync-card">
          <div class="headhunter-header">
            <div><h3 class="block-title">Weekly Opportunity Sync</h3><p class="headhunter-note">Automated weekly refresh for career pages, matching data, and the live index.</p></div>
            <span class="headhunter-badge" id="hh-index-badge">Checking index...</span>
          </div>
          <div class="inner-box weekly-sync-summary">
            <p id="pipeline-status" class="headhunter-note" aria-live="polite">Checking scheduled sync status...</p>
            <div class="headhunter-progress"><div class="headhunter-progress-header"><span>Current sync progress</span><strong id="pipeline-progress-value">0%</strong></div><progress id="pipeline-progress" max="100" value="0">0%</progress><p id="pipeline-progress-stage" class="headhunter-note">Idle</p><p id="pipeline-progress-site" class="headhunter-note">Site: None</p></div>
            <div class="headhunter-actions"><button id="btn-sync-pipeline" type="button" class="headhunter-button">Run Sync Now</button><button id="btn-leidos-manual" type="button" class="headhunter-button headhunter-button-secondary">Run Leidos Manually</button><button id="btn-stop-pipeline" type="button" class="headhunter-button headhunter-button-danger" disabled>Stop Active Run</button><a href="/headhunter/match" class="headhunter-button headhunter-button-secondary">Launch Interactive Placement Terminal</a></div>
            <div class="headhunter-log" id="pipeline-output" hidden><div class="headhunter-log-header">Pipeline output</div><pre id="console-stream" class="headhunter-console">Ready.</pre></div>
          </div>
        </section>
        ${headhunterPanelHtml}
      </main>
    `;
    res.send(htmlLayout({ title: 'JE ROCKER LC - AI HEADHUNTER', content, includeNav: false, showStatusStrip: false }));
  });

  app.get('/api/headhunter/candidates', localDashboardOnly, (req, res) => {
    try {
      const candidates = readVeteranIntake().candidates
        .filter((candidate) => candidate.pipeline_status === 'Staged')
        .map((candidate) => ({
          candidate_id: candidate.candidate_id,
          first_name: candidate.first_name,
          last_name: candidate.last_name,
          military_rank_extracted: candidate.military_rank_extracted,
          clearance_status_extracted: candidate.clearance_status_extracted,
          parsed_resume_path: candidate.parsed_resume_path,
        }));
      return res.json({ candidates });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/headhunter/candidates/:candidateId/profile', localDashboardOnly, (req, res) => {
    try {
      const candidate = readVeteranIntake().candidates.find(
        (item) => item.candidate_id === req.params.candidateId,
      );
      if (!candidate || candidate.pipeline_status !== 'Staged') {
        return res.status(404).json({ error: 'Staged candidate not found.' });
      }
      return res.json({
        candidate_id: candidate.candidate_id,
        rank: candidate.military_rank_extracted || 'Veteran',
        clearance: candidate.clearance_status_extracted || 'Lapsed',
        parsed_resume_path: candidate.parsed_resume_path,
        profile: readCandidateArtifact(candidate),
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/intake-manual', localDashboardOnly, (req, res) => {
    const firstName = String(req.body?.first_name || '').trim();
    const lastName = String(req.body?.last_name || '').trim();
    const contactEmail = String(req.body?.contact_email || '').trim().toLowerCase();
    const phoneNumber = String(req.body?.phone_number || '').trim();
    const resumeText = String(req.body?.resume_text || '').trim();
    if (!firstName || !lastName || !contactEmail || !phoneNumber || !resumeText) {
      return res.status(400).json({ error: 'first_name, last_name, contact_email, phone_number, and resume_text are required.' });
    }
    if (!/^\S+@\S+\.\S+$/.test(contactEmail)) {
      return res.status(400).json({ error: 'contact_email must be a valid email address.' });
    }
    try {
      const parsedPath = runResumeParser(resumeText);
      const parsedText = fs.readFileSync(parsedPath, 'utf8');
      const headerLines = parsedText.split(/\r?\n/).slice(0, 2);
      const rank = (headerLines[0].match(/^Rank:\s*(.+)$/i) || [])[1] || 'Veteran';
      const clearance = (headerLines[1].match(/^Clearance:\s*(.+)$/i) || [])[1] || 'Lapsed';
      const onboardingTimestamp = new Date().toISOString();
      const candidate = {
        candidate_id: crypto.createHash('sha256').update(contactEmail + onboardingTimestamp).digest('hex'),
        first_name: firstName,
        last_name: lastName,
        contact_email: contactEmail,
        phone_number: phoneNumber,
        military_rank_extracted: rank,
        clearance_status_extracted: clearance,
        parsed_resume_path: path.relative(JE_ROOT, parsedPath),
        onboarding_timestamp: onboardingTimestamp,
        pipeline_status: 'Staged',
        intake_source: 'dashboard_manual',
      };
      const store = readVeteranIntake();
      store.candidates.unshift(candidate);
      writeVeteranIntake(store);
      return res.status(201).json({ candidate });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/headhunter/match', localDashboardOnly, (req, res) => {
    const profile = typeof req.body?.profile === 'string' ? req.body.profile.trim() : '';
    const redact = typeof req.body?.redact === 'string' ? req.body.redact.replace(/[\r\n]+/g, ' ').trim() : '';
    if (!profile) return res.status(400).json({ error: 'Paste a veteran profile first.' });
    if (profile.length > MAX_PROFILE_CHARS) {
      return res.status(413).json({ error: `Profile is too long (max ${MAX_PROFILE_CHARS} characters).` });
    }
    if (job.running) {
      return res.status(409).json({ error: `A ${job.kind} job is running; try again when it finishes.` });
    }
    startJob('match');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    const matchScript = path.join(JE_ROOT, 'scripts/match_veteran_pitch.py');
    const backupIndex = path.join(JE_ROOT, 'db/qdrant_backup');
    let child;
    if (fs.existsSync(JE_PYTHON) && fs.existsSync(matchScript) && fs.existsSync(backupIndex)) {
      child = spawn(JE_PYTHON, [matchScript, '--index-path', backupIndex, '--llm-model', 'llama3.2:latest'], { cwd: JE_ROOT });
    } else {
      child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', MAL, MAL_MATCH_COMMAND]);
    }
    streamProcess(child, res, { keepLog: false });
    child.stdin.end(`${redact ? `Redact: ${redact}\n` : ''}${profile}\n`);
    child.on('error', (error) => {
      finishJob(-1);
      if (!res.writableEnded) res.end(`\nMatcher failed to start: ${error.message}\n`);
    });
    child.on('close', (code) => {
      finishJob(code);
      if (!res.writableEnded) res.end(code === 0 ? '' : `\nMatcher exited with code ${code}\n`);
    });
    // Matching has no side effects, so stop it if the user leaves the page.
    res.on('close', () => {
      if (child.exitCode === null) child.kill('SIGTERM');
    });
    return undefined;
  });

  app.get('/api/headhunter/inspect-db', localDashboardOnly, (req, res) => {
    // Qdrant's on-disk store allows one process at a time, so don't read while a sync or match holds it.
    if (job.running) {
      return res.status(409).json({ error: `A ${job.kind} job is running; try again when it finishes.` });
    }
    const inspectScript = path.join(JE_ROOT, 'scripts/inspect_job_index.py');
    const backupIndex = path.join(JE_ROOT, 'db/qdrant_backup');
    let child;
    if (fs.existsSync(JE_PYTHON) && fs.existsSync(inspectScript) && fs.existsSync(backupIndex)) {
      child = spawn(JE_PYTHON, [inspectScript, '--index-path', backupIndex], { cwd: JE_ROOT });
    } else {
      child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', MAL, MAL_INSPECT_COMMAND]);
    }
    const out = [];
    let size = 0;
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), INSPECT_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_INSPECT_BYTES) child.kill('SIGTERM');
      else out.push(chunk);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (!res.headersSent) res.status(502).json({ error: `Inspector failed to start: ${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (res.headersSent) return;
      if (code !== 0) {
        return res.status(502).json({ error: (stderr.trim().split('\n').pop() || `Inspector exited with code ${code}`) });
      }
      try {
        return res.json(JSON.parse(Buffer.concat(out).toString('utf8')));
      } catch {
        return res.status(502).json({ error: 'Inspector returned invalid JSON.' });
      }
    });
    return undefined;
  });

  app.get('/headhunter/match', (req, res) => {
    const content = `
      <main class="business-driver-page headhunter-page">
        ${renderRevenueRibbon()}
        <div class="identity-center"><div class="cover-identity">
          <h1>Interactive Placement Terminal</h1>
          <h2>Anonymized veteran matching • Runs on Mac Mal</h2>
          <div class="headhunter-actions">
            <a class="headhunter-button headhunter-button-secondary" href="/ai-headhunter#lead-intake-panel">Scout Lead</a>
          </div>
        </div></div>
        <div class="cockpit-row">
          <section class="dark-block cockpit-col"><h3 class="block-title">Veteran Profile</h3><div class="inner-box">
            <form id="hh-match-form" class="headhunter-form">
              <label for="hh-profile">Paste resume text, MOS/AFSC, and clearance (e.g. "Clearance: Active TS/SCI"):</label>
              <textarea id="hh-profile" rows="14" required placeholder="Rank: Staff Sergeant (E-6)&#10;MOS: 25B Information Technology Specialist&#10;Clearance: Active TS/SCI&#10;Skills: Cisco routing, Palo Alto firewalls, Splunk"></textarea>
              <label for="hh-redact">Names, units, or other identifiers to redact (comma-separated):</label>
              <input id="hh-redact" type="text" autocomplete="off" placeholder="Full name, unit, base" />
              <button id="hh-match-run" type="submit" class="headhunter-button">Find Matches &amp; Draft Emails</button>
              <p class="headhunter-note">Only the anonymized profile reaches the model. Review every email before sending.</p>
            </form>
          </div></section>
        </div>
        <section class="dark-block"><h3 class="block-title">Matches &amp; Pitch Emails</h3>
          <div id="hh-match-output" class="headhunter-console">Results will appear here.</div>
        </section>
        ${renderDealLedgerTable()}
        <section id="interactive-lead-panel" class="dark-block interactive-lead-panel" hidden>
          <div class="headhunter-header">
            <h3 class="block-title">Lead Intake &amp; Pitch</h3>
            <span id="interactive-lead-status" class="headhunter-badge">Select Scout Lead on a match</span>
          </div>
          <div class="inner-box">
            <form id="interactive-lead-form" class="headhunter-form">
              <label>Matched Job<input id="interactive-job-title" name="job_title" type="text" readonly /></label>
              <label>Pitch Number<input id="interactive-pitch-number" name="pitch_number" type="text" readonly /></label>
              <label>Match Row Number<input id="interactive-match-row" name="match_row_number" type="text" readonly /></label>
              <label>Company<input id="interactive-company-name" name="company_name" type="text" readonly /></label>
              <label>Location<input id="interactive-location" name="location" type="text" readonly /></label>
              <label>Qdrant Job ID<input id="interactive-job-id" name="target_job_id" type="text" readonly /></label>
              <label>Company Domain<input id="interactive-company-domain" name="company_domain" type="text" placeholder="example.com" required /></label>
              <label>Recruiter Name<input name="recruiter_name" type="text" placeholder="Recruiter full name" required /></label>
              <label>Recruiter Title<input name="recruiter_title" type="text" placeholder="Talent Acquisition Partner" required /></label>
              <label>Recruiter Email<input name="recruiter_email" type="email" placeholder="recruiter@company.com" required /></label>
              <label>Candidate Type<select name="candidate_type"><option value="Veteran">Veteran</option><option value="Civilian">Civilian</option></select></label>
              <label>Candidate Email<input name="candidate_email" type="email" placeholder="Optional candidate email" /></label>
              <label>Annualized Base Salary<input name="annualized_base_salary" type="number" min="0" step="1000" value="0" /></label>
              <div class="headhunter-actions">
                <button id="interactive-scout-lead" type="button" class="headhunter-button headhunter-button-secondary">Scout Lead</button>
                <button type="submit" class="headhunter-button">Save Lead &amp; Generate Pitch</button>
              </div>
            </form>
            <div id="interactive-pitch-panel" hidden>
              <label for="interactive-pitch">Ready-to-send pitch</label>
              <textarea id="interactive-pitch" class="candidate-profile-canvas" rows="12" readonly></textarea>
              <button id="interactive-copy-pitch" type="button" class="headhunter-button">Copy Email Body</button>
            </div>
            <details id="outreach-follow-up-suite">
              <summary>Outreach Follow-Up Suite</summary>
              <label for="stored-lead-selector">Review stored lead</label>
              <select id="stored-lead-selector" class="qa-search">
                <option value="">Select a saved lead</option>
              </select>
              <p id="follow-up-variant" class="headhunter-note">Select a stored lead to hydrate the three-day sequence.</p>
              <label for="follow-up-day-1">Day 1</label>
              <textarea id="follow-up-day-1" class="candidate-profile-canvas" rows="8" readonly></textarea>
              <label for="follow-up-day-2">Day 2</label>
              <textarea id="follow-up-day-2" class="candidate-profile-canvas" rows="8" readonly></textarea>
              <label for="follow-up-day-3">Day 3</label>
              <textarea id="follow-up-day-3" class="candidate-profile-canvas" rows="8" readonly></textarea>
              <button id="copy-follow-up-body" type="button" class="headhunter-button" disabled>Copy Follow-Up Body</button>
            </details>
          </div>
        </section>
      </main>
      <script>
        (() => {
          const form = document.getElementById('hh-match-form');
          const output = document.getElementById('hh-match-output');
          const button = document.getElementById('hh-match-run');
          const profileField = document.getElementById('hh-profile');
          const leadPanel = document.getElementById('interactive-lead-panel');
          const leadForm = document.getElementById('interactive-lead-form');
          const leadStatus = document.getElementById('interactive-lead-status');
          const leadScoutButton = document.getElementById('interactive-scout-lead');
          const pitchPanel = document.getElementById('interactive-pitch-panel');
          const pitchField = document.getElementById('interactive-pitch');
          const storedLeadSelector = document.getElementById('stored-lead-selector');
          const followUpVariantField = document.getElementById('follow-up-variant');
          const followUpFields = {
            day_1: document.getElementById('follow-up-day-1'),
            day_2: document.getElementById('follow-up-day-2'),
            day_3: document.getElementById('follow-up-day-3'),
          };
          const copyFollowUpButton = document.getElementById('copy-follow-up-body');
          let storedLeads = [];
          let selectedJob = null;
          let scoutedUrl = null;
          let selectedRecruiter = null;
          const hydrateFollowUp = (lead) => {
            const templates = lead?.follow_up;
            if (!templates) {
              Object.values(followUpFields).forEach((field) => { field.value = ''; });
              copyFollowUpButton.disabled = true;
              followUpVariantField.textContent = 'Select a stored lead to hydrate the three-day sequence.';
              return;
            }
            Object.keys(followUpFields).forEach((day) => { followUpFields[day].value = templates[day] || ''; });
            followUpVariantField.textContent = templates.variant + ' variant for ' + (lead.company_name || lead.company_domain) + '.';
            copyFollowUpButton.disabled = false;
          };
          const loadStoredLeads = async () => {
            const response = await fetch('/api/headhunter/leads', { headers: { '${CLIENT_HEADER}': '${CLIENT_HEADER_VALUE}' } });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'Stored lead request failed (' + response.status + ')');
            storedLeads = data.leads || [];
            storedLeadSelector.innerHTML = '<option value="">Select a saved lead</option>';
            storedLeads.forEach((lead) => {
              const option = document.createElement('option');
              option.value = lead.lead_id;
              option.textContent = [lead.recruiter_name, lead.company_name, lead.job_title].filter(Boolean).join(' | ');
              storedLeadSelector.appendChild(option);
            });
            storedLeadSelector.disabled = storedLeads.length === 0;
          };
          storedLeadSelector.addEventListener('change', () => {
            hydrateFollowUp(storedLeads.find((lead) => lead.lead_id === storedLeadSelector.value));
          });
          copyFollowUpButton.addEventListener('click', async () => {
            const body = Object.values(followUpFields).map((field) => field.value).filter(Boolean).join(String.fromCharCode(10) + String.fromCharCode(10));
            await navigator.clipboard.writeText(body);
            followUpVariantField.textContent = 'Three-day follow-up sequence copied to clipboard.';
          });
          loadStoredLeads().catch((error) => { followUpVariantField.textContent = error.message; });
          const refreshLedger = async () => {
            const response = await fetch('/api/headhunter/ledger', { headers: { '${CLIENT_HEADER}': '${CLIENT_HEADER_VALUE}' } });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'Ledger refresh failed (' + response.status + ')');
            const body = document.getElementById('live-placements-body');
            const count = document.getElementById('live-placements-count');
            if (!body || !count) return;
            const deals = data.ledger.active_deals || [];
            body.replaceChildren();
            count.textContent = deals.length + ' active';
            if (!deals.length) {
              const emptyRow = document.createElement('tr');
              const emptyCell = document.createElement('td');
              emptyCell.colSpan = 5;
              emptyCell.className = 'qa-empty';
              emptyCell.textContent = 'No active deals.';
              emptyRow.appendChild(emptyCell);
              body.appendChild(emptyRow);
              return;
            }
            deals.forEach((deal) => {
              const row = document.createElement('tr');
              const stage = deal.current_pipeline_stage === 'Pitch Prepared' ? 'Pitched' : (deal.current_pipeline_stage || 'Staged');
              [
                deal.candidate_email || deal.candidate_id || 'Unassigned',
                deal.company_name || 'Pending company',
                deal.recruiter_name || 'Pending recruiter',
                stage,
                Number(deal.projected_contingency_fee || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
              ].forEach((value) => {
                const cell = document.createElement('td');
                cell.textContent = value;
                row.appendChild(cell);
              });
              const actionCell = document.createElement('td');
              const unblindBtn = document.createElement('button');
              unblindBtn.type = 'button';
              unblindBtn.className = 'headhunter-button headhunter-button-secondary btn-unblind-dossier';
              unblindBtn.textContent = '📁 Un-Blind & Copy Corporate Dossier';
              unblindBtn.dataset.dealId = deal.deal_id || '';
              unblindBtn.dataset.candidateId = deal.candidate_id || '';
              unblindBtn.addEventListener('click', async () => {
                unblindBtn.disabled = true;
                unblindBtn.textContent = 'Un-blinding...';
                try {
                  const unblindRes = await fetch('/api/unblind-dossier', {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ candidate_id: deal.candidate_id, deal_id: deal.deal_id }),
                  });
                  const unblindData = await unblindRes.json().catch(() => ({}));
                  if (!unblindRes.ok) throw new Error(unblindData.error || 'Un-blind failed (' + unblindRes.status + ')');
                  await navigator.clipboard.writeText(unblindData.unblinded_dossier);
                  unblindBtn.textContent = '✓ Un-Blinded Dossier Copied!';
                  await refreshLedger();
                } catch (err) {
                  alert(err.message);
                  unblindBtn.disabled = false;
                  unblindBtn.textContent = '📁 Un-Blind & Copy Corporate Dossier';
                }
              });
              actionCell.appendChild(unblindBtn);
              row.appendChild(actionCell);
              body.appendChild(row);
            });
          };
          const renderPitch = (recruiter) => {
            const email = recruiter.email || leadForm.elements.recruiter_email.value;
            pitchField.value = [
              'To: ' + email,
              'Subject: [Pitch #' + selectedJob.pitch_number + ' | Match Row #' + selectedJob.match_row_number + '] Veteran Systems Operations Candidate | Matched to ' + selectedJob.job_title + ' Role',
              '',
              'Hello ' + recruiter.name + ',',
              '',
              'I am reaching out regarding the ' + selectedJob.job_title + ' opportunity at ' + selectedJob.company_name + '. I have a veteran systems and operations candidate whose background aligns with this requirement.',
              '',
              'Please let me know the appropriate process for submitting the candidate for review.',
              '',
              'Regards,',
              'Vinh L. Rocker',
              'Founder & CEO | J.E. Rocker',
              '480-414-9915',
              'JEROCKER@outlook.com',
            ].join(String.fromCharCode(10));
            pitchPanel.hidden = false;
          };
          let streamBuffer = '';
          let matchRowNumber = 0;
          const renderLine = (line) => {
            const trimmedLine = line.trim();
            const matchMarker = trimmedLine.indexOf('match=');
            const scoreEnd = matchMarker >= 0 ? trimmedLine.indexOf('  ', matchMarker) : -1;
            const matchParts = scoreEnd >= 0 ? trimmedLine.slice(scoreEnd + 2).split(' | ') : [];
            const idMarker = matchParts.length >= 4 ? matchParts[3].lastIndexOf('[id=') : -1;
            const match = matchMarker >= 0 && scoreEnd >= 0 && matchParts.length >= 4 && idMarker >= 0
              ? [null, '', matchParts[0], matchParts[1], matchParts[2], '', '', matchParts[3].slice(idMarker + 4, -1)]
              : null;
            if (!match) {
              const text = document.createElement('div');
              text.textContent = line;
              output.appendChild(text);
              return;
            }
            const selectedMatchRowNumber = ++matchRowNumber;
            const row = document.createElement('div');
            row.className = 'match-result-row';
            row.textContent = line;
            output.appendChild(row);
            const action = document.createElement('div');
            action.className = 'match-result-action';
            const scout = document.createElement('button');
            scout.type = 'button';
            scout.className = 'headhunter-button headhunter-button-secondary';
            scout.textContent = 'Scout Lead';
            scout.addEventListener('click', async () => {
              selectedJob = {
                job_title: match[2],
                company_name: match[3],
                location: match[4],
                target_job_id: match[7],
                pitch_number: selectedMatchRowNumber,
                match_row_number: selectedMatchRowNumber,
              };
              leadPanel.hidden = false;
              pitchPanel.hidden = true;
              scoutedUrl = null;
              Object.entries(selectedJob).forEach(([name, value]) => {
                leadForm.elements[name].value = value;
              });
              leadStatus.textContent = 'Match row #' + selectedMatchRowNumber + ' selected. Enter recruiter details to continue.';
              leadPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
              leadStatus.textContent = 'Reading recruiter search in the background...';
              try {
                const response = await fetch('/api/headhunter/scout-lead', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', '${CLIENT_HEADER}': '${CLIENT_HEADER_VALUE}' },
                  body: JSON.stringify(selectedJob),
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Background recruiter scouting failed.');
                selectedRecruiter = data.selected;
                leadForm.elements.recruiter_name.value = selectedRecruiter.name;
                leadForm.elements.recruiter_title.value = selectedRecruiter.title;
                leadForm.elements.recruiter_email.value = selectedRecruiter.email || '';
                leadForm.elements.company_domain.value = selectedRecruiter.company_domain || '';
                renderPitch(selectedRecruiter);
                leadStatus.textContent = 'Recruiter selected. Review details, then confirm and save the lead.';
              } catch (error) {
                selectedRecruiter = null;
                leadStatus.textContent = error.message + ' Enter verified recruiter details manually to continue.';
              }
            });
            action.appendChild(scout);
            output.appendChild(action);
          };
          const renderChunk = (chunk) => {
            streamBuffer += chunk;
            const lines = streamBuffer.split(String.fromCharCode(10));
            streamBuffer = lines.pop() || '';
            lines.forEach(renderLine);
            output.scrollTop = output.scrollHeight;
          };
          leadScoutButton.addEventListener('click', async () => {
            if (!selectedJob) return;
            const popup = window.open('about:blank', '_blank', 'noopener,noreferrer');
            leadStatus.textContent = 'Building recruiter search...';
            try {
              const response = await fetch('/api/headhunter/scouting-url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', '${CLIENT_HEADER}': '${CLIENT_HEADER_VALUE}' },
                body: JSON.stringify(selectedJob),
              });
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || 'Scouting request failed.');
              scoutedUrl = data.url;
              if (popup) popup.location = scoutedUrl;
              else window.open(scoutedUrl, '_blank', 'noopener,noreferrer');
              leadStatus.textContent = 'Scouting search opened. Review the recruiter before saving.';
            } catch (error) {
              if (popup) popup.close();
              leadStatus.textContent = error.message;
            }
          });
          leadForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            leadStatus.textContent = 'Saving lead...';
            try {
              const values = Object.fromEntries(new FormData(leadForm));
              const response = await fetch('/api/headhunter/manual-lead', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', '${CLIENT_HEADER}': '${CLIENT_HEADER_VALUE}' },
                body: JSON.stringify({ ...values, scouting_url: scoutedUrl }),
              });
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || 'Lead save failed.');
              const recruiterEmail = values.recruiter_email;
              renderPitch({ name: values.recruiter_name, email: recruiterEmail });
              await loadStoredLeads();
              storedLeadSelector.value = data.lead.lead_id;
              hydrateFollowUp(storedLeads.find((lead) => lead.lead_id === data.lead.lead_id));
              await refreshLedger();
              leadStatus.textContent = 'Lead saved. Pitch ready to copy into email.';
            } catch (error) {
              leadStatus.textContent = error.message;
            }
          });
          document.getElementById('interactive-copy-pitch').addEventListener('click', async () => {
            await navigator.clipboard.writeText(pitchField.value);
            leadStatus.textContent = 'Pitch copied to clipboard.';
          });
          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            button.disabled = true;
            button.textContent = 'Matching on Mac Mal...';
            output.replaceChildren();
            streamBuffer = '';
            try {
              const response = await fetch('/api/headhunter/match', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', '${CLIENT_HEADER}': '${CLIENT_HEADER_VALUE}' },
                body: JSON.stringify({ profile: profileField.value, redact: document.getElementById('hh-redact').value }),
              });
              if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                throw new Error(body.error || 'Match request failed (' + response.status + ')');
              }
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                renderChunk(decoder.decode(value, { stream: true }));
              }
              if (streamBuffer) renderLine(streamBuffer);
            } catch (error) {
              renderLine(error.message);
            } finally {
              button.disabled = false;
              button.textContent = 'Find Matches & Draft Emails';
            }
          });
        })();
      </script>
    `;
    res.send(htmlLayout({ title: 'JE ROCKER LC - Placement Terminal', content, includeNav: false, statusClass: 'system-row' }));
  });
}

const headhunterPanelHtml = `
  <details class="dark-block candidate-profile-panel">
    <summary class="headhunter-header">
      <h3 class="block-title">Candidate Profile</h3>
      <span class="headhunter-badge" id="candidate-profile-status">Loading staged candidates...</span>
    </summary>
    <div class="inner-box">
      <details id="manual-intake-container">
        <summary>Add New Client Intake</summary>
        <form id="manual-intake-form" class="headhunter-form">
          <div class="cockpit-row">
            <label>First Name<input name="first_name" type="text" required /></label>
            <label>Last Name<input name="last_name" type="text" required /></label>
          </div>
          <div class="cockpit-row">
            <label>Contact Email<input name="contact_email" type="email" required /></label>
            <label>Phone Number<input name="phone_number" type="tel" required /></label>
          </div>
          <label>Raw Resume Payload<textarea name="resume_text" rows="9" required placeholder="Paste the raw resume text here."></textarea></label>
          <button type="submit" class="headhunter-button">Save Candidate</button>
          <p id="manual-intake-status" class="headhunter-note" aria-live="polite"></p>
        </form>
      </details>
      <label for="candidate-selector">Staged inbound veteran</label>
      <select id="candidate-selector" class="qa-search" disabled>
        <option value="">Select a candidate</option>
      </select>
      <p id="candidate-profile-meta" class="headhunter-note" aria-live="polite">Select a staged candidate to hydrate the profile.</p>
      <textarea id="candidate-profile-canvas" class="candidate-profile-canvas" rows="18" readonly placeholder="The parsed resume will appear here."></textarea>
      <div class="headhunter-actions">
        <button id="btn-semantic-rewrite" type="button" class="headhunter-button" disabled>⚡ Execute Semantic AI Rewrite</button>
      </div>
      <p id="semantic-rewrite-status" class="headhunter-note" aria-live="polite">Select a staged candidate to enable Word review.</p>
    </div>
  </details>
  <details id="second-pass-finalization-panel" class="dark-block candidate-profile-panel">
    <summary class="headhunter-header">
      <h3 class="block-title">Second-Pass Resume Finalization</h3>
      <span class="headhunter-badge">Manual approval required</span>
    </summary>
    <div class="inner-box">
      <label for="approved-normalized-resume">Approved normalized resume from Microsoft Word</label>
      <textarea id="approved-normalized-resume" class="candidate-profile-canvas" rows="18" placeholder="Paste the hand-polished normalized resume here."></textarea>
      <div class="headhunter-actions">
        <button id="btn-sanitize-finalize" type="button" class="headhunter-button" disabled>Sanitize &amp; Finalize Document</button>
      </div>
      <p id="second-pass-status" class="headhunter-note" aria-live="polite">Select a candidate and paste the approved resume.</p>
      <label for="sanitized-resume-preview">Sanitized resume preview</label>
      <textarea id="sanitized-resume-preview" class="candidate-profile-canvas" rows="14" readonly placeholder="The sanitized resume will appear here."></textarea>
    </div>
  </details>
  <details id="candidate-delivery-panel" class="dark-block candidate-profile-panel">
    <summary class="headhunter-header">
      <h3 class="block-title">📦 Final Candidate Delivery Packet</h3>
      <span class="headhunter-badge">Copy-ready</span>
    </summary>
    <div class="inner-box">
      <p id="candidate-delivery-status" class="headhunter-note" aria-live="polite">Finalize an approved resume to compose the delivery packet.</p>
      <textarea id="candidate-delivery-preview" class="candidate-profile-canvas" rows="24" readonly placeholder="The complete client delivery email will appear here."></textarea>
      <button id="btn-copy-candidate-delivery" type="button" class="headhunter-button" disabled>Copy Candidate Delivery Email</button>
    </div>
  </details>
  <section class="dark-block headhunter-intake-instructions">
    <div class="headhunter-header">
      <h3 class="block-title">Veteran Candidate Intake</h3>
      <span class="headhunter-badge">Private email loop</span>
    </div>
    <div class="inner-box">
      <p>Send your current resume in PDF, DOCX, or TXT format directly to <strong>JEROCKER@outlook.com</strong>.</p>
      <p>Your profile is processed through the localized data gateway, which detects rank and clearance tokens before matching your background against the active opportunity index.</p>
      <p>Sovereign. Private. Built for Veterans First.</p>
    </div>
  </section>
  <div class="cockpit-row">
    <details id="lead-intake-panel" class="dark-block cockpit-col lead-intake-panel">
      <summary class="headhunter-header">
        <h3 class="block-title">Lead Intake</h3>
        <span class="headhunter-badge">Fail-closed</span>
      </summary>
      <div class="inner-box">
        <form id="lead-intake-form" class="headhunter-form">
          <label for="lead-company-name">Company name</label>
          <input id="lead-company-name" name="company_name" type="text" required />
          <label for="lead-company-domain">Company domain</label>
          <input id="lead-company-domain" name="company_domain" type="text" placeholder="example.com" required />
          <label for="lead-job-title">Matched job title</label>
          <input id="lead-job-title" name="job_title" type="text" required />
          <label for="lead-location">Job location</label>
          <input id="lead-location" name="location" type="text" required />
          <label for="lead-job-id">Matched Qdrant job ID</label>
          <input id="lead-job-id" name="target_job_id" type="text" required />
          <label for="lead-recruiter-name">Recruiter full name</label>
          <input id="lead-recruiter-name" name="recruiter_name" type="text" required />
          <label for="lead-recruiter-title">Recruiter title</label>
          <input id="lead-recruiter-title" name="recruiter_title" type="text" required />
          <label for="lead-recruiter-email">Recruiter email</label>
          <input id="lead-recruiter-email" name="recruiter_email" type="email" placeholder="recruiter@company.com" />
          <div class="headhunter-actions">
            <button id="btn-scout-lead" type="button" class="headhunter-button headhunter-button-secondary">Scout Lead</button>
            <button type="submit" class="headhunter-button">Save Lead</button>
          </div>
          <p id="lead-intake-status" class="headhunter-note" aria-live="polite">No lead staged.</p>
        </form>
      </div>
    </details>
  </div>
  <details class="dark-block semantic-responder-panel">
    <summary class="headhunter-header">
      <h3 class="block-title">Semantic Candidate Responder</h3>
      <span class="headhunter-badge">Copy-ready draft</span>
    </summary>
    <div class="inner-box">
      <p>Generate the veteran or civilian launch response after the local match run. No message is sent and no payment is recorded from this panel.</p>
      <form id="semantic-responder-form" class="headhunter-form">
        <div class="cockpit-row">
          <label>Candidate type<select name="candidate_type"><option value="Veteran">Veteran</option><option value="Civilian">Civilian</option></select></label>
          <label>Candidate first name<input name="first_name" type="text" required maxlength="80" /></label>
          <label>Qualified matches<input name="match_count" type="number" min="0" step="1" required value="0" /></label>
        </div>
        <div class="headhunter-actions">
          <button type="submit" class="headhunter-button">Generate Auto-Responder</button>
          <button id="semantic-responder-copy" type="button" class="headhunter-button headhunter-button-secondary" disabled>Copy Email</button>
        </div>
        <p id="semantic-responder-status" class="headhunter-note" aria-live="polite">Draft not generated.</p>
        <label>Subject<input id="semantic-responder-subject" type="text" readonly /></label>
        <label>Email body<textarea id="semantic-responder-body" class="candidate-profile-canvas" rows="24" readonly placeholder="The selected template will appear here."></textarea></label>
      </form>
    </div>
  </details>
  <details class="dark-block payment-receipt-panel">
    <summary class="headhunter-header">
      <h3 class="block-title">Customer Payment Receipt Composer</h3>
      <span class="headhunter-badge">Confirmation &amp; Queue</span>
    </summary>
    <div class="inner-box">
      <p>Generate a verified "Paid In Full" receipt with an official Order Reference and 3-step queue statement once payment clears.</p>
      <form id="payment-receipt-form" class="headhunter-form">
        <div class="cockpit-row">
          <label>Candidate ID (SHA-256)<input id="receipt-candidate-id" name="candidate_id" type="text" placeholder="Optional or staged ID for token hash" maxlength="64" /></label>
          <label>Candidate type<select id="receipt-candidate-type" name="candidate_type"><option value="Veteran">Veteran ($99.00)</option><option value="Civilian">Civilian ($149.00)</option></select></label>
          <label>Candidate first name<input id="receipt-first-name" name="first_name" type="text" required maxlength="80" /></label>
        </div>
        <div class="headhunter-actions">
          <button type="submit" class="headhunter-button">Generate Payment Receipt</button>
          <button id="payment-receipt-copy" type="button" class="headhunter-button headhunter-button-secondary" disabled>Copy Payment Receipt</button>
        </div>
        <p id="payment-receipt-status" class="headhunter-note" aria-live="polite">Receipt not generated.</p>
        <label>Order Reference<input id="payment-receipt-ref" type="text" readonly placeholder="JER-SEMAN-[TOKEN]" /></label>
        <label>Subject<input id="payment-receipt-subject" type="text" readonly /></label>
        <label>Receipt preview (Read-only)<textarea id="payment-receipt-body" class="candidate-profile-canvas" rows="24" readonly placeholder="The customer confirmation and receipt layout will appear here."></textarea></label>
      </form>
    </div>
  </details>
  <div class="cockpit-row">
    <section class="dark-block cockpit-col qa-inspection-panel">
      <div class="headhunter-header">
        <h3 class="block-title">Database Quality Assurance (QA) Inspector</h3>
        <button id="btn-qa-refresh" type="button" class="headhunter-button headhunter-button-secondary">Refresh Live Data</button>
      </div>
      <div class="inner-box">
        <p>Audit the job records stored in Mac Mal's vector index before running veteran matches.</p>
        <p id="qa-summary" class="headhunter-note">Click refresh to load indexed records.</p>
        <input id="qa-search" class="qa-search" type="search" autocomplete="off" placeholder="Filter by company, title, location, clearance, or skill..." aria-label="Filter indexed records" disabled />
        <div class="qa-table-container">
          <table id="qa-opportunities-table" class="qa-table">
            <thead><tr><th>Company</th><th>Job Title</th><th>Location</th><th>Clearance Required</th><th>Extracted Skills</th></tr></thead>
            <tbody id="qa-table-body"><tr><td colspan="5" class="qa-empty">No data loaded.</td></tr></tbody>
          </table>
        </div>
      </div>
    </section>
  </div>
  <script>
    (() => {
      const headers = { '${CLIENT_HEADER}': '${CLIENT_HEADER_VALUE}' };
      const candidateSelector = document.getElementById('candidate-selector');
      const candidateCanvas = document.getElementById('candidate-profile-canvas');
      const candidateStatus = document.getElementById('candidate-profile-status');
      const candidateMeta = document.getElementById('candidate-profile-meta');
      const semanticRewriteButton = document.getElementById('btn-semantic-rewrite');
      const semanticRewriteStatus = document.getElementById('semantic-rewrite-status');
      const approvedResumeField = document.getElementById('approved-normalized-resume');
      const sanitizeFinalizeButton = document.getElementById('btn-sanitize-finalize');
      const secondPassStatus = document.getElementById('second-pass-status');
      const sanitizedResumePreview = document.getElementById('sanitized-resume-preview');
      const candidateDeliveryStatus = document.getElementById('candidate-delivery-status');
      const candidateDeliveryPreview = document.getElementById('candidate-delivery-preview');
      const copyCandidateDeliveryButton = document.getElementById('btn-copy-candidate-delivery');
      const manualIntake = document.getElementById('manual-intake-form');
      const manualIntakeContainer = document.getElementById('manual-intake-container');
      const manualIntakeStatus = document.getElementById('manual-intake-status');
      const hydrateCandidateProfile = async (candidateId) => {
        if (!candidateId) {
          candidateCanvas.value = '';
          candidateMeta.textContent = 'Select a staged candidate to hydrate the profile.';
          return;
        }
        candidateSelector.disabled = true;
        candidateStatus.textContent = 'Loading profile...';
        try {
          const response = await fetch('/api/headhunter/candidates/' + encodeURIComponent(candidateId) + '/profile', { headers });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || 'Candidate profile request failed (' + response.status + ')');
          candidateCanvas.value = data.profile;
          semanticRewriteButton.disabled = false;
          candidateMeta.textContent = 'Rank: ' + data.rank + ' | Clearance: ' + data.clearance;
          candidateStatus.textContent = 'Profile hydrated';
          candidateStatus.classList.add('headhunter-badge-ok');
        } catch (error) {
          candidateCanvas.value = '';
          semanticRewriteButton.disabled = true;
          candidateMeta.textContent = error.message;
          candidateStatus.textContent = 'Profile unavailable';
        } finally {
          candidateSelector.disabled = false;
        }
      };
      candidateSelector.addEventListener('change', () => hydrateCandidateProfile(candidateSelector.value));
      approvedResumeField.addEventListener('input', () => {
        sanitizeFinalizeButton.disabled = !candidateSelector.value || !approvedResumeField.value.trim();
      });
      semanticRewriteButton.addEventListener('click', async () => {
        const candidateId = candidateSelector.value;
        if (!candidateId) return;
        semanticRewriteButton.disabled = true;
        semanticRewriteButton.textContent = 'Ollama Computing Local Rewrite (Est: 8s)...';
        semanticRewriteStatus.textContent = 'Generating the local review copy...';
        try {
          const response = await fetch('/api/normalize-pipeline', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ candidate_id: candidateId }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || 'Semantic rewrite failed (' + response.status + ')');
          semanticRewriteStatus.textContent = 'Success: Opening Microsoft Word for Manual Review!';
          semanticRewriteStatus.classList.add('headhunter-badge-ok');
          const toast = document.createElement('div');
          toast.className = 'headhunter-toast';
          toast.setAttribute('role', 'status');
          toast.textContent = 'Success: Opening Microsoft Word for Manual Review!';
          document.body.appendChild(toast);
          window.setTimeout(() => toast.remove(), 5000);
        } catch (error) {
          semanticRewriteStatus.textContent = error.message;
        } finally {
          semanticRewriteButton.disabled = !candidateSelector.value;
          semanticRewriteButton.textContent = '⚡ Execute Semantic AI Rewrite';
        }
      });
      sanitizeFinalizeButton.addEventListener('click', async () => {
        const candidateId = candidateSelector.value;
        const approvedText = approvedResumeField.value.trim();
        if (!candidateId || !approvedText) return;
        sanitizeFinalizeButton.disabled = true;
        sanitizeFinalizeButton.textContent = 'Sanitizing & Composing Delivery...';
        secondPassStatus.textContent = 'Running sanitizer and delivery composition in parallel...';
        candidateDeliveryStatus.textContent = 'Building the copy-ready packet...';
        try {
          const requestHeaders = { ...headers, 'Content-Type': 'application/json' };
          const [sanitizeResponse, deliveryResponse] = await Promise.all([
            fetch('/api/normalize/sanitize', {
              method: 'POST', headers: requestHeaders,
              body: JSON.stringify({ edited_text: approvedText }),
            }),
            fetch('/api/candidate-delivery', {
              method: 'POST', headers: requestHeaders,
              body: JSON.stringify({ candidate_id: candidateId, approved_normalized_resume_text: approvedText }),
            }),
          ]);
          const sanitizeData = await sanitizeResponse.json().catch(() => ({}));
          const deliveryData = await deliveryResponse.json().catch(() => ({}));
          if (!sanitizeResponse.ok) throw new Error(sanitizeData.error || 'Sanitization failed (' + sanitizeResponse.status + ')');
          if (!deliveryResponse.ok) throw new Error(deliveryData.error || 'Delivery composition failed (' + deliveryResponse.status + ')');
          sanitizedResumePreview.value = sanitizeData.finalized_text || '';
          candidateDeliveryPreview.value = deliveryData.delivery_packet || '';
          candidateDeliveryStatus.textContent = 'Delivery packet ready. Review before sending.';
          secondPassStatus.textContent = 'Sanitized resume and delivery packet ready for review.';
          copyCandidateDeliveryButton.disabled = false;
        } catch (error) {
          secondPassStatus.textContent = error.message;
          candidateDeliveryStatus.textContent = 'Delivery packet unavailable.';
        } finally {
          sanitizeFinalizeButton.disabled = !candidateSelector.value || !approvedResumeField.value.trim();
          sanitizeFinalizeButton.textContent = 'Sanitize & Finalize Document';
        }
      });
      copyCandidateDeliveryButton.addEventListener('click', async () => {
        await navigator.clipboard.writeText(candidateDeliveryPreview.value);
        candidateDeliveryStatus.textContent = 'Candidate delivery email copied to clipboard.';
      });
      const loadCandidates = async () => {
        const response = await fetch('/api/headhunter/candidates', { headers });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Candidate list request failed (' + response.status + ')');
        candidateSelector.innerHTML = '<option value="">Select a candidate</option>';
        data.candidates.forEach((candidate) => {
          const option = document.createElement('option');
          option.value = candidate.candidate_id;
          option.textContent = [candidate.first_name, candidate.last_name].filter(Boolean).join(' ') || candidate.candidate_id;
          candidateSelector.appendChild(option);
        });
        candidateSelector.disabled = data.candidates.length === 0;
        candidateStatus.textContent = data.candidates.length ? 'Staged candidates live' : 'No staged candidates';
      };
      manualIntake.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = manualIntake.querySelector('button[type="submit"]');
        button.disabled = true;
        manualIntakeStatus.textContent = 'Saving candidate...';
        try {
          const response = await fetch('/api/intake-manual', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.fromEntries(new FormData(manualIntake))),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || 'Candidate intake failed (' + response.status + ')');
          manualIntake.reset();
          manualIntakeContainer.open = false;
          await loadCandidates();
          candidateSelector.value = data.candidate.candidate_id;
          await hydrateCandidateProfile(data.candidate.candidate_id);
          manualIntakeStatus.textContent = 'Profile hydrated';
        } catch (error) {
          manualIntakeStatus.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });
      const responderForm = document.getElementById('semantic-responder-form');
      const responderSubject = document.getElementById('semantic-responder-subject');
      const responderBody = document.getElementById('semantic-responder-body');
      const responderCopy = document.getElementById('semantic-responder-copy');
      const responderStatus = document.getElementById('semantic-responder-status');
      responderForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        responderStatus.textContent = 'Generating local response...';
        try {
          const response = await fetch('/api/headhunter/semantic-autoresponder', {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.fromEntries(new FormData(responderForm))),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || 'Responder generation failed (' + response.status + ')');
          responderSubject.value = data.responder.subject;
          responderBody.value = data.responder.body;
          responderCopy.disabled = false;
          responderStatus.textContent = data.responder.launch_offer + ' draft ready. Review before sending.';
        } catch (error) {
          responderStatus.textContent = error.message;
        }
      });
      responderCopy.addEventListener('click', async () => {
        await navigator.clipboard.writeText('Subject: ' + responderSubject.value + (String.fromCharCode(10) + String.fromCharCode(10)) + responderBody.value);
        responderStatus.textContent = 'Email copied to clipboard.';
      });

      const receiptForm = document.getElementById('payment-receipt-form');
      const receiptCandidateId = document.getElementById('receipt-candidate-id');
      const receiptCandidateType = document.getElementById('receipt-candidate-type');
      const receiptFirstName = document.getElementById('receipt-first-name');
      const receiptRef = document.getElementById('payment-receipt-ref');
      const receiptSubject = document.getElementById('payment-receipt-subject');
      const receiptBody = document.getElementById('payment-receipt-body');
      const receiptCopy = document.getElementById('payment-receipt-copy');
      const receiptStatus = document.getElementById('payment-receipt-status');

      receiptForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        receiptStatus.textContent = 'Generating payment receipt...';
        try {
          const response = await fetch('/api/headhunter/receipt', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              candidate_id: receiptCandidateId.value.trim(),
              candidate_type: receiptCandidateType.value,
              first_name: receiptFirstName.value.trim(),
            }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || 'Receipt generation failed (' + response.status + ')');
          receiptRef.value = data.order_reference;
          receiptSubject.value = data.subject;
          receiptBody.value = data.body;
          receiptCopy.disabled = false;
          receiptStatus.textContent = 'Receipt generated for ' + data.order_reference + '. Ready to copy.';
        } catch (error) {
          receiptStatus.textContent = error.message;
        }
      });

      receiptCopy.addEventListener('click', async () => {
        const fullPayload = 'Subject: ' + receiptSubject.value + (String.fromCharCode(10) + String.fromCharCode(10)) + receiptBody.value;
        await navigator.clipboard.writeText(fullPayload);
        receiptStatus.textContent = 'Payment receipt copied to clipboard for Outlook.';
      });

      loadCandidates().catch((error) => {
        candidateStatus.textContent = error.message;
      });
      const leadForm = document.getElementById('lead-intake-form');
      const leadScoutButton = document.getElementById('btn-scout-lead');
      const leadStatus = document.getElementById('lead-intake-status');
      let scoutedUrl = null;
      const leadQuery = new URLSearchParams(window.location.search);
      const leadQueryValues = {
        company_name: leadQuery.get('company_name') || '',
        job_title: leadQuery.get('job_title') || '',
        location: leadQuery.get('location') || '',
        target_job_id: leadQuery.get('target_job_id') || '',
      };
      const leadDomains = {
        'lockheed martin': 'lmco.com',
        'general dynamics information technology': 'gdit.com',
        gdit: 'gdit.com',
        boeing: 'boeing.com',
        google: 'google.com',
        microsoft: 'microsoft.com',
        amazon: 'amazon.com',
        verizon: 'verizon.com',
      };
      leadQueryValues.company_domain = leadDomains[leadQueryValues.company_name.toLowerCase()] || '';
      Object.entries(leadQueryValues).forEach(([name, value]) => {
        if (value && leadForm.elements[name]) leadForm.elements[name].value = value;
      });
      if (leadQueryValues.company_name && leadQueryValues.job_title) {
        leadStatus.textContent = 'Matched opportunity loaded. Scout Lead is ready.';
      }
      const leadValue = (name) => leadForm?.elements[name]?.value.trim() || '';
      const refreshPlacementsTable = async () => {
        const response = await fetch('/api/headhunter/ledger', { headers });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Placement ledger refresh failed (' + response.status + ')');
        const body = document.getElementById('live-placements-body');
        const count = document.getElementById('live-placements-count');
        if (!body || !count) return;
        const deals = data.ledger.active_deals || [];
        count.textContent = deals.length + ' active';
        body.replaceChildren();
        if (!deals.length) {
          const row = document.createElement('tr');
          const cell = document.createElement('td');
          cell.colSpan = 5;
          cell.className = 'qa-empty';
          cell.textContent = 'No active deals.';
          row.appendChild(cell);
          body.appendChild(row);
          return;
        }
        deals.forEach((deal) => {
          const row = document.createElement('tr');
          const stage = deal.current_pipeline_stage === 'Pitch Prepared' ? 'Pitched' : (deal.current_pipeline_stage || 'Staged');
          [
            deal.candidate_email || deal.candidate_id || 'Unassigned',
            deal.company_name || 'Pending company',
            deal.recruiter_name || 'Pending recruiter',
            stage,
            Number(deal.projected_contingency_fee || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
          ].forEach((value) => {
            const cell = document.createElement('td');
            cell.textContent = value;
            row.appendChild(cell);
          });
          const actionCell = document.createElement('td');
          const unblindBtn = document.createElement('button');
          unblindBtn.type = 'button';
          unblindBtn.className = 'headhunter-button headhunter-button-secondary btn-unblind-dossier';
          unblindBtn.textContent = '📁 Un-Blind & Copy Corporate Dossier';
          unblindBtn.dataset.dealId = deal.deal_id || '';
          unblindBtn.dataset.candidateId = deal.candidate_id || '';
          unblindBtn.addEventListener('click', async () => {
            unblindBtn.disabled = true;
            unblindBtn.textContent = 'Un-blinding...';
            try {
              const unblindRes = await fetch('/api/unblind-dossier', {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ candidate_id: deal.candidate_id, deal_id: deal.deal_id }),
              });
              const unblindData = await unblindRes.json().catch(() => ({}));
              if (!unblindRes.ok) throw new Error(unblindData.error || 'Un-blind failed (' + unblindRes.status + ')');
              await navigator.clipboard.writeText(unblindData.unblinded_dossier);
              unblindBtn.textContent = '✓ Un-Blinded Dossier Copied!';
              await refreshPlacementsTable();
            } catch (err) {
              alert(err.message);
              unblindBtn.disabled = false;
              unblindBtn.textContent = '📁 Un-Blind & Copy Corporate Dossier';
            }
          });
          actionCell.appendChild(unblindBtn);
          row.appendChild(actionCell);
          body.appendChild(row);
        });
      };
      leadScoutButton?.addEventListener('click', async () => {
        leadScoutButton.disabled = true;
        leadStatus.textContent = 'Reading recruiter search in the background...';
        try {
          const response = await fetch('/api/headhunter/scout-lead', {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              company_name: leadValue('company_name'),
              job_title: leadValue('job_title'),
              location: leadValue('location'),
            }),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Background recruiter scouting failed.');
          scoutedUrl = data.source_url;
          leadForm.elements.recruiter_name.value = data.selected.name;
          leadForm.elements.recruiter_title.value = data.selected.title;
          leadForm.elements.recruiter_email.value = data.selected.email || '';
          leadStatus.textContent = 'Recruiter selected: ' + data.selected.name + '. Review the hydrated lead, then save it.';
        } catch (error) {
          leadStatus.textContent = error.message;
        } finally {
          leadScoutButton.disabled = false;
        }
      });
      leadForm?.addEventListener('submit', async (event) => {
        event.preventDefault();
        leadStatus.textContent = 'Saving lead...';
        try {
          const response = await fetch('/api/headhunter/manual-lead', {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              company_name: leadValue('company_name'),
              company_domain: leadValue('company_domain'),
              job_title: leadValue('job_title'),
              location: leadValue('location'),
              recruiter_name: leadValue('recruiter_name'),
              recruiter_title: leadValue('recruiter_title'),
              recruiter_email: leadValue('recruiter_email'),
              target_job_id: leadValue('target_job_id'),
              scouting_url: scoutedUrl,
            }),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Lead save failed.');
          const pattern = data.lead.email_pattern || 'pending_manual_input';
          await refreshPlacementsTable();
          leadStatus.textContent = 'Lead saved. Email handling: ' + pattern;
        } catch (error) {
          leadStatus.textContent = error.message;
        }
      });
      const button = document.getElementById('btn-sync-pipeline');
      const leidosButton = document.getElementById('btn-leidos-manual');
      const stopButton = document.getElementById('btn-stop-pipeline');
      const badge = document.getElementById('hh-index-badge');
      const box = document.getElementById('pipeline-output');
      const stream = document.getElementById('console-stream');
      const statusText = document.getElementById('pipeline-status');
      const progress = document.getElementById('pipeline-progress');
      const progressValue = document.getElementById('pipeline-progress-value');
      const progressStage = document.getElementById('pipeline-progress-stage');
      const progressSite = document.getElementById('pipeline-progress-site');
      const weeklySyncStatus = document.getElementById('weekly-sync-status');
      const weeklySyncLastRun = document.getElementById('weekly-sync-last-run');
      let polling = null;

      const updateProgress = (log, jobStatus) => {
        const text = log || '';
        const stages = [
          { marker: 'Stage 4:', value: 75, label: 'Stage 4: Persistent Qdrant Vector DB Indexing' },
          { marker: 'Stage 3:', value: 50, label: 'Stage 3: Headless LLM Schema Structuring' },
          { marker: 'Stage 2:', value: 25, label: 'Stage 2: Link Hygiene & Expiry Filters' },
          { marker: 'Stage 1:', value: 5, label: 'Stage 1: Web Ingestion Scraper Loop' },
        ];
        let value = 0;
        let label = 'Idle';
        const siteMatches = [...text.matchAll(/SCRAPER (?:START|PAGE|DONE|ERROR|LIMIT)\] ([^\s]+)(?: page=\d+ offset=\d+)?/g)];
        const site = siteMatches.length ? siteMatches[siteMatches.length - 1][1] : '';
        if (text.includes('PREFLIGHT')) { value = 5; label = 'Preflight checks'; }
        for (const stage of stages) {
          if (text.includes(stage.marker)) { value = stage.value; label = stage.label; break; }
        }
        if (text.includes('PLATFORM SYNCED') || jobStatus === 'completed') { value = 100; label = 'Complete'; }
        if (jobStatus === 'cancelled') label = 'Cancelled';
        if (jobStatus === 'failed') label = 'Failed';
        progress.value = value;
        progressValue.textContent = value + '%';
        progressStage.textContent = label;
        progressSite.textContent = 'Site: ' + (site || 'None');
      };

      const showLog = (text) => {
        box.hidden = false;
        stream.textContent = text || 'Waiting for output...';
        stream.scrollTop = stream.scrollHeight;
      };
      const setBusy = (busy) => {
        button.disabled = busy;
        leidosButton.disabled = busy;
        button.textContent = busy ? 'Pipeline running...' : 'Sync Live Opportunities';
        stopButton.disabled = !busy;
      };
      const refreshStatus = async () => {
        try {
          const response = await fetch('/api/headhunter/status', { headers });
          if (!response.ok) throw new Error();
          const status = await response.json();
          const activeStatus = status.job.running
            ? (status.job.status === 'cancelling' ? 'Stopping' : 'Running')
            : status.job.status === 'completed' ? 'Complete' : status.job.status === 'failed' ? 'Failed' : status.job.status === 'cancelled' ? 'Cancelled' : status.indexReady ? 'Ready' : 'Not synced';
          weeklySyncStatus.textContent = activeStatus;
          weeklySyncLastRun.textContent = status.indexUpdatedAt ? new Date(status.indexUpdatedAt).toLocaleString() : 'Never recorded';
          badge.textContent = status.job.running
            ? (status.job.status === 'cancelling' ? 'Stopping run...' : status.job.kind === 'sync' ? 'Sync running' : status.job.kind === 'leidos' ? 'Leidos running' : 'Match running')
            : status.indexReady ? 'Index live' : 'No index yet';
          badge.classList.toggle('headhunter-badge-ok', status.indexReady && !status.job.running);
          if ((status.job.kind === 'sync' || status.job.kind === 'leidos') && status.job.log) showLog(status.job.log);
          updateProgress(status.job.log, status.job.status);
          statusText.textContent = status.job.running ? (status.job.status === 'cancelling' ? 'Stop requested. Waiting for the pipeline to exit...' : 'A pipeline run is active.') : status.job.status === 'cancelled' ? 'The last pipeline run was cancelled.' : 'No active run.';
          setBusy(status.job.running);
          if (!status.job.running && polling) { clearInterval(polling); polling = null; }
          if (status.job.running && status.job.kind === 'sync' && !polling) polling = setInterval(refreshStatus, 2000);
        } catch (_) {
          badge.textContent = 'Controls unavailable';
          button.disabled = true;
        }
      };

      button.addEventListener('click', async () => {
        setBusy(true);
        statusText.textContent = 'A pipeline run is active.';
        showLog('Starting pipeline...\\n');
        stream.textContent = '';
        updateProgress('Starting pipeline...', 'running');
        if (!polling) polling = setInterval(refreshStatus, 1000);
        refreshStatus();
        try {
          const response = await fetch('/api/headhunter/sync', { method: 'POST', headers });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || 'Sync request failed (' + response.status + ')');
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            stream.textContent += decoder.decode(value, { stream: true });
            updateProgress(stream.textContent, 'running');
            stream.scrollTop = stream.scrollHeight;
          }
        } catch (error) {
          stream.textContent += '\\n' + error.message;
        } finally {
          refreshStatus();
        }
      });

      leidosButton.addEventListener('click', async () => {
        if (!window.confirm('Open the Leidos headed run? Clear the bot verification in Chrome, then the complete source will be merged automatically.')) return;
        setBusy(true);
        statusText.textContent = 'Leidos browser run started. Clear the bot verification in Chrome if prompted.';
          showLog('Starting Leidos manual run...\\n');
        stream.textContent = '';
        updateProgress('Starting Leidos manual run...', 'running');
        if (!polling) polling = setInterval(refreshStatus, 1000);
        try {
          const response = await fetch('/api/headhunter/leidos', { method: 'POST', headers });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || 'Leidos request failed (' + response.status + ')');
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            stream.textContent += decoder.decode(value, { stream: true });
            updateProgress(stream.textContent, 'running');
            stream.scrollTop = stream.scrollHeight;
          }
        } catch (error) {
            stream.textContent += '\\n' + error.message;
        } finally {
          refreshStatus();
        }
      });

      stopButton.addEventListener('click', async () => {
        if (!window.confirm('Stop the active pipeline run? The current child process tree will be terminated.')) return;
        stopButton.disabled = true;
        statusText.textContent = 'Requesting stop...';
        try {
          const response = await fetch('/api/headhunter/stop', { method: 'POST', headers });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || 'Stop request failed (' + response.status + ')');
          await refreshStatus();
        } catch (error) {
          statusText.textContent = error.message;
          await refreshStatus();
        }
      });
      refreshStatus();

      const qaButton = document.getElementById('btn-qa-refresh');
      const qaBody = document.getElementById('qa-table-body');
      const qaSummary = document.getElementById('qa-summary');
      const qaSearch = document.getElementById('qa-search');
      let qaRows = [];
      let qaBaseSummary = '';
      const applyQaFilter = () => {
        const terms = qaSearch.value.toLowerCase().split(/\s+/).filter(Boolean);
        let shown = 0;
        for (const row of qaRows) {
          const match = terms.every((t) => row.text.includes(t));
          row.tr.hidden = !match;
          shown += match;
        }
        qaSummary.textContent = terms.length ? qaBaseSummary + ' Filter matches ' + shown + '.' : qaBaseSummary;
      };
      qaSearch.addEventListener('input', applyQaFilter);
      const cell = (text, flagged) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (flagged) td.classList.add('qa-flag');
        return td;
      };
      const message = (text) => {
        const td = cell(text);
        td.colSpan = 5;
        td.className = 'qa-empty';
        const tr = document.createElement('tr');
        tr.append(td);
        qaBody.replaceChildren(tr);
        qaRows = [];
        qaSearch.disabled = true;
      };
      // Scraped text is untrusted, so rows are built with textContent, never innerHTML.
      window.loadIndexedOpportunities = async () => {
        qaButton.disabled = true;
        qaButton.textContent = 'Loading...';
        try {
          const response = await fetch('/api/headhunter/inspect-db', { headers });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || 'Inspector failed (' + response.status + ')');
          const records = data.records || [];
          if (!records.length) {
            message(data.error || 'The index is empty.');
            qaSummary.textContent = data.error || '0 records.';
            return;
          }
          const unknown = (v) => !v || v === 'Unknown';
          const counts = { clearance: 0, location: 0, skills: 0, company: 0 };
          qaRows = records.map((r) => {
            const skills = Array.isArray(r.core_technical_skills) ? r.core_technical_skills : [];
            counts.clearance += unknown(r.security_clearance_required);
            counts.location += unknown(r.location);
            counts.skills += !skills.length;
            counts.company += unknown(r.company_name);
            const values = [r.company_name || 'Unknown', r.job_title || 'Unknown', r.location || 'Unknown',
              r.security_clearance_required || 'Unknown', skills.join(', ') || 'none'];
            const tr = document.createElement('tr');
            tr.append(
              cell(values[0], unknown(r.company_name)),
              cell(values[1], unknown(r.job_title)),
              cell(values[2], unknown(r.location)),
              cell(values[3], unknown(r.security_clearance_required)),
              cell(values[4], !skills.length),
            );
            return { tr, text: values.join(' ').toLowerCase() };
          });
          qaBody.replaceChildren(...qaRows.map((row) => row.tr));
          qaBaseSummary = 'Showing ' + records.length + ' of ' + data.total + ' records. Missing: clearance '
            + counts.clearance + ', location ' + counts.location + ', skills ' + counts.skills + ', company ' + counts.company + '.';
          qaSearch.disabled = false;
          applyQaFilter();
        } catch (error) {
          message(error.message);
          qaSummary.textContent = error.message;
        } finally {
          qaButton.disabled = false;
          qaButton.textContent = 'Refresh Live Data';
        }
      };
      qaButton.addEventListener('click', window.loadIndexedOpportunities);
    })();
  </script>
`;

module.exports = { registerHeadhunterRoutes, headhunterPanelHtml, STRIPE_LINKS };
