const CORPORATE_EMAIL_PATTERNS = {
  'amazon.com': ({ first, last }) => `${last}${first[0]}@amazon.com`,
  'boeing.com': ({ first, last }) => `${first}.${last}@boeing.com`,
  'gdit.com': ({ first, last }) => `${first}.${last}@gdit.com`,
  'google.com': ({ first, last }) => `${first}${last}@google.com`,
  'lmco.com': ({ first, middle, last }) => `${first}.${middle ? middle[0] + '.' : ''}${last}@lmco.com`,
  'microsoft.com': ({ first, last }) => `${first}.${last}@microsoft.com`,
  'verizon.com': ({ first, last }) => `${first}.${last}@verizon.com`,
};

const TECHNICAL_TERMS = /software|systems|network|engineer/i;
const DEFENSE_TERMS = /lockheed|boeing|gdit/i;
const TECHNICAL_RECRUITER_TERMS = /technical recruiter|engineering sourcing|infrastructure/i;
const DEFENSE_RECRUITER_TERMS = /cleared operations|defense|security|tactical/i;
const LOW_SIGNAL_TERMS = /administrative|broad management|generalist|unrelated subsidiary/i;

function normalized(value) {
  return String(value || '').trim();
}

function recruiterText(profile) {
  return [profile.name, profile.title, profile.headline, profile.summary, profile.context]
    .map(normalized)
    .join(' ');
}

function scoreProfile(jobTitle, companyName, profile) {
  const text = recruiterText(profile);
  let score = Number(profile.base_score) || 0;
  const reasons = [];
  if (TECHNICAL_TERMS.test(jobTitle) && TECHNICAL_RECRUITER_TERMS.test(text)) {
    score += 0.5;
    reasons.push('technical recruiting context');
  }
  if (DEFENSE_TERMS.test(companyName) && DEFENSE_RECRUITER_TERMS.test(text)) {
    score += 0.5;
    reasons.push('defense recruiting context');
  }
  if (LOW_SIGNAL_TERMS.test(text)) {
    score -= 0.4;
    reasons.push('low-signal or unrelated context');
  }
  return { score, reasons };
}

function emailForProfile(companyName, profile) {
  if (profile.email) return normalized(profile.email).toLowerCase();
  const domain = normalized(profile.company_domain || profile.domain).toLowerCase();
  const pattern = CORPORATE_EMAIL_PATTERNS[domain];
  if (!pattern || !profile.name) return null;
  const parts = profile.name.toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return pattern({ first: parts[0], middle: parts.length > 2 ? parts[1] : '', last: parts[parts.length - 1] });
}

function rankRecruiters({ job_title: jobTitle, company_name: companyName, scouted_profiles: profiles }) {
  const normalizedJobTitle = normalized(jobTitle);
  const normalizedCompanyName = normalized(companyName);
  if (!normalizedJobTitle || !normalizedCompanyName || !Array.isArray(profiles)) {
    const error = new Error('job_title, company_name, and scouted_profiles are required.');
    error.statusCode = 400;
    throw error;
  }
  if (!profiles.length) {
    const error = new Error('No scouted recruiter profiles were supplied; no recruiter identity was invented.');
    error.statusCode = 422;
    throw error;
  }
  const ranked = profiles
    .filter((profile) => profile && typeof profile === 'object')
    .map((profile) => ({ profile, ...scoreProfile(normalizedJobTitle, normalizedCompanyName, profile) }))
    .sort((left, right) => right.score - left.score);
  if (!ranked.length) {
    const error = new Error('No usable recruiter profiles were supplied.');
    error.statusCode = 422;
    throw error;
  }
  const selected = ranked[0];
  return {
    selected: {
      name: normalized(selected.profile.name),
      title: normalized(selected.profile.title),
      email: emailForProfile(normalizedCompanyName, selected.profile),
      company_domain: normalized(selected.profile.company_domain || selected.profile.domain).toLowerCase() || null,
      score: selected.score,
      reasons: selected.reasons,
    },
    ranked: ranked.map((entry) => ({
      name: normalized(entry.profile.name),
      title: normalized(entry.profile.title),
      score: entry.score,
      reasons: entry.reasons,
    })),
  };
}

function registerSemanticScoutRoute(app, localDashboardOnly) {
  app.post('/api/semantic-scout', localDashboardOnly, (req, res) => {
    try {
      return res.json(rankRecruiters(req.body || {}));
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });
}

module.exports = { registerSemanticScoutRoute, rankRecruiters };
