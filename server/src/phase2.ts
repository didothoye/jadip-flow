// Phase 2 : coûts des modèles d'IA et rapports
import { registerRoutes } from './app.js';
import { addJob } from './scheduler.js';
import costRoutes from './routes/admin/costs.js';
import { fetchAllAccounts } from './services/llm/costs.js';
import { monthlyReports } from './services/reports.js';
import { getSettings } from './services/settings.js';
import { localHHMM, previousPeriod } from './lib/time.js';
import { config } from './config.js';

registerRoutes(costRoutes);

addJob({ name: 'llm-usage', everyMs: 6 * 3600_000, lockKey: 2001, run: fetchAllAccounts });
addJob({
  name: 'monthly-reports', everyMs: 3600_000, lockKey: 2002,
  run: async () => {
    const s = await getSettings();
    const localDay = Number(new Intl.DateTimeFormat('fr-FR', { timeZone: config.timezone, day: 'numeric' }).format(new Date()));
    // le jour prévu, à partir de 8 h (heure locale)
    if (localDay !== s.reports.autoSendDay || localHHMM() < '08:00') return { skipped: true };
    return monthlyReports(previousPeriod());
  },
});
