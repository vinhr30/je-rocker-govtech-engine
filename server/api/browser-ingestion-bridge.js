const { chromium } = require('playwright');

const COMPANY_DOMAINS = {
  'general dynamics information technology': 'gdit.com',
  gdit: 'gdit.com',
  boeing: 'boeing.com',
  'the boeing company': 'boeing.com',
  'lockheed martin': 'lmco.com',
  'lockheed martin corporation': 'lmco.com',
  google: 'google.com',
  microsoft: 'microsoft.com',
  amazon: 'amazon.com',
  verizon: 'verizon.com',
};

const RECRUITER_TERMS = /recruiter|recruiting|talent acquisition|sourcing|sourcer|hiring manager|people operations/i;
const LINKEDIN_RESULT_PATTERN = /linkedin\.com\/in/i;

function companyDomain(companyName) {
  const normalized = String(companyName || '').trim().toLowerCase();
  return COMPANY_DOMAINS[normalized] || null;
}

function candidateNameFromHeading(heading) {
  const name = String(heading || '').split(/\s+-\s+/)[0].trim();
  if (!name || name.length > 100 || /linkedin|search results|profiles|skip to|main content/i.test(name)) return null;
  if (!/^[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*)+$/.test(name)) return null;
  return name;
}

function profileFromResult(text, jobTitle, domain) {
  const lines = String(text || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const recruiterLine = lines.find((line) => RECRUITER_TERMS.test(line) && /\s+-\s+/.test(line));
  const heading = recruiterLine || lines.find((line) => LINKEDIN_RESULT_PATTERN.test(line)) || lines[0] || '';
  const name = candidateNameFromHeading(heading.replace(/\s*LinkedIn\s*$/i, ''));
  if (!name) return null;
  const context = lines.join(' ').slice(0, 3000);
  const title = lines.find((line) => RECRUITER_TERMS.test(line) && !/^linkedin$/i.test(line))
    || 'Talent Acquisition / Recruiting';
  return {
    name,
    title: title.slice(0, 180),
    company_domain: domain,
    context: `${context} Matched role: ${jobTitle}`,
  };
}

async function scoutRecruiterProfiles({ url, companyName, jobTitle }) {
  const cdpUrl = process.env.CHROME_CDP_URL || 'http://127.0.0.1:9222';
  let browser;
  let ownsBrowser = false;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch {
    browser = await chromium.launch({ headless: true });
    ownsBrowser = true;
  }
  try {
    const context = browser.contexts()[0] || await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36',
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1200);
    const bodyText = await page.locator('body').innerText();
    if (/unusual traffic|complete the following|bots use|not a robot/i.test(bodyText)) {
      throw new Error('The search provider blocked the background browser. Start Chrome with CDP on port 9222 or review the recruiter search manually.');
    }
    const resultTexts = await page.locator('div.MjjYud').evaluateAll((nodes) => nodes
      .filter((node) => node.querySelector('a[href*="linkedin.com/in/"]'))
      .map((node) => node.innerText));
    const fallbackText = resultTexts.length ? '' : bodyText;
    const blocks = resultTexts.length ? resultTexts : fallbackText.split(/\n\s*\n/);
    const domain = companyDomain(companyName);
    const profiles = blocks
      .map((block) => profileFromResult(block, jobTitle, domain))
      .filter(Boolean)
      .filter((profile, index, all) => all.findIndex((item) => item.name.toLowerCase() === profile.name.toLowerCase()) === index);
    return { profiles, result_count: blocks.length };
  } finally {
    if (ownsBrowser) await browser.close();
  }
}

module.exports = { scoutRecruiterProfiles, companyDomain, profileFromResult };
