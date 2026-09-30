#!/usr/bin/env bash
# Reconnaissance du VPS en LECTURE SEULE avant l'installation de Jadip Flow.
# N'affiche aucun secret (pas de variables d'environnement, pas de contenu de fichiers de configuration).
# Usage (depuis votre ordinateur) : ssh jadip 'bash -s' < deploy/scripts/vps-inspect.sh
set -u
h() { printf '\n== %s ==\n' "$1"; }
h "Système"; uname -srm; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"); echo "Utilisateur : $(id -un) (sudo : $(sudo -n true 2>/dev/null && echo oui || echo 'mot de passe requis ou non'))"
h "Ressources"; nproc | sed 's/^/CPU : /'; free -h | awk 'NR<=2'; df -h / /opt /srv 2>/dev/null | awk '!seen[$0]++'
h "Docker"; docker --version 2>&1; docker compose version 2>&1 | head -1
h "Réseaux Docker"; docker network ls --format '{{.Name}}  ({{.Driver}})' 2>&1
h "Conteneurs (nom | image | réseaux | état)"; docker ps -a --format '{{.Names}} | {{.Image}} | {{.Networks}} | {{.Status}}' 2>&1
h "Ports publiés"; docker ps --format '{{.Names}} {{.Ports}}' 2>&1 | grep -E '0\.0\.0\.0|::' || echo "(aucun)"
h "Dossiers d'applications"; for d in /opt /opt/apps /srv /srv/apps "$HOME" "$HOME/apps"; do [ -d "$d" ] && { echo "$d :"; ls -1 "$d" 2>/dev/null | head -40 | sed 's/^/  /'; }; done
h "Projets docker compose"; docker compose ls 2>&1
h "Outils de sauvegarde"; for t in git age gpg rclone pg_dump curl openssl; do printf '%-9s %s\n' "$t" "$(command -v $t || echo absent)"; done
rclone listremotes 2>/dev/null | sed 's/^/remote rclone : /'
h "Tâches cron (noms de fichiers seulement)"; ls -1 /etc/cron.d 2>/dev/null; crontab -l 2>/dev/null | grep -v '^#' | awk '{print "crontab : " $0}' | sed -E 's/(TOKEN|KEY|PASS|SECRET)[^ ]*/\1=***/g' | head -20
h "Accès GitHub depuis le VPS"; timeout 10 ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -T git@github.com 2>&1 | head -1
h "Fin"; echo "Copiez tout ce texte dans la conversation."
