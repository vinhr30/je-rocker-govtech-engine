import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import ClientDashboardPage from './pages/ClientDashboardPage';
import WorkPage from './pages/WorkPage/WorkPage';
import ClientIntakePage from './pages/ClientIntake/ClientIntakePage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/work" element={<WorkPage />} />
        <Route path="/client-intake" element={<ClientIntakePage />} />
        <Route path="/client-dashboard" element={<ClientDashboardPage />} />
        <Route path="*" element={<Navigate to="/client-dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
