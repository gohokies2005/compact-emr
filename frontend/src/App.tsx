import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { SignInScreen } from './auth/SignInScreen';
import { DownloadPortalPage } from './routes/DownloadPortalPage';
import { HomePage } from './routes/HomePage';
import { NoAccessPage } from './routes/NoAccessPage';
import { NotFoundPage } from './routes/NotFoundPage';
import { VeteransPage } from './routes/veterans/VeteransPage';
import { VeteranChart } from './routes/veterans/VeteranChart';
import { CasesPage } from './routes/cases/CasesPage';
import { CaseDetailPage } from './routes/cases/CaseDetailPage';
import { LetterEditorPage } from './routes/cases/LetterEditorPage';
import { TemplatesPage } from './routes/stubs/TemplatesPage';
import { PhysiciansPage } from './routes/admin/PhysiciansPage';
import { StaffPage } from './routes/admin/StaffPage';
import { MailboxesPage } from './routes/admin/MailboxesPage';
import { ActivityPage } from './routes/stubs/ActivityPage';
import { RefundsPage } from './routes/stubs/RefundsPage';
import { CompensationPage } from './routes/stubs/CompensationPage';
import { MetricsPage } from './routes/stubs/MetricsPage';
import { CostsPage } from './routes/CostsPage';
import { PhysicianQueuePage } from './routes/physician/PhysicianQueuePage';
import { PhysicianReviewPage } from './routes/physician/PhysicianReviewPage';
import { PhysicianMobileQueuePage } from './routes/physician/PhysicianMobileQueuePage';
import { PhysicianMobileReviewPage } from './routes/physician/PhysicianMobileReviewPage';
import { PhysicianLettersPage } from './routes/physician/PhysicianLettersPage';
import { PhysicianPayPage } from './routes/physician/PhysicianPayPage';
import { RnQueuePage } from './routes/rn/RnQueuePage';
import { IntakePoolPage } from './routes/intake/IntakePoolPage';
import { InboxPage } from './routes/inbox/InboxPage';

const queryClient = new QueryClient();

export function App() {
  return <QueryClientProvider client={queryClient}><BrowserRouter><AuthProvider><Routes>
    <Route path="/signin" element={<SignInScreen />} />
    <Route path="/d/:token" element={<DownloadPortalPage />} />
    <Route path="/" element={<ProtectedRoute requiredRole={['admin', 'ops_staff', 'physician']}><HomePage /></ProtectedRoute>} />
    <Route path="/veterans" element={<ProtectedRoute requiredRole={['admin', 'ops_staff']}><VeteransPage /></ProtectedRoute>} />
    <Route path="/veterans/:id" element={<ProtectedRoute requiredRole={['admin', 'ops_staff']}><VeteranChart /></ProtectedRoute>} />
    <Route path="/cases" element={<ProtectedRoute requiredRole={['admin', 'ops_staff']}><CasesPage /></ProtectedRoute>} />
    <Route path="/cases/:id" element={<ProtectedRoute requiredRole={['admin', 'ops_staff']}><CaseDetailPage /></ProtectedRoute>} />
    <Route path="/cases/:id/letter" element={<ProtectedRoute requiredRole={['admin', 'ops_staff', 'physician']}><LetterEditorPage /></ProtectedRoute>} />
    <Route path="/templates" element={<ProtectedRoute requiredRole={['admin']}><TemplatesPage /></ProtectedRoute>} />
    <Route path="/physicians" element={<ProtectedRoute requiredRole={['admin']}><PhysiciansPage /></ProtectedRoute>} />
    <Route path="/staff" element={<ProtectedRoute requiredRole={['admin']}><StaffPage /></ProtectedRoute>} />
    <Route path="/email-settings" element={<ProtectedRoute requiredRole={['admin']}><MailboxesPage /></ProtectedRoute>} />
    <Route path="/activity" element={<ProtectedRoute requiredRole={['admin']}><ActivityPage /></ProtectedRoute>} />
    {/* Refunds left the staff nav (UI sweep P2c) — admin-only by direct URL now; the per-case
        refund banner on CaseDetailPage is how ops staff see the refund signal. */}
    <Route path="/refunds" element={<ProtectedRoute requiredRole={['admin']}><RefundsPage /></ProtectedRoute>} />
    <Route path="/compensation" element={<ProtectedRoute requiredRole={['admin']}><CompensationPage /></ProtectedRoute>} />
    <Route path="/metrics" element={<ProtectedRoute requiredRole={['admin']}><MetricsPage /></ProtectedRoute>} />
    <Route path="/costs" element={<ProtectedRoute requiredRole={['admin']}><CostsPage /></ProtectedRoute>} />
    <Route path="/p/queue" element={<ProtectedRoute requiredRole={['physician', 'admin']}><PhysicianQueuePage /></ProtectedRoute>} />
    <Route path="/p/review/:caseId" element={<ProtectedRoute requiredRole={['physician', 'admin']}><PhysicianReviewPage /></ProtectedRoute>} />
    {/* Physician MOBILE review/approve flow (foundation slice #80, Dr. Kasky 2026-06-25): a focused,
        mobile-first queue → SOAP → abridged docs → letter → Approve/Save-for-computer/Send-back. Same
        role gate + data as the desktop /p/* pages; read-only (no mobile editing). */}
    <Route path="/p/m/queue" element={<ProtectedRoute requiredRole={['physician', 'admin']}><PhysicianMobileQueuePage /></ProtectedRoute>} />
    <Route path="/p/m/review/:caseId" element={<ProtectedRoute requiredRole={['physician', 'admin']}><PhysicianMobileReviewPage /></ProtectedRoute>} />
    <Route path="/p/letters" element={<ProtectedRoute requiredRole={['physician', 'admin']}><PhysicianLettersPage /></ProtectedRoute>} />
    <Route path="/p/pay" element={<ProtectedRoute requiredRole={['physician', 'admin']}><PhysicianPayPage /></ProtectedRoute>} />
    <Route path="/rn" element={<ProtectedRoute requiredRole={['admin', 'ops_staff']}><RnQueuePage /></ProtectedRoute>} />
    <Route path="/intake" element={<ProtectedRoute requiredRole={['admin', 'ops_staff']}><IntakePoolPage /></ProtectedRoute>} />
    <Route path="/inbox" element={<ProtectedRoute requiredRole={['admin', 'ops_staff', 'physician']}><InboxPage /></ProtectedRoute>} />
    <Route path="/403" element={<ProtectedRoute requiredRole={['admin', 'ops_staff', 'physician']}><NoAccessPage /></ProtectedRoute>} />
    <Route path="/not-found" element={<ProtectedRoute requiredRole={['admin', 'ops_staff', 'physician']}><NotFoundPage /></ProtectedRoute>} />
    <Route path="*" element={<ProtectedRoute requiredRole={['admin', 'ops_staff', 'physician']}><NotFoundPage /></ProtectedRoute>} />
    <Route path="/legacy" element={<Navigate to="/" replace />} />
  </Routes></AuthProvider></BrowserRouter></QueryClientProvider>;
}
