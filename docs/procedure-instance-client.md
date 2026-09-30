# Ajouter une instance n8n et un client

## A. Ajouter une instance n8n

1. Dans n8n : **Settings → n8n API → Create an API key**. Donnez-lui un nom explicite (« Jadip Flow ») et, si votre version le permet, les droits de lecture des workflows et des exécutions, et d’activation/désactivation.
2. Dans Jadip Flow : **Agence → Instances n8n → Ajouter une instance**.
   - *Nom* : ex. « n8n principal (mode queue) ».
   - *URL de l’API* : l’adresse joignable **depuis le conteneur Jadip Flow**. Sur le même VPS, préférez l’adresse interne du réseau Docker (ex. `http://n8n-main:5678`) plutôt que l’URL publique.
   - *URL publique* (facultatif) : l’adresse utilisée pour les liens « Ouvrir dans n8n » (ex. `https://n8n.jadipservices.com`).
   - *Clé API* : collée une seule fois ; elle est chiffrée (AES-256-GCM) et n’est plus jamais affichée.
   - *Intervalle de synchronisation* (5 min par défaut) et *conservation* des exécutions (90 jours par défaut).
3. Cliquez **Tester la connexion**, puis **Enregistrer**, puis **Synchroniser maintenant**. Le résumé indique les workflows créés et les exécutions importées. La première synchronisation importe au plus 20 000 exécutions récentes (réglable dans Paramètres).

En mode queue, rien de particulier : l’API publique de n8n lit les exécutions en base, quel que soit le worker qui les a traitées.

## B. Ajouter un client

1. **Agence → Clients → Nouveau client** : raison sociale, *code* court (minuscules, chiffres, tirets — ex. `amani`), contact.
2. Dans n8n, ajoutez à chaque workflow du client l’étiquette **`client:<code>`** (ex. `client:amani`). À la synchronisation suivante, les workflows sont rattachés automatiquement. Les workflows internes portent `client:interne`.
   - Vous pouvez aussi rattacher un workflow à la main depuis sa fiche (le rattachement manuel prime sur l’étiquette).
3. Pour chaque workflow du client, ouvrez sa fiche et complétez **Présentation au client** : nom lisible, description en langage simple, minutes gagnées par exécution, coût IA estimé par exécution (si le fournisseur n’expose pas l’usage), et les verrous (critique, visible, activation/relance autorisées).
4. Onglet **Paramètres** du client : autorisations (activer/désactiver, relancer, voir les coûts, voir les rapports), budget IA mensuel, facturation mensuelle (pour la rentabilité), envoi automatique du rapport mensuel et destinataires, logo.
5. Onglet **Utilisateurs → Inviter** : le client reçoit un e-mail avec un lien d’activation valable 7 jours (le lien est aussi affiché pour que vous puissiez l’envoyer vous-même, par WhatsApp par exemple).

## C. Coûts d’IA

1. **Coûts IA → Comptes fournisseurs** : ajoutez vos clés d’administration (OpenAI *Admin key*, Anthropic *Admin API key*, OpenRouter *provisioning key*). Elles sont chiffrées et seulement lues.
2. **Récupérer maintenant**, puis onglet **Attribution** : chaque ligne non attribuée (projet OpenAI, espace de travail Anthropic, clé OpenRouter) se rattache à un client (et éventuellement un workflow) en un clic. Conseil : un projet / espace de travail / clé par client rend l’attribution automatique.
3. Sans usage exposé : saisie manuelle, ou coût estimé par exécution sur la fiche du workflow.
