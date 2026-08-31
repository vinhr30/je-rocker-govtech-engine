const { allAsync, runAsync } = require('../lib/db');

const UPSERT_TOPIC = `
  INSERT INTO grant_topics (
    raw_id, source_id, external_id, program, phase,
    topic_number, topic_title, topic_description, extracted_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(raw_id, topic_number) DO UPDATE SET
    program = excluded.program,
    phase = excluded.phase,
    topic_title = excluded.topic_title,
    topic_description = excluded.topic_description,
    extracted_at = excluded.extracted_at
`;

const TOPIC_CONTAINERS = ['solicitation_topics', 'topics', 'topic_list'];

function pick(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (value !== null && value !== undefined && value !== '') return String(value);
  }
  return null;
}

function findTopics(record) {
  for (const key of TOPIC_CONTAINERS) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [];
}

/** SBIR and STTR share a solicitation envelope, so program is inferred per topic. */
function resolveProgram(topic, record) {
  const explicit = pick(topic, ['program']) || pick(record, ['program']);
  if (explicit) return explicit.toUpperCase().includes('STTR') ? 'STTR' : 'SBIR';
  const haystack = `${pick(topic, ['topic_title']) || ''} ${pick(topic, ['topic_number']) || ''}`;
  return haystack.toUpperCase().includes('STTR') ? 'STTR' : 'SBIR';
}

function extractTopics(row) {
  const record = JSON.parse(row.raw_json);
  return findTopics(record)
    .map((topic, index) => {
      const topicNumber = pick(topic, ['topic_number', 'topic_code', 'number']) || `${row.external_id}-${index + 1}`;
      return {
        rawId: row.id,
        sourceId: row.source_id,
        externalId: row.external_id,
        program: resolveProgram(topic, record),
        phase: pick(topic, ['sbir_phase', 'phase']) || pick(record, ['phase']),
        topicNumber,
        topicTitle: pick(topic, ['topic_title', 'title']),
        topicDescription: pick(topic, ['topic_description', 'description']),
      };
    })
    .filter((topic) => topic.topicTitle || topic.topicDescription);
}

/**
 * Extracts SBIR/STTR topics from raw solicitations into grant_topics.
 * Only sources in the `sbir` category carry topic structures.
 */
async function runTopicExtraction(db, { sourceId, now = () => new Date().toISOString() } = {}) {
  const params = ['sbir'];
  let sql = "SELECT * FROM grants_raw WHERE category = ?";
  if (sourceId) {
    sql += ' AND source_id = ?';
    params.push(sourceId);
  }
  const rows = await allAsync(db, `${sql} ORDER BY id ASC`, params);

  const extractedAt = now();
  const failures = [];
  let written = 0;

  for (const row of rows) {
    try {
      for (const topic of extractTopics(row)) {
        await runAsync(db, UPSERT_TOPIC, [
          topic.rawId, topic.sourceId, topic.externalId, topic.program, topic.phase,
          topic.topicNumber, topic.topicTitle, topic.topicDescription, extractedAt,
        ]);
        written += 1;
      }
    } catch (error) {
      failures.push({ rawId: row.id, sourceId: row.source_id, error: error.message });
    }
  }

  return { solicitations: rows.length, written, failures };
}

module.exports = {
  extractTopics,
  runTopicExtraction,
};
