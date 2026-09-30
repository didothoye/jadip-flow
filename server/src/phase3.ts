// Phase 3 : espace client et demandes
import { registerRoutes } from './app.js';
import portalRoutes from './routes/client/portal.js';
import adminTicketRoutes from './routes/admin/tickets.js';

registerRoutes(portalRoutes, adminTicketRoutes);

import { addJob } from './scheduler.js';
import { sendWeeklySummaries } from './services/weekly.js';
import { localHHMM } from './lib/time.js';
import { config } from './config.js';
import { getSettingRaw } from './services/settings.js';
import { q } from './db.js';

// résumé hebdomadaire : le lundi à partir de 8 h (heure locale), une seule fois par semaine
addJob({
  name: 'weekly-summary', everyMs: 3600_000, lockKey: 3001,
  run: async () => {
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, weekday: 'short' }).format(new Date());
    if (weekday !== 'Mon' || localHHMM() < '08:00') return { skipped: true };
    const week = new Date().toISOString().slice(0, 10);
    if ((await getSettingRaw('lastWeeklySummary')) === week) return { skipped: true };
    const r = await sendWeeklySummaries();
    await q(`INSERT INTO settings(key, value) VALUES ('lastWeeklySummary', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(week)]);
    return r;
  },
});
