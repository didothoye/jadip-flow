# Performances mesurées

Test automatisé : `server/test/perf.test.ts` (`PERF_ROWS=100000 npx vitest run test/perf.test.ts`).
Jeu : **100 000 exécutions** (métadonnées), 4 clients, 20 workflows, réparties sur 90 jours, 10 % d’échecs.
Environnement de mesure : conteneur de développement cloud, PostgreSQL 16 local, temps de réponse HTTP mesurés côté serveur (requête « à chaud »), le 30 septembre 2026.

| Mesure | Temps |
|---|---|
| Insertion des 100 000 lignes (SQL) | 6,1 s |
| Liste des exécutions — première page (50) | 4 ms |
| Liste des exécutions — page profonde (après 10 000 lignes, pagination par curseur) | 2 ms |
| Liste filtrée « échecs » | 3 ms |
| Liste d’un workflow | 3 ms |
| Tableau de bord agence (vue flotte complète) | 38 ms |
| Liste des clients avec indicateurs | 30 ms |
| Liste des workflows avec indicateurs | 152 ms |
| Erreurs récentes | 19 ms |
| Accueil du portail client | 34 ms |

Choix qui rendent ces temps possibles :

- pagination **par curseur** `(started_at, id)` — le coût d’une page ne dépend pas de sa profondeur (pas d’`OFFSET`) ;
- index `(workflow_id, started_at desc, id desc)`, `(client_id, started_at desc, id desc)`, `(started_at desc, id desc)` et index partiel sur les échecs ;
- `client_id` dénormalisé sur chaque exécution (cloisonnement et filtres sans jointure) ;
- insertion groupée à la synchronisation (lots de 500 via `unnest`) ;
- purge quotidienne selon la durée de conservation de chaque instance.
