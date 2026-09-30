// Phase 3 : espace client et demandes
import { registerRoutes } from './app.js';
import portalRoutes from './routes/client/portal.js';
import adminTicketRoutes from './routes/admin/tickets.js';

registerRoutes(portalRoutes, adminTicketRoutes);
