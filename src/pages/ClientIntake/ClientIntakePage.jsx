import React, { useState } from 'react';
import './intake.css';

export default function ClientIntakePage() {
  const [name, setName] = useState('');
  const [agency, setAgency] = useState('');
  const [notes, setNotes] = useState('');
  const [capabilitySignals, setCapabilitySignals] = useState('');
  const [targetingPreferences, setTargetingPreferences] = useState('');
  const [error, setError] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    try {
      const response = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          agency,
          notes,
          capability_signals: capabilitySignals,
          targeting_preferences: targetingPreferences,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.client?.id) {
        throw new Error(data.error || 'Failed to create client');
      }
      window.location.href = `/client-dashboard?client_id=${encodeURIComponent(String(data.client.id))}&created=1`;
    } catch (submitError) {
      setError(submitError.message || 'Failed to create client');
    }
  }

  return (
    <main className="intake-page">
      <section className="intake-card">
        <h1>Client Intake</h1>
        <p>Capture client profile details, capability signals, and targeting preferences.</p>
        <form onSubmit={handleSubmit}>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Client name" required />
          <input value={agency} onChange={(event) => setAgency(event.target.value)} placeholder="Target agency" required />
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Notes" required />
          <textarea value={capabilitySignals} onChange={(event) => setCapabilitySignals(event.target.value)} placeholder="Capability signals" required />
          <textarea value={targetingPreferences} onChange={(event) => setTargetingPreferences(event.target.value)} placeholder="Targeting preferences" required />
          <button type="submit">Create Client</button>
        </form>
        {error ? <p>{error}</p> : null}
      </section>
    </main>
  );
}
