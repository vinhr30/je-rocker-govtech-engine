const fs = require('fs');
const path = require('path');

const GOVTECH_CLIENTS_PATH = path.join(__dirname, '../../data/govtech_clients.json');
const GOVTECH_PROPOSALS_PATH = path.join(__dirname, '../../data/govtech_proposals.json');

function getGovtechClients() {
  if (!fs.existsSync(GOVTECH_CLIENTS_PATH)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(GOVTECH_CLIENTS_PATH, 'utf8'));
    return Array.isArray(data.clients) ? data.clients : [];
  } catch (e) {
    return [];
  }
}

function getGovtechProposals() {
  if (!fs.existsSync(GOVTECH_PROPOSALS_PATH)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(GOVTECH_PROPOSALS_PATH, 'utf8'));
    return Array.isArray(data.proposals) ? data.proposals : [];
  } catch (e) {
    return [];
  }
}

function renderGovtechDashboard(req, res) {
  const clients = getGovtechClients();
  const proposals = getGovtechProposals();

  const activePayments = clients.filter(c => c.onboarding_status === 'active').length;
  const totalProposals = proposals.length;
  const avgReadiness = clients.length
    ? Math.round(clients.reduce((acc, c) => acc + (c.readiness_score || 85), 0) / clients.length)
    : 85;

  const summary = {
    total_clients: clients.length,
    active_payments: activePayments,
    avg_readiness: avgReadiness,
    total_proposals: totalProposals
  };

  // Add calculated proposal counts & next action to each client
  const enrichedClients = clients.map(client => {
    const clientProps = proposals.filter(p => p.client_id === client.client_id);
    return {
      ...client,
      proposal_count: clientProps.length,
      next_action: client.onboarding_status === 'active'
        ? 'Compile Match Report & Proposal Targets'
        : 'Awaiting Stripe Payment Clearance'
    };
  });

  res.render('govtech-dashboard', {
    clients: enrichedClients,
    summary,
    title: 'GovTech Operations Dashboard | Business 1'
  });
}

module.exports = {
  renderGovtechDashboard,
  getGovtechClients,
  getGovtechProposals
};
