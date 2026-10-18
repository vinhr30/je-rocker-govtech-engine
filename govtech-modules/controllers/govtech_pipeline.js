const fs = require('fs');
const path = require('path');

const PIPELINE_PATH = path.join(__dirname, '../../data/govtech_pipeline.json');
const CLIENTS_PATH = path.join(__dirname, '../../data/govtech_clients.json');
const PROPOSALS_PATH = path.join(__dirname, '../../data/govtech_proposals.json');

function loadPipelineData() {
  if (fs.existsSync(PIPELINE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(PIPELINE_PATH, 'utf8'));
    } catch (e) {
      console.error(`[govtech-pipeline] Parse error: ${e.message}`);
    }
  }
  return {
    namespace: 'govtech',
    financial_summary: { total_revenue: 0, mrr: 0, active_contracts_value: 0 },
    leads: [],
    active_clients: [],
    proposal_metrics: { submitted: 0, won: 0, lost: 0, under_evaluation: 0, win_rate: '0%' }
  };
}

function renderGovtechPipeline(req, res) {
  const pipeline = loadPipelineData();

  // If live clients exist, refresh active clients count
  if (fs.existsSync(CLIENTS_PATH)) {
    try {
      const clientsData = JSON.parse(fs.readFileSync(CLIENTS_PATH, 'utf8'));
      if (clientsData && Array.isArray(clientsData.clients)) {
        // Compute MRR from active clients
        let liveMrr = 0;
        clientsData.clients.forEach(c => {
          if (c.selected_plan === 'retainer') liveMrr += 999;
          if (c.selected_plan === 'intel') liveMrr += 149;
        });
        if (liveMrr > 0) pipeline.financial_summary.mrr = liveMrr;
      }
    } catch (e) {}
  }

  res.render('govtech-pipeline', {
    pipeline,
    title: 'GovTech CRM Pipeline | Business 1'
  });
}

module.exports = {
  renderGovtechPipeline,
  loadPipelineData
};
