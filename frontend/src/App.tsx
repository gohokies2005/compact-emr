import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { SignInScreen } from './auth/SignInScreen';
import { HomePage } from './routes/HomePage';
import { NoAccessPage } from './routes/NoAccessPage';
import { NotFoundPage } from './routes/NotFoundPage';
import { VeteransPage } from './routes/veterans/VeteransPage';
import { VeteranChart } from './routes/veterans/VeteranChart';
import { CasesPage } from './routes/cases/CasesPage';
import { CaseDetailPage } from './routes/cases/CaseDetailPage';
import { TemplatesPage } from './routes/stubs/TemplatesPage';
import { PhysiciansPage } from './routes/stubs/PhysiciansPage';
import { ActivityPage } from './routes/stubs/ActivityPage';
import { RefundsPage } from './routes/stubs/RefundsPage';
import { CompensationPage } from './routes/stubs/CompensationPage';
import { MetricsPage } from './routes/stubs/MetricsPage';
import { PQueuePage } from './routes/stubs/PQueuePage';
import { PReviewPage } from './routes/stubs/PReviewPage';
import { PLettersPage } from './routes/stubs/PLettersPage';

const queryClient = new QueryClient();

export function App() {
  return <QueryClientProvider client={queryClient}><BrowserRouter><AuthProvider><Routes>
    <Route path="/signin" element={<SignInScreen />} />
    <Route path="/" element={<ProtectedRoute requiredRole={['admin', 'ops_staff', 'physician']}><HomePage /></ProtectedRoute>} />
    <Route path="/veterans" element={<ProtectedRoute requiredRole={['admin', 'ops_staff']}><VeteransPage /></ProtectedRoute>} />
    <Route path="/veterans/:id" element={<ProtectedRoute requiredRole={['admin', 'ops_staff']}><VeteranChart /></ProtectedRoute>} />
    <Route path="/cases" element={<ProtectedRoute requiredRole={['admin', 'ops_staff']}><CasesPage /></ProtectedRoute>} />
    <Route path="/cases/:id" element={<ProtectedRoute requiredRole={['admin', 'ops_staff']}><CaseDetailPage /></ProtectedRoute>} />
    <Route path="/templates" element={<ProtectedRoute requiredRole={['admin']}><TemplatesPage /></ProtectedRoute>} />
    <Route path="/physicians" element={<ProtectedRoute requiredRole={['admin']}><PhysiciansPage /></ProtectedRoute>} />
    <Route path="/activity" element={<ProtectedRoute requiredRole={['admin']}><ActivityPage /></ProtectedRoute>} />
    <Route path="/refunds" element={<ProtectedRoute requiredRole={['admin', 'ops_staff']}><RefundsPage /></ProtectedRoute>} />
    <Route path="/compensation" element={<ProtectedRoute requiredRole={['admin']}><CompensationPage /></ProtectedRoute>} />
    <Route path="/metrics" element={<ProtectedRoute requiredRole={['admin']}><MetricsPage /></ProtectedRoute>} />
    <Route path="/p/queue" element={<ProtectedRoute requiredRole={['physician']}><PQueuePage /></ProtectedRoute>} />
    <Route path="/p/review/:caseId" element={<ProtectedRoute requiredRole={['physician']}><PReviewPage /></ProtectedRoute>} />
    <Route path="/p/letters" element={<ProtectedRoute requiredRole={['physician']}><PLettersPage /></ProtectedRoute>} />
    <Route path="/403" element={<ProtectedRoute requiredRole={['admin', 'ops_staff', 'physician']}><NoAccessPage /></ProtectedRoute>} />
    <Route path="/not-found" element={<ProtectedRoute requiredRole={['admin', 'ops_staff', 'physician']}><NotFoundPage /></ProtectedRoute>} />
    <Route path="*" element={<ProtectedRoute requiredRole={['admin', 'ops_staff', 'physician']}><NotFoundPage /></ProtectedRoute>} />
    <Route path="/legacy" element={<Navigate to="/" replace />} />
  </Routes></AuthProvider></BrowserRouter></QueryClientProvider>;
}
