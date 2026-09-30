import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { UiProvider, Loading } from './components/ui';
import { AgencyLayout, PortalLayout } from './components/layouts';
import { ActivatePage, ForgotPage, homeFor, LoginPage, ResetPage } from './pages/auth/AuthPages';
import Account from './pages/Account';

const a = (f: () => Promise<{ default: any }>) => lazy(f);
// agence
const Dashboard = a(() => import('./pages/agency/Dashboard'));
const Clients = a(() => import('./pages/agency/Clients'));
const ClientDetail = a(() => import('./pages/agency/ClientDetail'));
const Workflows = a(() => import('./pages/agency/Workflows'));
const WorkflowDetail = a(() => import('./pages/agency/WorkflowDetail'));
const Executions = a(() => import('./pages/agency/Executions'));
const Errors = a(() => import('./pages/agency/Errors'));
const Alerts = a(() => import('./pages/agency/Alerts'));
const Instances = a(() => import('./pages/agency/Instances'));
const Costs = a(() => import('./pages/agency/Costs'));
const Reports = a(() => import('./pages/agency/Reports'));
const Tickets = a(() => import('./pages/agency/Tickets'));
const TicketDetail = a(() => import('./pages/agency/TicketDetail'));
const Settings = a(() => import('./pages/agency/Settings'));
const Audit = a(() => import('./pages/agency/Audit'));
// portail client
const PortalHome = a(() => import('./pages/portal/Home'));
const PortalWorkflow = a(() => import('./pages/portal/WorkflowPage'));
const PortalCosts = a(() => import('./pages/portal/CostsPage'));
const PortalReports = a(() => import('./pages/portal/ReportsPage'));
const PortalTickets = a(() => import('./pages/portal/TicketsPage'));
const PortalNewTicket = a(() => import('./pages/portal/NewTicketPage'));
const PortalTicket = a(() => import('./pages/portal/TicketPage'));

function Guard({ role, children }: { role: 'admin' | 'client'; children: ReactNode }) {
  const { user, ready } = useAuth();
  if (!ready) return <Loading />;
  if (!user) return <Navigate to="/connexion" replace />;
  if (user.role !== role) return <Navigate to={homeFor(user.role)} replace />;
  return <>{children}</>;
}

function Root() {
  const { user, ready } = useAuth();
  if (!ready) return <Loading />;
  return <Navigate to={user ? homeFor(user.role) : '/connexion'} replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <UiProvider>
        <BrowserRouter>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<Root />} />
              <Route path="/connexion" element={<LoginPage />} />
              <Route path="/activer/:token" element={<ActivatePage />} />
              <Route path="/mot-de-passe-oublie" element={<ForgotPage />} />
              <Route path="/reinitialiser/:token" element={<ResetPage />} />
              <Route path="/agence" element={<Guard role="admin"><AgencyLayout /></Guard>}>
                <Route index element={<Dashboard />} />
                <Route path="clients" element={<Clients />} />
                <Route path="clients/:id" element={<ClientDetail />} />
                <Route path="workflows" element={<Workflows />} />
                <Route path="workflows/:id" element={<WorkflowDetail />} />
                <Route path="executions" element={<Executions />} />
                <Route path="erreurs" element={<Errors />} />
                <Route path="alertes" element={<Alerts />} />
                <Route path="instances" element={<Instances />} />
                <Route path="couts" element={<Costs />} />
                <Route path="rapports" element={<Reports />} />
                <Route path="demandes" element={<Tickets />} />
                <Route path="demandes/:id" element={<TicketDetail />} />
                <Route path="parametres" element={<Settings />} />
                <Route path="journal" element={<Audit />} />
                <Route path="compte" element={<Account />} />
              </Route>
              <Route path="/portail" element={<Guard role="client"><PortalLayout /></Guard>}>
                <Route index element={<PortalHome />} />
                <Route path="automatisations/:id" element={<PortalWorkflow />} />
                <Route path="couts" element={<PortalCosts />} />
                <Route path="rapports" element={<PortalReports />} />
                <Route path="demandes" element={<PortalTickets />} />
                <Route path="demandes/nouvelle" element={<PortalNewTicket />} />
                <Route path="demandes/:id" element={<PortalTicket />} />
                <Route path="compte" element={<Account />} />
              </Route>
              <Route path="*" element={<Root />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </UiProvider>
    </AuthProvider>
  );
}
