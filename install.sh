#!/usr/bin/env bash
set -e

# ==============================================================================
# Ubuntu Panel (ServerDeck) — Автоматический установщик в 1 команду
# Репозиторий: https://github.com/GrinRonm/ubuntu_panel
# ==============================================================================

# Цвета для терминала
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${CYAN}${BOLD}"
cat << "EOF"
  ____                                ____            _    
 / ___|  ___ _ ____   _____ _ __     |  _ \  ___  ___| | __
 \___ \ / _ \ '__\ \ / / _ \ '__|____| | | |/ _ \/ __| |/ /
  ___) |  __/ |   \ V /  __/ | |_____| |_| |  __/ (__|   < 
 |____/ \___|_|    \_/ \___|_|       |____/ \___|\___|_|\_\
          Ультралёгкая панель управления сервером
EOF
echo -e "${NC}"

# Проверка root прав
if [ "$EUID" -ne 0 ]; then
  echo -e "${YELLOW}Запуск с правами sudo...${NC}"
  exec sudo bash "$0" "$@"
fi

INSTALL_DIR="/opt/ubuntu_panel"
REPO_URL="https://github.com/GrinRonm/ubuntu_panel.git"

echo -e "${BLUE}[1/5] Проверка системных пакетов и зависимостей...${NC}"
apt-get update -qq
apt-get install -y -qq curl git wget util-linux ufw ca-certificates >/dev/null 2>&1

# Проверка / установка Docker
if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}Docker не найден. Установка официального Docker Engine...${NC}"
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
    echo -e "${GREEN}Docker успешно установлен!${NC}"
else
    echo -e "${GREEN}Docker уже установлен.${NC}"
fi

# Проверка docker compose
if ! docker compose version &> /dev/null; then
    echo -e "${YELLOW}Установка плагина docker-compose-plugin...${NC}"
    apt-get install -y -qq docker-compose-plugin >/dev/null 2>&1 || true
fi

echo -e "${BLUE}[2/5] Загрузка файлов панели в ${INSTALL_DIR}...${NC}"
if [ -d "$INSTALL_DIR/.git" ]; then
    echo -e "${YELLOW}Обновление существующей установки...${NC}"
    cd "$INSTALL_DIR"
    git fetch --all -q
    git reset --hard origin/main -q
else
    mkdir -p "$INSTALL_DIR"
    git clone -q "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

echo -e "${BLUE}[3/5] Настройка окружения и безопасности...${NC}"
# Определение IP сервера
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$SERVER_IP" ] && SERVER_IP="127.0.0.1"

# Генерация пароля если не передан
DEFAULT_PASS="admin_$(openssl rand -hex 4)"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-$DEFAULT_PASS}"
PANEL_PORT="${PANEL_PORT:-8088}"
SECRET_KEY=$(openssl rand -hex 32)

if [ ! -f .env ]; then
    cat << EOF > .env
ADMIN_USER=${ADMIN_USER}
ADMIN_PASS=${ADMIN_PASS}
SECRET_KEY=${SECRET_KEY}
PORT=${PANEL_PORT}
EOF
    chmod 600 .env
else
    # Загружаем существующие параметры
    source .env
fi

echo -e "${BLUE}[4/5] Сборка и запуск контейнера Docker...${NC}"
docker compose down >/dev/null 2>&1 || true
docker compose up -d --build

# Открытие порта в UFW если он активен
if ufw status | grep -qw "active"; then
    echo -e "${YELLOW}Открытие порта ${PANEL_PORT}/tcp в UFW...${NC}"
    ufw allow ${PANEL_PORT}/tcp >/dev/null 2>&1 || true
fi

echo -e "${BLUE}[5/5] Проверка работоспособности...${NC}"
sleep 3
if curl -skf "http://127.0.0.1:${PANEL_PORT}/api/auth/me" >/dev/null 2>&1 || curl -skf "http://127.0.0.1:${PANEL_PORT}/" >/dev/null 2>&1; then
    echo -e "${GREEN}${BOLD}Панель успешно запущена и работает!${NC}"
else
    echo -e "${YELLOW}Контейнер запущен, инициализация завершается...${NC}"
fi

echo ""
echo -e "${GREEN}================================================================${NC}"
echo -e "${GREEN}${BOLD}        🎉 УСТАНОВКА УСПЕШНО ЗАВЕРШЕНА! 🎉${NC}"
echo -e "${GREEN}================================================================${NC}"
echo -e "${BOLD}Адрес панели:${NC}     ${CYAN}http://${SERVER_IP}:${PANEL_PORT}/${NC}"
echo -e "${BOLD}Логин:${NC}            ${YELLOW}${ADMIN_USER}${NC}"
echo -e "${BOLD}Пароль:${NC}           ${YELLOW}${ADMIN_PASS}${NC}"
echo -e "${GREEN}================================================================${NC}"
echo -e "${BOLD}Папка проекта:${NC}    ${INSTALL_DIR}"
echo -e "${BOLD}Перезапуск:${NC}       cd ${INSTALL_DIR} && docker compose restart"
echo -e "${BOLD}Просмотр логов:${NC}   cd ${INSTALL_DIR} && docker compose logs -f"
echo -e "${GREEN}================================================================${NC}"
echo ""
