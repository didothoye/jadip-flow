# Guide agence

## Tableau de bord (`/agence`)

Vue flotte en cinq secondes : instances et leur santé, clients, workflows actifs / inactifs / non rattachés, exécutions du jour et de la semaine, taux de réussite sur 7 jours, alertes ouvertes, coût IA du mois, exécutions par jour (14 jours), **clients à risque** (aucune exécution depuis X jours, taux d’échec anormal, budget IA dépassé) et dernières erreurs non traitées.

## Clients

- Liste avec les indicateurs clés (exécutions 30 j, réussite, dernière exécution, temps gagné, coût IA vs budget, alertes, risque).
- Fiche client : workflows, activité, erreurs, utilisateurs (invitation, renvoi, désactivation, réinitialisation 2FA), paramètres (autorisations, budget, facturation, rapports automatiques, logo), alertes et journal des actions, coûts.
- Le client « Interne — Jadip Services » regroupe vos workflows internes (étiquette `client:interne`).

## Workflows

- Liste filtrable (recherche, client, non rattachés), interrupteur activer / désactiver (confirmation, journalisé ; impossible sur un workflow « critique »).
- Fiche workflow : courbe 30 jours, exécutions filtrables (pagination par curseur), dernières erreurs avec nœud fautif et catégorie, lien direct vers n8n, **relance** d’une exécution en échec (si la version de n8n le permet ; sinon message explicite), **marquer comme traitée**, événements (créé, renommé, supprimé, rattaché, activé…), journal des actions.
- **Présentation au client** : nom lisible, description en langage humain, minutes gagnées par exécution, coût IA estimé par exécution, verrous (critique, visible, activation et relance autorisées), rattachement (automatique par étiquette ou manuel).

## Erreurs

Classement automatique : **Authentification**, **Limite de débit**, **Réseau**, **Données**, **Logique**. Filtres par catégorie, par client, « non traitées », sélection multiple pour marquer comme traitées. Le client voit, lui, une explication simple en français pour chaque catégorie, jamais le message technique.

## Alertes

- Types : échec d’exécution, taux d’échec > seuil, synchronisation en panne (instance n8n injoignable), coût IA > budget. Un workflow qui ne s’exécute pas n’est **pas** un incident : il n’existe plus d’alerte d’inactivité (l’indicateur « client à risque » du tableau de bord reste visible).
- Portée : globale, par client ou par workflow (la règle la plus précise s’applique).
- **Anti-rafale** : la première occurrence est notifiée immédiatement ; les suivantes sont regroupées en un seul message (« 5 échecs en 15 min », au plus une notification par « fenêtre de regroupement ») ; une alerte persistante non acquittée est rappelée après le « délai de répétition ». Une alerte d’échec se résout seule dès qu’une exécution réussit.
- Canaux : Telegram (votre bot), e-mail (Zoho), dans l’application. Sur Telegram ne partent que les types activés dans **Paramètres › Alertes Telegram** (les critiques — échec d’exécution, instance injoignable — le sont par défaut ; les informations restent dans le portail). **Horaires calmes** (22 h – 7 h par défaut, fuseau Africa/Kinshasa) : les messages sont différés à la fin de la plage, sauf alertes critiques.
- Le client concerné est aussi prévenu (s’il l’a choisi), une fois par incident, en français simple.

## Coûts IA et rapports

- Comptes fournisseurs (OpenAI, Anthropic, OpenRouter) : récupération automatique toutes les 6 heures ; attribution par projet / espace de travail / clé / modèle ; saisie manuelle ; estimation par exécution.
- Coûts par client, workflow, modèle et jour ; budget mensuel par client avec alerte.
- Rapports mensuels PDF et Excel (fond blanc, bordures simples, Times New Roman 12, en-tête Jadip Services) générés et envoyés automatiquement le 1er du mois (réglable) aux clients qui l’ont activé.
- **Rentabilité** : facturation mensuelle vs coût IA, marge et taux de marge par client.

## Demandes

Les demandes des clients (modification, problème, question, avec pièces jointes) arrivent sur Telegram, par e-mail et dans l’application. Répondez depuis la fiche de la demande et changez son statut (Nouveau, En cours, En attente de réponse, Terminé, Fermé) : le client est notifié.

## Paramètres

Horaires calmes, seuils « à risque », paramètres de synchronisation, jour d’envoi des rapports, notification des actions client, test des canaux, équipe (administrateurs), webhooks sortants, état des tâches planifiées.

### Alertes Telegram

Onglet réservé à l’administrateur. Le **jeton du bot** (BotFather) et l’**identifiant de la discussion** destinataire (compte ou groupe) se modifient ici, sans toucher au `.env` ni redémarrer : ils sont enregistrés en base (jeton chiffré, seuls ses 4 derniers caractères sont réaffichés) et pris en compte immédiatement. Au premier démarrage, les valeurs du `.env` sont reprises comme valeurs initiales ; ensuite la base fait foi. Le bouton **Envoyer un message de test** confirme la réception ou explique l’erreur de Telegram (jeton invalide, discussion introuvable, bot non démarré par l’utilisateur). En dessous, un interrupteur par type d’alerte choisit ce qui part sur Telegram.

## Journal d’audit

Journal **inaltérable** : chaque entrée est chaînée par empreinte SHA-256 à la précédente, et la base refuse toute modification ou suppression. Bouton « Vérifier l’intégrité ». Sources : web, api, mcp, système.

## Questionner Jadip Flow depuis Claude Code (MCP)

1. « Mon compte » → Jetons d’API → créer un jeton en lecture.
2. `claude mcp add --transport http jadip-flow https://flow.jadipservices.com/mcp --header "Authorization: Bearer jf_…"`
3. Exemples : « Quels clients sont à risque ? », « Montre les erreurs d’authentification non traitées », « Combien a coûté l’IA pour Amani ce mois-ci ? ».
