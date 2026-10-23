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

# Проверка прав sudo / root
if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
        SUDO="sudo"
        echo -e "${YELLOW}Для установки требуются права root. Запрос пароля sudo:${NC}"
        $SUDO -v || { echo -e "${RED}Ошибка авторизации sudo.${NC}"; exit 1; }
    else
        echo -e "${RED}Ошибка: запустите установщик от имени root или установите sudo (apt install sudo).${NC}"
        exit 1
    fi
else
    SUDO=""
fi

INSTALL_DIR="/opt/ubuntu_panel"
REPO_URL="https://github.com/GrinRonm/ubuntu_panel.git"

echo -e "${BLUE}[1/5] Проверка системных пакетов и зависимостей...${NC}"
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq curl git wget util-linux ufw ca-certificates >/dev/null 2>&1

# Проверка / установка Docker
if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}Docker не найден. Установка официального Docker Engine...${NC}"
    curl -fsSL https://get.docker.com | $SUDO sh
    $SUDO systemctl enable --now docker
    echo -e "${GREEN}Docker успешно установлен!${NC}"
else
    echo -e "${GREEN}Docker уже установлен.${NC}"
fi

# Проверка docker compose plugin
if ! docker compose version &> /dev/null; then
    echo -e "${YELLOW}Установка плагина docker-compose-plugin...${NC}"
    $SUDO apt-get install -y -qq docker-compose-plugin >/dev/null 2>&1 || true
fi

echo -e "${BLUE}[2/5] Подготовка файлов в ${INSTALL_DIR}...${NC}"
$SUDO mkdir -p "$INSTALL_DIR"
$SUDO chown -R "$(id -u):$(id -g)" "$INSTALL_DIR"

if [ -d "$INSTALL_DIR/.git" ]; then
    echo -e "${YELLOW}Обновление существующей установки...${NC}"
    cd "$INSTALL_DIR"
    git fetch --all -q
    git reset --hard origin/main -q
else
    if [ "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
        git clone -q "$REPO_URL" /tmp/ubuntu_panel_git
        cp -rf /tmp/ubuntu_panel_git/* /tmp/ubuntu_panel_git/.* "$INSTALL_DIR/" 2>/dev/null || true
        rm -rf /tmp/ubuntu_panel_git
    else
        git clone -q "$REPO_URL" "$INSTALL_DIR"
    fi
    cd "$INSTALL_DIR"
fi

echo -e "${BLUE}[3/5] Настройка окружения и генерация учетных данных...${NC}"

# Определение локального IP
LOCAL_IP=$(ip -4 addr show scope global 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n 1)
[ -z "$LOCAL_IP" ] && LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$LOCAL_IP" ] && LOCAL_IP="127.0.0.1"

# Сохраняем или создаем .env
if [ -f "$INSTALL_DIR/.env" ]; then
    source "$INSTALL_DIR/.env"
    echo -e "${YELLOW}Используются сохраненные учетные данные из .env${NC}"
else
    ADMIN_USER="${ADMIN_USER:-admin}"
    if [ -z "$ADMIN_PASS" ]; then
        RAND_HEX=$(openssl rand -hex 4 2>/dev/null || head -c 8 /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 8)
        ADMIN_PASS="admin_${RAND_HEX}"
    fi
    PANEL_PORT="${PORT:-8088}"
    SECRET_KEY=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 32)

    cat << EOF > "$INSTALL_DIR/.env"
ADMIN_USER=${ADMIN_USER}
ADMIN_PASS=${ADMIN_PASS}
SECRET_KEY=${SECRET_KEY}
PORT=${PANEL_PORT}
EOF
    chmod 600 "$INSTALL_DIR/.env"
fi

echo -e "${BLUE}[4/5] Сборка и запуск контейнера Docker...${NC}"
cd "$INSTALL_DIR"
$SUDO docker compose down >/dev/null 2>&1 || true
$SUDO docker compose up -d --build

# Открытие порта в UFW если он включен
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -qw "active"; then
    echo -e "${YELLOW}Открытие порта ${PANEL_PORT}/tcp в UFW...${NC}"
    $SUDO ufw allow ${PANEL_PORT}/tcp >/dev/null 2>&1 || true
fi

echo -e "${BLUE}[5/5] Проверка запуска панели...${NC}"
sleep 3
for i in {1..8}; do
    if curl -s "http://127.0.0.1:${PANEL_PORT}/" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

echo ""
echo -e "${GREEN}================================================================${NC}"
echo -e "${GREEN}${BOLD}        🎉 УСТАНОВКА УСПЕШНО ЗАВЕРШЕНА! 🎉${NC}"
echo -e "${GREEN}================================================================${NC}"
echo -e "${BOLD}Локальный адрес:${NC}    ${CYAN}http://${LOCAL_IP}:${PANEL_PORT}/${NC}"
echo -e "${BOLD}Вход на сервере:${NC}    ${CYAN}http://localhost:${PANEL_PORT}/${NC}"
echo -e "${BOLD}Логин:${NC}              ${YELLOW}${ADMIN_USER}${NC}"
echo -e "${BOLD}Пароль:${NC}             ${YELLOW}${ADMIN_PASS}${NC}"
echo -e "${GREEN}================================================================${NC}"
echo -e "${BOLD}Папка проекта:${NC}      ${INSTALL_DIR}"
echo -e "${BOLD}Файл настроек:${NC}      ${INSTALL_DIR}/.env"
echo -e "${BOLD}Перезапуск панели:${NC}  cd ${INSTALL_DIR} && sudo docker compose restart"
echo -e "${BOLD}Просмотр логов:${NC}     cd ${INSTALL_DIR} && sudo docker compose logs -f"
echo -e "${GREEN}================================================================${NC}"
echo ""
