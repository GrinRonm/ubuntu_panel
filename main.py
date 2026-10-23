import os
import sys
import time
import json
import asyncio
import subprocess
import re
import shutil
import sqlite3
from pathlib import Path
from typing import Optional, List, Dict, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, status, Request, Response, Query, UploadFile, File, Form
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
import psutil
import jwt
import ptyprocess

# Configuration
ADMIN_USER = os.getenv("ADMIN_USER", "grinronn")
ADMIN_PASS = os.getenv("ADMIN_PASS", "Griha2901!")
SECRET_KEY = os.getenv("SECRET_KEY", "serverdeck_secret_grinronn_2026_super_secure_key_123456")
ALGORITHM = "HS256"
COOKIE_NAME = "serverdeck_session"
HOST_ROOT = "/host"
NGINX_AVAILABLE = "/etc/nginx/sites-available"
NGINX_ENABLED = "/etc/nginx/sites-enabled"
DATA_DIR = "/app/data"
DB_PATH = os.path.join(DATA_DIR, "metrics.db")

os.makedirs(DATA_DIR, exist_ok=True)

# Host execution helper
def run_host_cmd(cmd: List[str], timeout: int = 15, input_str: Optional[str] = None) -> tuple[int, str, str]:
    try:
        full_cmd = ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--"] + cmd
        proc = subprocess.run(
            full_cmd,
            input=input_str,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "Command timed out"
    except Exception as e:
        return 1, "", str(e)

# --- SQLite Metrics Ring Buffer ---
def init_db():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("PRAGMA journal_mode = WAL;")
    cur.execute("PRAGMA synchronous = NORMAL;")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS metrics (
            timestamp INTEGER PRIMARY KEY,
            cpu_percent REAL,
            ram_percent REAL,
            ram_used INTEGER,
            net_rx_rate REAL,
            net_tx_rate REAL,
            disk_percent REAL
        );
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(timestamp);")
    conn.commit()
    conn.close()

init_db()

# Metrics collection background worker
prev_net_record = None
prev_net_record_time = None

async def metrics_worker():
    global prev_net_record, prev_net_record_time
    # Initialize initial cpu sample
    psutil.cpu_percent(interval=None)
    loop_count = 0

    while True:
        try:
            now = int(time.time())
            cpu = psutil.cpu_percent(interval=None)
            mem = psutil.virtual_memory()
            net = psutil.net_io_counters()

            rx_rate = 0.0
            tx_rate = 0.0
            if prev_net_record and prev_net_record_time:
                dt = max(time.time() - prev_net_record_time, 0.1)
                rx_rate = max((net.bytes_recv - prev_net_record.bytes_recv) / dt, 0.0)
                tx_rate = max((net.bytes_sent - prev_net_record.bytes_sent) / dt, 0.0)
            prev_net_record = net
            prev_net_record_time = time.time()

            disk_pct = 0.0
            try:
                disk_pct = psutil.disk_usage("/").percent
            except Exception:
                pass

            # Write to SQLite
            conn = sqlite3.connect(DB_PATH)
            cur = conn.cursor()
            cur.execute("""
                INSERT OR REPLACE INTO metrics 
                (timestamp, cpu_percent, ram_percent, ram_used, net_rx_rate, net_tx_rate, disk_percent)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (now, round(cpu, 1), round(mem.percent, 1), mem.used, round(rx_rate), round(tx_rate), round(disk_pct, 1)))

            loop_count += 1
            # Cleanup records older than 24h every 100 ticks (approx 16 minutes)
            if loop_count % 100 == 0:
                cur.execute("DELETE FROM metrics WHERE timestamp < ?", (now - 86400,))

            conn.commit()
            conn.close()
        except Exception as e:
            print("Metrics worker error:", e)

        await asyncio.sleep(10)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start metrics background task
    task = asyncio.create_task(metrics_worker())
    yield
    task.cancel()

app = FastAPI(title="ServerDeck", version="1.1.0", lifespan=lifespan)

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Authentication helpers
def create_session_token(username: str) -> str:
    payload = {
        "sub": username,
        "exp": int(time.time()) + 86400 * 7
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

def verify_token(request: Request) -> Optional[str]:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        auth_hdr = request.headers.get("Authorization")
        if auth_hdr and auth_hdr.startswith("Bearer "):
            token = auth_hdr.split(" ")[1]
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload.get("sub")
    except Exception:
        return None

def require_auth(request: Request):
    user = verify_token(request)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return user

# --- Auth Routes ---
@app.post("/api/auth/login")
async def login(request: Request, response: Response):
    data = await request.json()
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()

    if username == ADMIN_USER and password == ADMIN_PASS:
        token = create_session_token(username)
        response.set_cookie(
            key=COOKIE_NAME,
            value=token,
            max_age=86400 * 7,
            httponly=True,
            samesite="lax",
            secure=False
        )
        return {"status": True, "token": token, "username": username}
    raise HTTPException(status_code=400, detail="Неверное имя пользователя или пароль")

@app.post("/api/auth/logout")
async def logout(response: Response):
    response.delete_cookie(COOKIE_NAME)
    return {"status": True}

@app.get("/api/auth/me")
async def me(user: str = Depends(require_auth)):
    return {"status": True, "username": user}

# --- System Stats Engine (High-Performance Caching) ---
prev_net = None
prev_net_time = None
cached_disks = []
cached_disks_time = 0.0

def get_system_snapshot() -> Dict[str, Any]:
    global prev_net, prev_net_time, cached_disks, cached_disks_time
    now = time.time()
    
    cpu_overall = psutil.cpu_percent(interval=None)
    cpu_per_core = psutil.cpu_percent(interval=None, percpu=True)
    
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    
    # Host df with 10s caching (saves CPU overhead)
    if (now - cached_disks_time > 10.0) or not cached_disks:
        disks = []
        code, stdout, _ = run_host_cmd(["df", "-B1", "--output=target,source,fstype,size,used,avail,pcent"], timeout=3)
        if code == 0:
            lines = stdout.strip().splitlines()
            for line in lines[1:]:
                parts = line.split()
                if len(parts) >= 7:
                    target, source, fstype, size, used, avail, pcent = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], parts[6]
                    if target in ["/", "/mnt/disk2"] or target.startswith("/mnt/") or target.startswith("/media/"):
                        try:
                            pct = float(pcent.replace("%", "").strip())
                            disks.append({
                                "mount": target,
                                "device": source,
                                "fstype": fstype,
                                "total": int(size),
                                "used": int(used),
                                "free": int(avail),
                                "percent": pct
                            })
                        except Exception:
                            pass
        if not disks:
            u = psutil.disk_usage("/")
            disks.append({
                "mount": "/",
                "device": "/dev/sda3",
                "fstype": "ext4",
                "total": u.total,
                "used": u.used,
                "free": u.free,
                "percent": u.percent
            })
        cached_disks = disks
        cached_disks_time = now
    disks = cached_disks

    net = psutil.net_io_counters()
    net_rx_rate = 0.0
    net_tx_rate = 0.0
    if prev_net and prev_net_time:
        dt = max(now - prev_net_time, 0.1)
        net_rx_rate = max((net.bytes_recv - prev_net.bytes_recv) / dt, 0.0)
        net_tx_rate = max((net.bytes_sent - prev_net.bytes_sent) / dt, 0.0)
    prev_net = net
    prev_net_time = now

    load1, load5, load15 = os.getloadavg()
    uptime_sec = 0
    try:
        with open("/proc/uptime", "r") as f:
            uptime_sec = float(f.readline().split()[0])
    except Exception:
        uptime_sec = now - psutil.boot_time()

    hostname = os.uname().nodename
    kernel = os.uname().release

    code, out, _ = run_host_cmd(["systemctl", "is-active", "beget-ddns"])
    beget_active = (code == 0 and "active" in out)

    return {
        "cpu": {
            "overall": round(cpu_overall, 1),
            "cores": [round(c, 1) for c in cpu_per_core],
            "count": len(cpu_per_core)
        },
        "memory": {
            "total": mem.total,
            "used": mem.used,
            "free": mem.available,
            "percent": round(mem.percent, 1)
        },
        "swap": {
            "total": swap.total,
            "used": swap.used,
            "percent": round(swap.percent, 1)
        },
        "disks": disks,
        "network": {
            "rx_sec": round(net_rx_rate),
            "tx_sec": round(net_tx_rate),
            "total_rx": net.bytes_recv,
            "total_tx": net.bytes_sent
        },
        "load": [round(load1, 2), round(load5, 2), round(load15, 2)],
        "uptime": int(uptime_sec),
        "hostname": hostname,
        "kernel": kernel,
        "beget_ddns_active": beget_active,
        "timestamp": int(now)
    }

@app.get("/api/system/stats")
async def system_stats(user: str = Depends(require_auth)):
    return get_system_snapshot()

@app.get("/api/system/history")
async def system_history(range_val: str = Query("1h", alias="range"), user: str = Depends(require_auth)):
    # Supported ranges: 15m, 1h, 6h, 24h
    now = int(time.time())
    seconds_map = {
        "15m": 15 * 60,
        "1h": 3600,
        "6h": 6 * 3600,
        "24h": 24 * 3600
    }
    span = seconds_map.get(range_val, 3600)
    since_ts = now - span

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("PRAGMA journal_mode = WAL;")
    cur.execute("PRAGMA synchronous = NORMAL;")
    cur.execute("""
        SELECT timestamp, cpu_percent, ram_percent, ram_used, net_rx_rate, net_tx_rate, disk_percent
        FROM metrics
        WHERE timestamp >= ?
        ORDER BY timestamp ASC
    """, (since_ts,))
    rows = cur.fetchall()
    conn.close()

    # If too many points (e.g. 24h has ~8640 points), downsample for smooth browser rendering
    max_points = 240
    step = max(1, len(rows) // max_points)
    sampled = rows[::step] if step > 1 else rows

    points = []
    for r in sampled:
        points.append({
            "t": r[0],
            "cpu": r[1],
            "ram": r[2],
            "ram_used": r[3],
            "rx_kb": round(r[4] / 1024, 1),
            "tx_kb": round(r[5] / 1024, 1),
            "disk": r[6]
        })

    return {"range": range_val, "points": points}

@app.websocket("/ws/system/stats")
async def ws_system_stats(websocket: WebSocket):
    await websocket.accept()
    token = websocket.cookies.get(COOKIE_NAME)
    valid = False
    if token:
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            if payload.get("sub"):
                valid = True
        except Exception:
            pass
    if not valid:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    try:
        while True:
            stats = get_system_snapshot()
            await websocket.send_json(stats)
            await asyncio.sleep(2)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass

# --- Top Processes API ---
@app.get("/api/processes")
async def list_processes(sort_by: str = "cpu", limit: int = 35, user: str = Depends(require_auth)):
    procs = []
    for p in psutil.process_iter(['pid', 'name', 'username', 'cpu_percent', 'memory_percent', 'memory_info', 'status']):
        try:
            info = p.info
            mem_info = info.get('memory_info')
            rss = mem_info.rss if mem_info else 0
            procs.append({
                "pid": info['pid'],
                "name": info['name'] or 'unknown',
                "user": info['username'] or 'system',
                "cpu": round(info['cpu_percent'] or 0.0, 1),
                "ram": round(info['memory_percent'] or 0.0, 1),
                "rss": rss,
                "status": info['status']
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    if sort_by == "ram":
        procs.sort(key=lambda x: x["ram"], reverse=True)
    else:
        procs.sort(key=lambda x: x["cpu"], reverse=True)

    return procs[:limit]

@app.post("/api/processes/{pid}/kill")
async def kill_process(pid: int, user: str = Depends(require_auth)):
    if pid <= 1:
        raise HTTPException(status_code=400, detail="Нельзя завершить системный процесс PID 1")
    code, out, err = run_host_cmd(["kill", "-9", str(pid)])
    if code != 0:
        raise HTTPException(status_code=500, detail=err or "Не удалось завершить процесс")
    return {"status": True, "message": f"Процесс {pid} завершён"}

# --- Nginx Manager Routes ---
def parse_nginx_config(content: str) -> Dict[str, Any]:
    server_names = []
    for match in re.finditer(r'server_name\s+([^;]+);', content):
        names = match.group(1).strip().split()
        for n in names:
            if n not in server_names and n not in ["_", "localhost"]:
                server_names.append(n)
    
    listen_ports = []
    has_ssl = False
    for match in re.finditer(r'listen\s+([^;]+);', content):
        part = match.group(1).strip()
        if "ssl" in part:
            has_ssl = True
        port = part.split()[0]
        if port not in listen_ports:
            listen_ports.append(port)
            
    proxy_targets = []
    for match in re.finditer(r'proxy_pass\s+([^;]+);', content):
        t = match.group(1).strip()
        if t not in proxy_targets:
            proxy_targets.append(t)

    roots = []
    for match in re.finditer(r'root\s+([^;]+);', content):
        r = match.group(1).strip()
        if r not in roots:
            roots.append(r)

    return {
        "domains": server_names,
        "ports": listen_ports,
        "has_ssl": has_ssl,
        "proxy_targets": proxy_targets,
        "roots": roots
    }

@app.get("/api/nginx/sites")
async def list_nginx_sites(user: str = Depends(require_auth)):
    if not os.path.exists(NGINX_AVAILABLE):
        return []

    sites = []
    available_files = sorted(os.listdir(NGINX_AVAILABLE))
    enabled_files = set(os.listdir(NGINX_ENABLED)) if os.path.exists(NGINX_ENABLED) else set()

    for fname in available_files:
        fpath = os.path.join(NGINX_AVAILABLE, fname)
        if not os.path.isfile(fpath):
            continue
        try:
            with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            parsed = parse_nginx_config(content)
            stat = os.stat(fpath)
            is_enabled = fname in enabled_files
            sites.append({
                "filename": fname,
                "enabled": is_enabled,
                "domains": parsed["domains"],
                "ports": parsed["ports"],
                "has_ssl": parsed["has_ssl"],
                "proxy_targets": parsed["proxy_targets"],
                "roots": parsed["roots"],
                "size": stat.st_size,
                "mtime": int(stat.st_mtime)
            })
        except Exception as e:
            sites.append({
                "filename": fname,
                "enabled": fname in enabled_files,
                "error": str(e)
            })

    return sites

@app.get("/api/nginx/sites/{filename}")
async def get_nginx_site(filename: str, user: str = Depends(require_auth)):
    safe_filename = os.path.basename(filename)
    fpath = os.path.join(NGINX_AVAILABLE, safe_filename)
    if not os.path.exists(fpath):
        raise HTTPException(status_code=404, detail="Конфигурационный файл не найден")
    with open(fpath, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    enabled = os.path.exists(os.path.join(NGINX_ENABLED, safe_filename))
    return {"filename": safe_filename, "enabled": enabled, "content": content}

@app.post("/api/nginx/sites/{filename}")
async def save_nginx_site(filename: str, request: Request, user: str = Depends(require_auth)):
    safe_filename = os.path.basename(filename)
    fpath = os.path.join(NGINX_AVAILABLE, safe_filename)
    data = await request.json()
    new_content = data.get("content", "")

    if os.path.exists(fpath):
        shutil.copy2(fpath, fpath + ".bak")

    with open(fpath, "w", encoding="utf-8") as f:
        f.write(new_content)

    return {"status": True, "message": "Файл сохранён"}

@app.post("/api/nginx/sites/{filename}/toggle")
async def toggle_nginx_site(filename: str, user: str = Depends(require_auth)):
    safe_filename = os.path.basename(filename)
    avail_path = os.path.join(NGINX_AVAILABLE, safe_filename)
    enabled_path = os.path.join(NGINX_ENABLED, safe_filename)

    if not os.path.exists(avail_path):
        raise HTTPException(status_code=404, detail="Файл не существует в sites-available")

    if os.path.exists(enabled_path):
        os.unlink(enabled_path)
        enabled = False
    else:
        os.symlink(avail_path, enabled_path)
        enabled = True

    return {"status": True, "enabled": enabled, "message": "Сайт включен" if enabled else "Сайт отключен"}

@app.delete("/api/nginx/sites/{filename}")
async def delete_nginx_site(filename: str, user: str = Depends(require_auth)):
    safe_filename = os.path.basename(filename)
    avail_path = os.path.join(NGINX_AVAILABLE, safe_filename)
    enabled_path = os.path.join(NGINX_ENABLED, safe_filename)

    if os.path.exists(enabled_path):
        os.unlink(enabled_path)
    if os.path.exists(avail_path):
        os.unlink(avail_path)

    return {"status": True, "message": f"Конфиг {safe_filename} удалён"}

@app.post("/api/nginx/test")
async def test_nginx_config(user: str = Depends(require_auth)):
    code, stdout, stderr = run_host_cmd(["nginx", "-t"])
    output = (stdout + "\n" + stderr).strip()
    return {"status": code == 0, "code": code, "output": output}

@app.post("/api/nginx/reload")
async def reload_nginx(user: str = Depends(require_auth)):
    code, stdout, stderr = run_host_cmd(["nginx", "-t"])
    if code != 0:
        return {"status": False, "code": code, "output": (stdout + "\n" + stderr).strip()}
    
    code, stdout, stderr = run_host_cmd(["nginx", "-s", "reload"])
    output = (stdout + "\n" + stderr).strip() or "Nginx успешно перезагружен"
    return {"status": code == 0, "code": code, "output": output}

@app.post("/api/nginx/sites/new")
async def create_new_site(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    domain = data.get("domain", "").strip().lower()
    site_type = data.get("type", "proxy")
    proxy_target = data.get("proxy_target", "http://127.0.0.1:3000").strip()
    root_path = data.get("root_path", "/var/www/html").strip()
    enable_ssl = data.get("enable_ssl", False)
    ssl_cert = data.get("ssl_cert", f"/etc/letsencrypt/live/{domain}/fullchain.pem").strip()
    ssl_key = data.get("ssl_key", f"/etc/letsencrypt/live/{domain}/privkey.pem").strip()

    if not domain:
        raise HTTPException(status_code=400, detail="Укажите домен")

    conf_filename = f"{domain}.conf"
    conf_path = os.path.join(NGINX_AVAILABLE, conf_filename)
    if os.path.exists(conf_path):
        raise HTTPException(status_code=400, detail=f"Конфиг для {domain} уже существует!")

    if site_type == "proxy":
        location_block = f"""    location / {{
        proxy_pass {proxy_target};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }}"""
    else:
        location_block = f"""    root {root_path};
    index index.html index.htm;

    location / {{
        try_files $uri $uri/ =404;
    }}"""

    if enable_ssl:
        template = f"""# {domain}
server {{
    listen 80;
    server_name {domain};

    location /.well-known/acme-challenge/ {{
        root /var/www/html;
    }}

    location / {{
        return 301 https://$host$request_uri;
    }}
}}

server {{
    listen 443 ssl http2;
    server_name {domain};

    ssl_certificate {ssl_cert};
    ssl_certificate_key {ssl_key};

    client_max_body_size 500M;

{location_block}
}}
"""
    else:
        template = f"""# {domain}
server {{
    listen 80;
    server_name {domain};

    client_max_body_size 500M;

    location /.well-known/acme-challenge/ {{
        root /var/www/html;
    }}

{location_block}
}}
"""

    with open(conf_path, "w", encoding="utf-8") as f:
        f.write(template)

    enabled_path = os.path.join(NGINX_ENABLED, conf_filename)
    if not os.path.exists(enabled_path):
        os.symlink(conf_path, enabled_path)

    code, stdout, stderr = run_host_cmd(["nginx", "-t"])
    if code != 0:
        if os.path.exists(enabled_path):
            os.unlink(enabled_path)
        os.unlink(conf_path)
        return {"status": False, "message": "Синтаксическая ошибка при создании конфига", "error": stdout + stderr}

    run_host_cmd(["nginx", "-s", "reload"])
    return {"status": True, "filename": conf_filename, "message": f"Сайт {domain} успешно создан и активирован!"}

# --- Comprehensive Systemd Services API (with 4s TTL Cache) ---
cached_services_data = []
cached_services_time = 0.0

@app.get("/api/services/systemd")
async def list_all_systemd_services(user: str = Depends(require_auth)):
    global cached_services_data, cached_services_time
    now = time.time()
    if (now - cached_services_time < 4.0) and cached_services_data:
        return cached_services_data

    services = {}

    # 1. Get all unit files
    code1, out1, _ = run_host_cmd(["systemctl", "list-unit-files", "--type=service", "--no-pager", "--no-legend"])
    if code1 == 0:
        for line in out1.splitlines():
            parts = line.split()
            if len(parts) >= 2:
                name = parts[0]
                unit_state = parts[1]
                services[name] = {
                    "name": name,
                    "unit_file_state": unit_state,
                    "enabled": (unit_state == "enabled"),
                    "active": False,
                    "status_text": "inactive",
                    "sub_state": "dead",
                    "description": ""
                }

    # 2. Get active status of loaded units
    code2, out2, _ = run_host_cmd(["systemctl", "list-units", "--type=service", "--all", "--no-pager", "--no-legend"])
    if code2 == 0:
        for line in out2.splitlines():
            parts = line.split(maxsplit=4)
            if len(parts) >= 4:
                unit_name = parts[0]
                active_state = parts[2]
                sub_state = parts[3]
                desc = parts[4] if len(parts) > 4 else ""

                if unit_name not in services:
                    services[unit_name] = {
                        "name": unit_name,
                        "unit_file_state": "loaded",
                        "enabled": False,
                        "description": desc
                    }
                services[unit_name]["active"] = (active_state == "active")
                services[unit_name]["status_text"] = active_state
                services[unit_name]["sub_state"] = sub_state
                if desc:
                    services[unit_name]["description"] = desc

    cached_services_data = list(services.values())
    cached_services_time = time.time()
    return cached_services_data

@app.post("/api/services/systemd/{name}/{action}")
async def systemd_action(name: str, action: str, user: str = Depends(require_auth)):
    if action not in ["start", "stop", "restart", "reload", "enable", "disable"]:
        raise HTTPException(status_code=400, detail="Недопустимое действие")
    global cached_services_time
    cached_services_time = 0.0
    safe_name = os.path.basename(name)
    code, out, err = run_host_cmd(["systemctl", action, safe_name])
    action_desc = {
        "start": "запущена",
        "stop": "остановлена",
        "restart": "перезапущена",
        "reload": "перезагружена",
        "enable": "включена в автозапуск",
        "disable": "отключена из автозапуска"
    }.get(action, action)
    return {
        "status": code == 0, 
        "code": code, 
        "output": (out + err).strip(),
        "action": action,
        "message": f"Служба {safe_name} успешно {action_desc}!" if code == 0 else f"Ошибка: {err or out}"
    }

@app.get("/api/services/systemd/{name}/logs")
async def systemd_unit_logs(name: str, lines: int = 100, user: str = Depends(require_auth)):
    safe_name = os.path.basename(name)
    code, stdout, stderr = run_host_cmd(["journalctl", "-u", safe_name, "-n", str(lines), "--no-pager"])
    return {"name": safe_name, "lines": (stdout or stderr).splitlines()}

# --- Docker Services API ---
@app.get("/api/services/docker")
async def list_docker_containers(user: str = Depends(require_auth)):
    try:
        import docker
        client = docker.DockerClient(base_url="unix://var/run/docker.sock")
        containers = []
        for c in client.containers.list(all=True):
            containers.append({
                "id": c.short_id,
                "name": c.name,
                "image": c.image.tags[0] if c.image.tags else c.image.short_id,
                "status": c.status,
                "created": c.attrs.get("Created", ""),
                "ports": str(c.ports)
            })
        return containers
    except Exception as e:
        return {"error": str(e), "containers": []}

@app.post("/api/services/docker/{name}/{action}")
async def docker_action(name: str, action: str, user: str = Depends(require_auth)):
    if action not in ["start", "stop", "restart"]:
        raise HTTPException(status_code=400, detail="Недопустимое действие")
    try:
        import docker
        client = docker.DockerClient(base_url="unix://var/run/docker.sock")
        container = client.containers.get(name)
        if action == "start":
            container.start()
        elif action == "stop":
            container.stop()
        elif action == "restart":
            container.restart()
        return {"status": True, "message": f"Контейнер {name} {action}ed"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# --- Server Users Management API ---
@app.get("/api/users")
async def list_server_users(user: str = Depends(require_auth)):
    users = []
    sudo_members = set()

    # Get sudo members
    try:
        with open("/host/etc/group", "r") as f:
            for line in f:
                parts = line.strip().split(":")
                if len(parts) >= 4 and parts[0] in ["sudo", "wheel", "admin"]:
                    for u in parts[3].split(","):
                        if u.strip():
                            sudo_members.add(u.strip())
    except Exception:
        pass

    # Read /etc/passwd
    try:
        with open("/host/etc/passwd", "r") as f:
            for line in f:
                parts = line.strip().split(":")
                if len(parts) >= 7:
                    uname, _, uid, gid, comment, home, shell = parts
                    uid_int = int(uid)
                    is_system = (uid_int < 1000 and uid_int != 0)
                    is_sudo = (uname in sudo_members or uid_int == 0)
                    users.append({
                        "username": uname,
                        "uid": uid_int,
                        "gid": int(gid),
                        "comment": comment,
                        "home": home,
                        "shell": shell,
                        "is_system": is_system,
                        "is_sudo": is_sudo
                    })
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ошибка чтения пользователей: {e}")

    # Sort: non-system users first, then by UID
    users.sort(key=lambda u: (u["is_system"], u["uid"]))
    return users

@app.post("/api/users/create")
async def create_server_user(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    new_user = data.get("username", "").strip()
    new_pass = data.get("password", "").strip()
    shell = data.get("shell", "/bin/bash").strip()
    is_sudo = data.get("is_sudo", False)

    if not new_user or not re.match(r"^[a-z_][a-z0-9_-]*$", new_user):
        raise HTTPException(status_code=400, detail="Недопустимое имя пользователя (только строчные латинские буквы, цифры, дефис)")
    if not new_pass:
        raise HTTPException(status_code=400, detail="Укажите пароль")

    # useradd
    code, out, err = run_host_cmd(["useradd", "-m", "-s", shell, new_user])
    if code != 0:
        raise HTTPException(status_code=400, detail=f"Ошибка создания пользователя: {err or out}")

    # chpasswd
    code2, _, err2 = run_host_cmd(["chpasswd"], input_str=f"{new_user}:{new_pass}\n")
    if code2 != 0:
        raise HTTPException(status_code=500, detail=f"Ошибка установки пароля: {err2}")

    # Sudo group
    if is_sudo:
        run_host_cmd(["usermod", "-aG", "sudo", new_user])

    return {"status": True, "message": f"Пользователь {new_user} успешно создан!"}

@app.post("/api/users/{username}/password")
async def change_user_password(username: str, request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    new_pass = data.get("password", "").strip()
    if not new_pass:
        raise HTTPException(status_code=400, detail="Пароль не может быть пустым")

    safe_user = os.path.basename(username)
    code, _, err = run_host_cmd(["chpasswd"], input_str=f"{safe_user}:{new_pass}\n")
    if code != 0:
        raise HTTPException(status_code=500, detail=f"Ошибка смены пароля: {err}")
    return {"status": True, "message": f"Пароль пользователя {safe_user} успешно изменен"}

@app.post("/api/users/{username}/toggle-sudo")
async def toggle_user_sudo(username: str, user: str = Depends(require_auth)):
    safe_user = os.path.basename(username)
    # Check if currently in sudo
    code, out, _ = run_host_cmd(["groups", safe_user])
    if "sudo" in out:
        run_host_cmd(["gpasswd", "-d", safe_user, "sudo"])
        is_sudo = False
    else:
        run_host_cmd(["usermod", "-aG", "sudo", safe_user])
        is_sudo = True
    return {"status": True, "is_sudo": is_sudo, "message": f"Права sudo {'предоставлены' if is_sudo else 'отозваны'}"}

@app.delete("/api/users/{username}")
async def delete_server_user(username: str, user: str = Depends(require_auth)):
    safe_user = os.path.basename(username)
    if safe_user in ["root", "grinronn"]:
        raise HTTPException(status_code=400, detail="Нельзя удалить системного администратора или текущего пользователя")

    code, out, err = run_host_cmd(["userdel", "-r", safe_user])
    if code != 0:
        raise HTTPException(status_code=500, detail=f"Ошибка удаления: {err or out}")
    return {"status": True, "message": f"Пользователь {safe_user} удалён"}

# --- File Manager Routes ---
def resolve_host_path(rel_path: str) -> str:
    cleaned = rel_path.strip().lstrip("/")
    full = os.path.join(HOST_ROOT, cleaned)
    return os.path.normpath(full)

def to_client_path(host_path: str) -> str:
    norm = os.path.normpath(host_path)
    if norm.startswith(HOST_ROOT):
        res = norm[len(HOST_ROOT):]
        return res if res.startswith("/") else "/" + res
    return norm

@app.get("/api/files/list")
async def file_list(path: str = "/", user: str = Depends(require_auth)):
    real_path = resolve_host_path(path)
    if not os.path.exists(real_path):
        raise HTTPException(status_code=404, detail="Каталог не найден")
    if not os.path.isdir(real_path):
        raise HTTPException(status_code=400, detail="Путь не является каталогом")

    items = []
    try:
        with os.scandir(real_path) as it:
            for entry in it:
                try:
                    stat = entry.stat(follow_symlinks=False)
                    is_dir = entry.is_dir(follow_symlinks=False)
                    is_sym = entry.is_symlink()
                    client_path = to_client_path(entry.path)
                    items.append({
                        "name": entry.name,
                        "path": client_path,
                        "is_dir": is_dir,
                        "is_symlink": is_sym,
                        "size": stat.st_size if not is_dir else 0,
                        "mtime": int(stat.st_mtime),
                        "mode": oct(stat.st_mode)[-4:]
                    })
                except Exception:
                    continue
    except PermissionError:
        raise HTTPException(status_code=403, detail="Доступ запрещен")

    return {
        "current_path": to_client_path(real_path),
        "parent_path": to_client_path(os.path.dirname(real_path)) if real_path != HOST_ROOT else "/",
        "items": items
    }

@app.get("/api/files/read")
async def file_read(path: str, user: str = Depends(require_auth)):
    real_path = resolve_host_path(path)
    if not os.path.exists(real_path) or os.path.isdir(real_path):
        raise HTTPException(status_code=404, detail="Файл не найден")
    if os.path.getsize(real_path) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Файл слишком большой (>10MB)")

    try:
        with open(real_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        return {"path": path, "content": content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/files/save")
async def file_save(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    path = data.get("path", "")
    content = data.get("content", "")
    real_path = resolve_host_path(path)
    try:
        with open(real_path, "w", encoding="utf-8") as f:
            f.write(content)
        return {"status": True, "message": "Файл успешно сохранён"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/files/create")
async def file_create(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    path = data.get("path", "")
    is_dir = data.get("is_dir", False)
    real_path = resolve_host_path(path)
    if os.path.exists(real_path):
        raise HTTPException(status_code=400, detail="Элемент уже существует")
    try:
        if is_dir:
            os.makedirs(real_path, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(real_path), exist_ok=True)
            with open(real_path, "w", encoding="utf-8") as f:
                f.write("")
        return {"status": True, "message": "Создано успешно"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/files/delete")
async def file_delete(path: str = Query(...), user: str = Depends(require_auth)):
    real_path = resolve_host_path(path)
    if not os.path.exists(real_path):
        raise HTTPException(status_code=404, detail="Путь не найден")
    try:
        if os.path.isdir(real_path):
            shutil.rmtree(real_path)
        else:
            os.unlink(real_path)
        return {"status": True, "message": "Удалено успешно"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/files/upload")
async def file_upload(path: str = Form(...), file: UploadFile = File(...), user: str = Depends(require_auth)):
    real_dir = resolve_host_path(path)
    if not os.path.exists(real_dir) or not os.path.isdir(real_dir):
        raise HTTPException(status_code=400, detail="Целевой каталог не существует")
    dest_path = os.path.join(real_dir, os.path.basename(file.filename))
    try:
        with open(dest_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
        return {"status": True, "message": f"Файл {file.filename} загружен"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# --- System Logs Routes ---
@app.get("/api/logs/nginx")
async def get_nginx_logs(log_type: str = "access", lines: int = 100, filter_term: str = "", user: str = Depends(require_auth)):
    filename = "access.log" if log_type == "access" else "error.log"
    log_path = f"/var/log/nginx/{filename}"
    if not os.path.exists(log_path):
        return {"lines": [f"Файл {log_path} не найден"]}
    try:
        cmd = ["tail", "-n", str(lines * 2), log_path]
        res = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
        all_lines = res.stdout.splitlines()
        if filter_term:
            all_lines = [l for l in all_lines if filter_term.lower() in l.lower()]
        return {"lines": all_lines[-lines:]}
    except Exception as e:
        return {"lines": [str(e)]}

@app.get("/api/logs/journal")
async def get_journal_logs(unit: str = "", lines: int = 100, user: str = Depends(require_auth)):
    cmd = ["journalctl", "-n", str(lines), "--no-pager"]
    if unit:
        cmd.extend(["-u", unit])
    code, stdout, stderr = run_host_cmd(cmd)
    return {"lines": (stdout or stderr).splitlines()}

# --- SSL / Let's Encrypt Routes ---
@app.get("/api/ssl/certificates")
async def get_ssl_certificates(user: str = Depends(require_auth)):
    code, stdout, stderr = run_host_cmd(["certbot", "certificates"])
    certs = []
    current = {}
    for line in stdout.splitlines():
        line = line.strip()
        if line.startswith("Certificate Name:"):
            if current:
                certs.append(current)
            current = {"name": line.split(":", 1)[1].strip(), "domains": []}
        elif "Domains:" in line and current:
            current["domains"] = line.split(":", 1)[1].strip().split()
        elif "Expiry Date:" in line and current:
            m = re.search(r"Expiry Date:\s*([^\(]+)\s*\(([^:]+):\s*([^\)]+)\)", line)
            if m:
                current["expiry_date"] = m.group(1).strip()
                state = m.group(2).strip()
                current["validity_state"] = state
                days_str = m.group(3).strip()
                days_m = re.search(r"(-?\d+)\s*days?", days_str)
                days = int(days_m.group(1)) if days_m else (0 if "EXPIRED" in line else 90)
                current["days_remaining"] = days
                if "EXPIRED" in line or days <= 0:
                    current["status"] = "expired"
                elif days <= 30:
                    current["status"] = "expiring"
                else:
                    current["status"] = "valid"
            else:
                current["expiry_date"] = line.split(":", 1)[1].strip()
                current["days_remaining"] = 0
                current["validity_state"] = "UNKNOWN"
                current["status"] = "expired" if "EXPIRED" in line else "unknown"
        elif "Certificate Path:" in line and current:
            current["cert_path"] = line.split(":", 1)[1].strip()
        elif "Private Key Path:" in line and current:
            current["key_path"] = line.split(":", 1)[1].strip()
        elif "Key Type:" in line and current:
            current["key_type"] = line.split(":", 1)[1].strip()
        elif "Serial Number:" in line and current:
            current["serial"] = line.split(":", 1)[1].strip()
    if current:
        certs.append(current)
    return {"certificates": certs}

@app.post("/api/ssl/renew")
async def renew_ssl(request: Request, user: str = Depends(require_auth)):
    data = await request.json() if request.headers.get("content-type") == "application/json" else {}
    cert_name = data.get("cert_name") if data else None
    cmd = ["certbot", "renew", "--non-interactive"]
    if cert_name:
        cmd.extend(["--cert-name", cert_name])
    code, stdout, stderr = run_host_cmd(cmd, timeout=120)
    run_host_cmd(["nginx", "-s", "reload"])
    return {
        "status": code == 0,
        "code": code,
        "output": (stdout + "\n" + stderr).strip(),
        "message": "Продление успешно завершено" if code == 0 else "Ошибка при продлении"
    }

@app.post("/api/ssl/issue")
async def issue_ssl(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    domain = data.get("domain", "").strip()
    email = data.get("email", "").strip() or "admin@grinronn.ru"
    if not domain:
        raise HTTPException(status_code=400, detail="Укажите домен")
    cmd = ["certbot", "--nginx", "-d", domain, "--non-interactive", "--agree-tos", "-m", email]
    code, stdout, stderr = run_host_cmd(cmd, timeout=120)
    run_host_cmd(["nginx", "-s", "reload"])
    if code != 0:
        raise HTTPException(status_code=500, detail=f"Ошибка выпуска SSL: {stderr or stdout}")
    return {"status": True, "message": f"SSL сертификат для {domain} успешно получен!"}

@app.delete("/api/ssl/certificates/{cert_name}")
async def delete_ssl_cert(cert_name: str, user: str = Depends(require_auth)):
    safe_name = os.path.basename(cert_name)
    cmd = ["certbot", "delete", "--cert-name", safe_name, "--non-interactive"]
    code, stdout, stderr = run_host_cmd(cmd, timeout=30)
    if code != 0:
        raise HTTPException(status_code=500, detail=f"Ошибка удаления: {stderr or stdout}")
    return {"status": True, "message": f"Сертификат {safe_name} удалён"}

# --- Network & UFW Firewall Routes ---
@app.get("/api/network/overview")
async def get_network_overview(user: str = Depends(require_auth)):
    code_ufw, stdout_ufw, _ = run_host_cmd(["ufw", "status", "numbered"])
    ufw_active = "Status: active" in stdout_ufw or "Состояние: активен" in stdout_ufw
    
    rules = []
    for line in stdout_ufw.splitlines():
        line = line.strip()
        m = re.match(r"\[\s*(\d+)\]\s+([^\s]+(?:\s+\(v6\))?)\s+([A-Z]+(?:\s+[A-Z]+)?)\s+(.+)", line)
        if m:
            rule_id = int(m.group(1))
            to_field = m.group(2).strip()
            action = m.group(3).strip()
            from_field = m.group(4).strip()
            is_v6 = "(v6)" in to_field or "(v6)" in from_field
            rules.append({
                "id": rule_id,
                "to": to_field,
                "action": action,
                "from": from_field,
                "is_v6": is_v6,
                "raw": line
            })

    code_ss, stdout_ss, _ = run_host_cmd(["ss", "-tulpn", "-H"])
    listening = []
    seen = set()
    for line in stdout_ss.splitlines():
        parts = line.split()
        if len(parts) >= 5:
            proto = parts[0].lower()
            local = parts[4]
            last_colon = local.rfind(":")
            if last_colon != -1:
                ip_part = local[:last_colon]
                port_str = local[last_colon+1:]
                try:
                    port = int(port_str)
                except ValueError:
                    continue
                
                proc_str = ""
                pid = None
                if len(parts) >= 7 and "users:(" in line:
                    users_part = line[line.find("users:("):]
                    proc_match = re.search(r'\("([^"]+)",pid=(\d+)', users_part)
                    if proc_match:
                        proc_str = proc_match.group(1)
                        pid = int(proc_match.group(2))

                is_ext = ip_part in ["0.0.0.0", "*", "::"]
                key = (proto, port, ip_part)
                if key in seen:
                    continue
                seen.add(key)

                ufw_state = "unspecified"
                for r in rules:
                    r_to = r["to"].replace("(v6)", "").strip()
                    if str(port) in r_to:
                        ufw_state = "allowed" if "ALLOW" in r["action"] else "denied"
                        break

                listening.append({
                    "proto": proto.upper(),
                    "ip": ip_part,
                    "port": port,
                    "process": proc_str or "—",
                    "pid": pid,
                    "is_external": is_ext,
                    "ufw_state": ufw_state
                })

    listening.sort(key=lambda x: (x["port"], x["proto"]))

    return {
        "ufw": {
            "active": ufw_active,
            "rules": rules
        },
        "listening_ports": listening
    }

@app.post("/api/network/ufw/toggle")
async def toggle_ufw(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    enable = data.get("enable", True)
    cmd = ["ufw", "enable"] if enable else ["ufw", "disable"]
    code, stdout, stderr = run_host_cmd(cmd, input_str="y\n")
    return {"status": True, "active": enable, "message": f"UFW {'включен' if enable else 'отключен'}"}

@app.post("/api/network/ufw/rules")
async def add_ufw_rule(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    port = str(data.get("port", "")).strip()
    proto = data.get("proto", "tcp").lower().strip()
    action = data.get("action", "allow").lower().strip()
    from_ip = data.get("from_ip", "").strip()

    if not port:
        raise HTTPException(status_code=400, detail="Укажите порт или диапазон")

    cmd = ["ufw", action]
    if from_ip and from_ip != "Anywhere":
        cmd.extend(["from", from_ip, "to", "any", "port", port])
        if proto in ["tcp", "udp"]:
            cmd.extend(["proto", proto])
    else:
        target = f"{port}/{proto}" if proto in ["tcp", "udp"] else port
        cmd.append(target)

    code, stdout, stderr = run_host_cmd(cmd, input_str="y\n")
    if code != 0:
        raise HTTPException(status_code=500, detail=f"Ошибка добавления правила: {stderr or stdout}")
    return {"status": True, "message": f"Правило для порта {port} добавлено"}

@app.delete("/api/network/ufw/rules/{rule_id}")
async def delete_ufw_rule(rule_id: int, user: str = Depends(require_auth)):
    cmd = ["ufw", "delete", str(rule_id)]
    code, stdout, stderr = run_host_cmd(cmd, input_str="y\n")
    if code != 0:
        raise HTTPException(status_code=500, detail=f"Ошибка удаления: {stderr or stdout}")
    return {"status": True, "message": f"Правило #{rule_id} удалено"}

# --- S.M.A.R.T. & Disks Health Routes ---
@app.get("/api/smart/disks")
async def get_smart_disks(user: str = Depends(require_auth)):
    code, stdout, _ = run_host_cmd(["lsblk", "-b", "-J", "-o", "NAME,SIZE,TYPE,MODEL,SERIAL,ROTA,MOUNTPOINT,FSTYPE"])
    devices = []
    lsblk_data = {}
    if code == 0:
        try:
            lsblk_data = json.loads(stdout)
        except Exception:
            pass

    raw_devs = lsblk_data.get("blockdevices", [])
    for dev in raw_devs:
        if dev.get("type") == "disk" and not dev.get("name", "").startswith("loop") and not dev.get("name", "").startswith("fd"):
            dev_name = dev["name"]
            dev_path = f"/dev/{dev_name}"
            
            s_code, s_out, _ = run_host_cmd(["smartctl", "-a", "-j", dev_path])
            smart_info = {}
            if s_out:
                try:
                    smart_info = json.loads(s_out)
                except Exception:
                    pass

            attrs = []
            ata_attrs = smart_info.get("ata_smart_attributes", {}).get("table", [])
            realloc = 0
            pending = 0
            uncorr = 0
            ssd_life = None

            for a in ata_attrs:
                aid = a.get("id")
                aname = a.get("name", "")
                raw_val = a.get("raw", {}).get("value", 0)
                raw_str = a.get("raw", {}).get("string", str(raw_val))
                if aid == 5 or "Reallocated" in aname:
                    realloc = raw_val
                elif aid == 197 or "Pending" in aname:
                    pending = raw_val
                elif aid == 198 or "Uncorrectable" in aname:
                    uncorr = raw_val
                elif aid in [231, 232] or "Wear" in aname or "Reserve" in aname:
                    ssd_life = a.get("value")

                attrs.append({
                    "id": aid,
                    "name": aname,
                    "value": a.get("value"),
                    "worst": a.get("worst"),
                    "thresh": a.get("thresh"),
                    "raw": raw_str,
                    "failed": bool(a.get("when_failed"))
                })

            temp = smart_info.get("temperature", {}).get("current")
            if temp is None and ata_attrs:
                for a in ata_attrs:
                    if a.get("id") == 194:
                        temp = a.get("raw", {}).get("value")
                        break

            power_hours = smart_info.get("power_on_time", {}).get("hours")
            power_cycles = smart_info.get("power_cycle_count")
            passed = smart_info.get("smart_status", {}).get("passed", True)

            parts = []
            for child in dev.get("children", []):
                parts.append({
                    "name": child.get("name"),
                    "mount": child.get("mountpoint"),
                    "fstype": child.get("fstype"),
                    "size": child.get("size", 0)
                })

            devices.append({
                "name": dev_name,
                "path": dev_path,
                "model": smart_info.get("model_name") or dev.get("model") or "Диск",
                "serial": smart_info.get("serial_number") or dev.get("serial") or "—",
                "size": dev.get("size", 0),
                "is_ssd": dev.get("rota") == False or dev.get("rota") == 0 or "SSD" in (smart_info.get("model_name") or ""),
                "health_passed": passed,
                "temperature": temp,
                "power_hours": power_hours,
                "power_cycles": power_cycles,
                "reallocated_sectors": realloc,
                "pending_sectors": pending,
                "uncorrectable_errors": uncorr,
                "ssd_life": ssd_life,
                "partitions": parts,
                "attributes": attrs
            })

    return {"disks": devices}

@app.post("/api/smart/test")
async def run_smart_test(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    device = data.get("device", "").strip()
    test_type = data.get("type", "short")
    if not device.startswith("/dev/"):
        device = f"/dev/{device}"
    code, stdout, stderr = run_host_cmd(["smartctl", "-t", test_type, device])
    return {
        "status": code == 0,
        "message": f"Тест {test_type} запущен для {device}. Проверьте результаты через несколько минут."
    }

# --- Cron Scheduler Routes ---
def format_cron_human(expr: str) -> str:
    parts = expr.strip().split()
    if len(parts) != 5:
        return expr
    m, h, dom, mon, dow = parts
    dow_names = {
        "0": "воскресенье", "7": "воскресенье", "1": "понедельник",
        "2": "вторник", "3": "среду", "4": "четверг",
        "5": "пятницу", "6": "субботу"
    }
    if expr == "* * * * *":
        return "Каждую минуту"
    if m.startswith("*/") and h == "*" and dom == "*" and mon == "*" and dow == "*":
        return f"Каждые {m[2:]} мин."
    if h.startswith("*/") and m == "0" and dom == "*" and mon == "*" and dow == "*":
        return f"Каждые {h[2:]} ч."
    if dom == "*" and mon == "*" and dow == "*" and "/" not in h and "/" not in m:
        return f"Ежедневно в {h.zfill(2)}:{m.zfill(2)}"
    if dow in dow_names and dom == "*" and mon == "*":
        return f"Каждый(-ую) {dow_names[dow]} в {h.zfill(2)}:{m.zfill(2)}"
    if dom != "*" and mon == "*" and dow == "*":
        return f"{dom}-го числа каждого месяца в {h.zfill(2)}:{m.zfill(2)}"
    return f"По расписанию ({expr})"

@app.get("/api/cron")
async def get_cron(user_name: str = "grinronn", user: str = Depends(require_auth)):
    safe_user = os.path.basename(user_name)
    code, stdout, _ = run_host_cmd(["crontab", "-u", safe_user, "-l"])
    
    jobs = []
    lines = stdout.splitlines()
    for idx, raw_line in enumerate(lines):
        line = raw_line.strip()
        if not line:
            continue
        is_disabled = False
        parsed_line = line
        if line.startswith("#"):
            candidate = line[1:].strip()
            parts = candidate.split()
            if "tar -zcf /var/backups/home.tgz" in candidate or candidate.startswith("m h"):
                continue
            if len(parts) >= 6 and (parts[0].startswith("*") or parts[0].isdigit() or parts[0].startswith("*/")):
                is_disabled = True
                parsed_line = candidate
            else:
                continue

        tokens = parsed_line.split(None, 5)
        if len(tokens) >= 6:
            expr = " ".join(tokens[:5])
            cmd = tokens[5]
            jobs.append({
                "id": idx,
                "user": safe_user,
                "enabled": not is_disabled,
                "expression": expr,
                "human": format_cron_human(expr),
                "command": cmd,
                "raw": raw_line
            })

    return {
        "user": safe_user,
        "available_users": ["grinronn", "root"],
        "jobs": jobs
    }

@app.post("/api/cron")
async def add_cron(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    target_user = os.path.basename(data.get("user", "grinronn"))
    expr = data.get("expression", "").strip()
    cmd = data.get("command", "").strip()
    comment = data.get("comment", "").strip()

    if not expr or not cmd:
        raise HTTPException(status_code=400, detail="Укажите расписание и команду")

    code, current_crontab, _ = run_host_cmd(["crontab", "-u", target_user, "-l"])
    new_lines = current_crontab.splitlines() if code == 0 else []
    
    if comment:
        new_lines.append(f"# {comment}")
    new_lines.append(f"{expr} {cmd}")
    full_content = "\n".join(new_lines) + "\n"

    res_code, _, res_err = run_host_cmd(["crontab", "-u", target_user, "-"], input_str=full_content)
    if res_code != 0:
        raise HTTPException(status_code=500, detail=f"Ошибка сохранения: {res_err}")
    return {"status": True, "message": "Задача Cron успешно создана"}

@app.post("/api/cron/toggle")
async def toggle_cron(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    target_user = os.path.basename(data.get("user", "grinronn"))
    job_id = int(data.get("id"))

    code, current_crontab, _ = run_host_cmd(["crontab", "-u", target_user, "-l"])
    if code != 0:
        raise HTTPException(status_code=400, detail="Crontab пуст")

    lines = current_crontab.splitlines()
    if job_id < 0 or job_id >= len(lines):
        raise HTTPException(status_code=404, detail="Задача не найдена")

    target = lines[job_id].strip()
    if target.startswith("#"):
        lines[job_id] = target[1:].strip()
        enabled = True
    else:
        lines[job_id] = f"# {target}"
        enabled = False

    full_content = "\n".join(lines) + "\n"
    res_code, _, res_err = run_host_cmd(["crontab", "-u", target_user, "-"], input_str=full_content)
    if res_code != 0:
        raise HTTPException(status_code=500, detail=f"Ошибка: {res_err}")
    return {"status": True, "enabled": enabled, "message": f"Задача {'включена' if enabled else 'приостановлена'}"}

@app.delete("/api/cron")
async def delete_cron(user_name: str = "grinronn", job_id: int = Query(...), user: str = Depends(require_auth)):
    target_user = os.path.basename(user_name)
    code, current_crontab, _ = run_host_cmd(["crontab", "-u", target_user, "-l"])
    if code != 0:
        raise HTTPException(status_code=400, detail="Crontab пуст")

    lines = current_crontab.splitlines()
    if job_id < 0 or job_id >= len(lines):
        raise HTTPException(status_code=404, detail="Задача не найдена")

    del lines[job_id]
    full_content = "\n".join(lines) + "\n"
    res_code, _, res_err = run_host_cmd(["crontab", "-u", target_user, "-"], input_str=full_content)
    if res_code != 0:
        raise HTTPException(status_code=500, detail=f"Ошибка: {res_err}")
    return {"status": True, "message": "Задача Cron удалена"}

@app.post("/api/cron/run")
async def run_cron_now(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    command = data.get("command", "").strip()
    if not command:
        raise HTTPException(status_code=400, detail="Команда пуста")

    start_t = time.time()
    code, stdout, stderr = run_host_cmd(["/bin/bash", "-c", command], timeout=30)
    dur = round((time.time() - start_t) * 1000)
    return {
        "code": code,
        "stdout": stdout,
        "stderr": stderr,
        "duration_ms": dur
    }


# ==========================================
# SAMBA (SMB / CIFS) MANAGEMENT
# ==========================================
SAMBA_CONF_HOST = "/etc/samba/smb.conf"
SAMBA_CONF_CONTAINER = "/host/etc/samba/smb.conf"

def get_samba_raw_conf() -> str:
    if os.path.exists(SAMBA_CONF_CONTAINER):
        try:
            with open(SAMBA_CONF_CONTAINER, "r", encoding="utf-8", errors="replace") as f:
                return f.read()
        except Exception:
            pass
    code, stdout, _ = run_host_cmd(["cat", SAMBA_CONF_HOST])
    return stdout if code == 0 else ""

def save_samba_raw_conf(new_content: str) -> tuple[bool, str]:
    # 1. Test syntax using testparm on a temp file
    tmp_path = "/tmp/test_smb.conf"
    code, _, err = run_host_cmd(["tee", tmp_path], input_str=new_content)
    if code != 0:
        return False, f"Ошибка записи временного файла: {err}"

    t_code, t_out, t_err = run_host_cmd(["testparm", "-s", tmp_path])
    run_host_cmd(["rm", "-f", tmp_path])
    if t_code != 0:
        return False, f"Синтаксическая ошибка smb.conf (testparm):\n{t_err or t_out}"

    # 2. Backup current config
    run_host_cmd(["cp", SAMBA_CONF_HOST, f"{SAMBA_CONF_HOST}.bak"])

    # 3. Write new config
    w_code, _, w_err = run_host_cmd(["tee", SAMBA_CONF_HOST], input_str=new_content)
    if w_code != 0:
        return False, f"Ошибка сохранения {SAMBA_CONF_HOST}: {w_err}"

    # 4. Reload Samba
    run_host_cmd(["systemctl", "reload-or-restart", "smbd"])
    return True, "Конфигурация Samba успешно применена!"

def parse_samba_sections(content: str) -> List[Dict[str, Any]]:
    shares = []
    lines = content.splitlines()
    curr: Optional[Dict[str, Any]] = None

    for line in lines:
        stripped = line.strip()
        m = re.match(r"^\[([^\]]+)\]$", stripped)
        if m:
            s_name = m.group(1).strip()
            curr = {
                "name": s_name,
                "is_special": s_name.lower() in ["global", "printers", "print$"],
                "path": "",
                "comment": "",
                "read_only": True,
                "guest_ok": False,
                "browseable": True,
                "valid_users": "",
                "create_mask": "0775",
                "directory_mask": "0775",
                "unc_path": f"\\\\192.168.0.103\\{s_name}"
            }
            shares.append(curr)
            continue

        if curr and not stripped.startswith("#") and not stripped.startswith(";") and "=" in stripped:
            k, v = stripped.split("=", 1)
            key = k.strip().lower()
            val = v.strip()
            if key == "path":
                curr["path"] = val
            elif key == "comment":
                curr["comment"] = val
            elif key in ["read only", "readonly"]:
                curr["read_only"] = val.lower() in ["yes", "true", "1"]
            elif key in ["writeable", "writable"]:
                curr["read_only"] = val.lower() not in ["yes", "true", "1"]
            elif key in ["guest ok", "public"]:
                curr["guest_ok"] = val.lower() in ["yes", "true", "1"]
            elif key in ["browseable", "browsable"]:
                curr["browseable"] = val.lower() in ["yes", "true", "1"]
            elif key == "valid users":
                curr["valid_users"] = val
            elif key == "create mask":
                curr["create_mask"] = val
            elif key == "directory mask":
                curr["directory_mask"] = val

    return shares

@app.get("/api/samba/overview")
async def get_samba_overview(user: str = Depends(require_auth)):
    # 1. Services status
    code_smbd, out_smbd, _ = run_host_cmd(["systemctl", "is-active", "smbd"])
    code_nmbd, out_nmbd, _ = run_host_cmd(["systemctl", "is-active", "nmbd"])
    smbd_active = (out_smbd.strip() == "active")
    nmbd_active = (out_nmbd.strip() == "active")

    # 2. Version
    _, ver_out, _ = run_host_cmd(["smbd", "-V"])
    version_str = ver_out.strip() or "Samba 4.x"

    # 3. Ports check
    _, ss_out, _ = run_host_cmd(["ss", "-tulpn"])
    port_139 = ":139 " in ss_out or ":139\t" in ss_out
    port_445 = ":445 " in ss_out or ":445\t" in ss_out

    # 4. Shares parsed
    raw_conf = get_samba_raw_conf()
    all_sections = parse_samba_sections(raw_conf)
    shares = [s for s in all_sections if not s["is_special"]]

    # Check path existence for each share
    for s in shares:
        p = s.get("path")
        s["path_exists"] = bool(p and (os.path.exists(os.path.join(HOST_ROOT, p.lstrip("/"))) or os.path.exists(p)))

    # 5. Samba users via pdbedit
    samba_users = []
    code_pdb, out_pdb, _ = run_host_cmd(["pdbedit", "-L"])
    if code_pdb == 0:
        for l in out_pdb.strip().splitlines():
            if ":" in l:
                pts = l.split(":")
                samba_users.append({
                    "username": pts[0],
                    "uid": pts[1] if len(pts) > 1 else "",
                    "fullname": pts[2] if len(pts) > 2 else ""
                })

    # 6. Active sessions via smbstatus -b
    sessions = []
    code_st, out_st, _ = run_host_cmd(["smbstatus", "-b"])
    if code_st == 0:
        dash_found = False
        for l in out_st.splitlines():
            if l.startswith("---"):
                dash_found = True
                continue
            if dash_found and l.strip():
                parts = l.split()
                if len(parts) >= 4:
                    sessions.append({
                        "pid": parts[0],
                        "username": parts[1],
                        "group": parts[2],
                        "machine": parts[3],
                        "protocol": parts[4] if len(parts) > 4 else "SMB3"
                    })

    return {
        "smbd_active": smbd_active,
        "nmbd_active": nmbd_active,
        "version": version_str,
        "ports": {"139": port_139, "445": port_445},
        "shares": shares,
        "users": samba_users,
        "sessions": sessions,
        "server_ip": "192.168.0.103"
    }

@app.post("/api/samba/service")
async def control_samba_service(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    action = data.get("action", "restart")
    if action not in ["restart", "start", "stop", "reload"]:
        raise HTTPException(status_code=400, detail="Недопустимое действие")

    cmd = ["systemctl", action, "smbd", "nmbd"]
    code, stdout, stderr = run_host_cmd(cmd)
    if code != 0:
        raise HTTPException(status_code=500, detail=f"Ошибка управления Samba: {stderr or stdout}")
    return {"status": True, "message": f"Служба Samba ({action}) успешно выполнена"}

@app.post("/api/samba/testparm")
async def run_testparm(user: str = Depends(require_auth)):
    code, stdout, stderr = run_host_cmd(["testparm", "-s", SAMBA_CONF_HOST])
    return {
        "status": (code == 0),
        "output": (stdout + "\n" + stderr).strip()
    }

@app.get("/api/samba/config")
async def get_samba_config(user: str = Depends(require_auth)):
    return {"content": get_samba_raw_conf()}

@app.post("/api/samba/config")
async def save_samba_config(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    content = data.get("content", "")
    if not content.strip():
        raise HTTPException(status_code=400, detail="Конфигурация не может быть пустой")
    ok, msg = save_samba_conf_content(content)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"status": True, "message": msg}

@app.post("/api/samba/shares")
async def save_samba_share(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    name = data.get("name", "").strip()
    old_name = data.get("old_name", "").strip()
    path = data.get("path", "").strip()
    comment = data.get("comment", "").strip()
    read_only = bool(data.get("read_only", False))
    guest_ok = bool(data.get("guest_ok", False))
    browseable = bool(data.get("browseable", True))
    valid_users = data.get("valid_users", "").strip()
    create_mask = data.get("create_mask", "0775").strip()
    directory_mask = data.get("directory_mask", "0775").strip()

    if not name or not re.match(r"^[a-zA-Z0-9_\-\.\$]+$", name):
        raise HTTPException(status_code=400, detail="Недопустимое имя сетевой папки (только латиница, цифры, дефис, подчеркивание)")
    if not path or not path.startswith("/"):
        raise HTTPException(status_code=400, detail="Укажите корректный абсолютный путь на сервере (начинается с /)")

    # Ensure path exists or create on host
    real_host_path = os.path.join(HOST_ROOT, path.lstrip("/"))
    if not os.path.exists(real_host_path) and not os.path.exists(path):
        # Create folder
        run_host_cmd(["mkdir", "-p", path])
        run_host_cmd(["chmod", "0777", path])

    # Format new share block
    lines = [
        f"[{name}]",
        f"    comment = {comment or name}",
        f"    path = {path}",
        f"    browseable = {'yes' if browseable else 'no'}",
        f"    read only = {'yes' if read_only else 'no'}",
        f"    guest ok = {'yes' if guest_ok else 'no'}"
    ]
    if valid_users:
        lines.append(f"    valid users = {valid_users}")
    lines.append(f"    create mask = {create_mask}")
    lines.append(f"    directory mask = {directory_mask}")
    new_share_block = "\n".join(lines) + "\n"

    # Replace in or append to smb.conf
    raw = get_samba_raw_conf()
    target_name = old_name if old_name else name
    pattern = rf"(?ms)^\s*\[{re.escape(target_name)}\]\s*$.*?(?=^\s*\[|\Z)"

    if re.search(pattern, raw):
        updated_conf = re.sub(pattern, new_share_block + "\n", raw)
    else:
        updated_conf = raw.rstrip() + "\n\n" + new_share_block

    ok, msg = save_samba_conf_content(updated_conf)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"status": True, "message": f"Сетевая папка [{name}] успешно сохранена!"}

@app.delete("/api/samba/shares/{share_name}")
async def delete_samba_share(share_name: str, user: str = Depends(require_auth)):
    if share_name.lower() in ["global", "printers", "print$"]:
        raise HTTPException(status_code=400, detail="Нельзя удалить системный раздел")

    raw = get_samba_raw_conf()
    pattern = rf"(?ms)^\s*\[{re.escape(share_name)}\]\s*$.*?(?=^\s*\[|\Z)"
    if not re.search(pattern, raw):
        raise HTTPException(status_code=404, detail="Сетевая папка не найдена")

    updated_conf = re.sub(pattern, "", raw)
    ok, msg = save_samba_conf_content(updated_conf)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"status": True, "message": f"Сетевая папка [{share_name}] удалена"}

@app.post("/api/samba/users")
async def add_samba_user(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()
    create_system_user = bool(data.get("create_system_user", True))

    if not username or not re.match(r"^[a-z_][a-z0-9_-]*$", username):
        raise HTTPException(status_code=400, detail="Недопустимое имя пользователя")
    if not password:
        raise HTTPException(status_code=400, detail="Пароль не может быть пустым")

    # Check if system user exists
    c_id, _, _ = run_host_cmd(["id", username])
    if c_id != 0:
        if create_system_user:
            # Create user without shell
            run_host_cmd(["useradd", "-M", "-s", "/usr/sbin/nologin", username])
        else:
            raise HTTPException(status_code=400, detail=f"Пользователь {username} не существует в системе")

    # Set Samba password
    code, out, err = run_host_cmd(["smbpasswd", "-a", username], input_str=f"{password}\n{password}\n")
    if code != 0:
        raise HTTPException(status_code=500, detail=f"Ошибка smbpasswd: {err or out}")

    run_host_cmd(["smbpasswd", "-e", username])
    return {"status": True, "message": f"Пользователь Samba {username} успешно настроен"}

@app.delete("/api/samba/users/{username}")
async def delete_samba_user(username: str, user: str = Depends(require_auth)):
    safe_u = os.path.basename(username)
    code, out, err = run_host_cmd(["smbpasswd", "-x", safe_u])
    if code != 0:
        raise HTTPException(status_code=500, detail=f"Ошибка удаления: {err or out}")
    return {"status": True, "message": f"Пользователь {safe_u} удален из Samba"}


# ==========================================
# FTP (VSFTPD) MANAGEMENT
# ==========================================
import ftplib

VSFTPD_CONF_HOST = "/etc/vsftpd.conf"
VSFTPD_CONF_CONTAINER = "/host/etc/vsftpd.conf"

def get_vsftpd_raw_conf() -> str:
    if os.path.exists(VSFTPD_CONF_CONTAINER):
        try:
            with open(VSFTPD_CONF_CONTAINER, "r", encoding="utf-8", errors="replace") as f:
                return f.read()
        except Exception:
            pass
    code, stdout, _ = run_host_cmd(["cat", VSFTPD_CONF_HOST])
    return stdout if code == 0 else ""

def save_vsftpd_raw_conf(new_content: str) -> tuple[bool, str]:
    run_host_cmd(["cp", VSFTPD_CONF_HOST, f"{VSFTPD_CONF_HOST}.bak"])
    code, _, err = run_host_cmd(["tee", VSFTPD_CONF_HOST], input_str=new_content)
    if code != 0:
        return False, f"Ошибка записи {VSFTPD_CONF_HOST}: {err}"
    # Restart vsftpd
    r_code, _, r_err = run_host_cmd(["systemctl", "restart", "vsftpd"])
    if r_code != 0:
        return False, f"Ошибка перезапуска vsftpd: {r_err}"
    return True, "Конфигурация FTP успешно сохранена и служба перезапущена!"

def parse_vsftpd_settings(content: str) -> Dict[str, Any]:
    settings = {
        "anonymous_enable": False,
        "local_enable": True,
        "write_enable": True,
        "chroot_local_user": False,
        "pasv_enable": True,
        "pasv_min_port": 39000,
        "pasv_max_port": 40000,
        "listen_port": 21
    }
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            key = k.strip().lower()
            val = v.strip()
            if key == "anonymous_enable":
                settings["anonymous_enable"] = (val.upper() == "YES")
            elif key == "local_enable":
                settings["local_enable"] = (val.upper() == "YES")
            elif key == "write_enable":
                settings["write_enable"] = (val.upper() == "YES")
            elif key == "chroot_local_user":
                settings["chroot_local_user"] = (val.upper() == "YES")
            elif key == "pasv_enable":
                settings["pasv_enable"] = (val.upper() == "YES")
            elif key == "pasv_min_port":
                try: settings["pasv_min_port"] = int(val)
                except: pass
            elif key == "pasv_max_port":
                try: settings["pasv_max_port"] = int(val)
                except: pass
            elif key == "listen_port":
                try: settings["listen_port"] = int(val)
                except: pass
    return settings

@app.get("/api/ftp/overview")
async def get_ftp_overview(user: str = Depends(require_auth)):
    code, out, _ = run_host_cmd(["systemctl", "is-active", "vsftpd"])
    active = (out.strip() == "active")

    # Listening port check
    _, ss_out, _ = run_host_cmd(["ss", "-tulpn"])
    port_21 = ":21 " in ss_out or ":21\t" in ss_out

    # Settings parsed
    raw_conf = get_vsftpd_raw_conf()
    settings = parse_vsftpd_settings(raw_conf)

    # Eligible FTP users from /etc/passwd
    users = []
    passwd_path = os.path.join(HOST_ROOT, "etc/passwd") if os.path.exists(os.path.join(HOST_ROOT, "etc/passwd")) else "/etc/passwd"
    try:
        with open(passwd_path, "r", encoding="utf-8", errors="replace") as f:
            for l in f:
                pts = l.strip().split(":")
                if len(pts) >= 7:
                    u_name, _, uid_str, _, _, home, shell = pts[:7]
                    uid = int(uid_str)
                    if (uid >= 1000 and uid < 65534) or u_name in ["grinronn", "libuser", "smbuser"]:
                        users.append({
                            "username": u_name,
                            "uid": uid,
                            "home": home,
                            "shell": shell
                        })
    except Exception:
        pass

    # Active connections
    _, conn_out, _ = run_host_cmd(["ss", "-tnp", "( sport = :21 )"])
    connections_count = max(0, len(conn_out.strip().splitlines()) - 1) if conn_out.strip() else 0

    return {
        "active": active,
        "port_21": port_21,
        "settings": settings,
        "users": users,
        "connections_count": connections_count,
        "server_ip": "192.168.0.103",
        "url": "ftp://192.168.0.103:21"
    }

@app.post("/api/ftp/service")
async def control_ftp_service(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    action = data.get("action", "restart")
    if action not in ["restart", "start", "stop"]:
        raise HTTPException(status_code=400, detail="Недопустимое действие")
    code, stdout, stderr = run_host_cmd(["systemctl", action, "vsftpd"])
    if code != 0:
        raise HTTPException(status_code=500, detail=f"Ошибка управления vsftpd: {stderr or stdout}")
    return {"status": True, "message": f"Служба vsftpd ({action}) успешно выполнена"}

@app.post("/api/ftp/settings")
async def update_ftp_settings(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    write_enable = bool(data.get("write_enable", True))
    anonymous_enable = bool(data.get("anonymous_enable", False))
    chroot_local_user = bool(data.get("chroot_local_user", False))
    pasv_min_port = int(data.get("pasv_min_port", 39000))
    pasv_max_port = int(data.get("pasv_max_port", 40000))

    raw = get_vsftpd_raw_conf()
    
    # Helper to set or replace key=val in conf
    def set_directive(conf_text: str, key: str, val: str) -> str:
        pattern = rf"(?m)^\s*#?\s*{re.escape(key)}\s*=.*$"
        if re.search(pattern, conf_text):
            return re.sub(pattern, f"{key}={val}", conf_text)
        else:
            return conf_text.rstrip() + f"\n{key}={val}\n"

    new_conf = raw
    new_conf = set_directive(new_conf, "write_enable", "YES" if write_enable else "NO")
    new_conf = set_directive(new_conf, "anonymous_enable", "YES" if anonymous_enable else "NO")
    new_conf = set_directive(new_conf, "chroot_local_user", "YES" if chroot_local_user else "NO")
    new_conf = set_directive(new_conf, "allow_writeable_chroot", "YES")
    new_conf = set_directive(new_conf, "pasv_enable", "YES")
    new_conf = set_directive(new_conf, "pasv_min_port", str(pasv_min_port))
    new_conf = set_directive(new_conf, "pasv_max_port", str(pasv_max_port))

    ok, msg = save_vsftpd_raw_conf(new_conf)
    if not ok:
        raise HTTPException(status_code=500, detail=msg)
    return {"status": True, "message": "Настройки FTP успешно обновлены и применены!"}

@app.get("/api/ftp/config")
async def get_ftp_config(user: str = Depends(require_auth)):
    return {"content": get_vsftpd_raw_conf()}

@app.post("/api/ftp/config")
async def save_ftp_config(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    content = data.get("content", "")
    if not content.strip():
        raise HTTPException(status_code=400, detail="Конфигурация не может быть пустой")
    ok, msg = save_vsftpd_raw_conf(content)
    if not ok:
        raise HTTPException(status_code=500, detail=msg)
    return {"status": True, "message": msg}

@app.post("/api/ftp/test")
async def test_ftp_endpoint(request: Request, user: str = Depends(require_auth)):
    data = await request.json()
    test_user = data.get("username", "grinronn").strip()
    test_pass = data.get("password", "").strip()

    start_time = time.time()
    try:
        ftp = ftplib.FTP()
        conn_msg = ftp.connect("127.0.0.1", 21, timeout=5)
        banner = ftp.getwelcome()
        login_res = ""
        sample_files = []
        if test_user:
            login_res = ftp.login(test_user, test_pass)
            try:
                sample_files = ftp.nlst()[:8]
            except Exception:
                pass
        ftp.quit()
        elapsed = round((time.time() - start_time) * 1000)
        return {
            "status": True,
            "banner": banner,
            "conn_msg": conn_msg,
            "login_res": login_res,
            "sample_files": sample_files,
            "duration_ms": elapsed,
            "message": f"FTP подключение успешно выполнено за {elapsed} мс!"
        }
    except Exception as e:
        elapsed = round((time.time() - start_time) * 1000)
        return {
            "status": False,
            "error": str(e),
            "duration_ms": elapsed,
            "message": f"Ошибка подключения к FTP: {e}"
        }


# --- Interactive Web Terminal (xterm.js + PTY) ---
@app.websocket("/ws/terminal")
async def ws_terminal(websocket: WebSocket):
    await websocket.accept()
    token = websocket.cookies.get(COOKIE_NAME)
    valid = False
    if token:
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            if payload.get("sub"):
                valid = True
        except Exception:
            pass
    if not valid:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    try:
        pty_cmd = ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "/bin/bash", "-l"]
        pty_proc = ptyprocess.PtyProcessUnicode.spawn(pty_cmd, dimensions=(24, 80))
    except Exception as e:
        await websocket.send_text(f"\r\nОшибка запуска терминала: {e}\r\n")
        await websocket.close()
        return

    loop = asyncio.get_event_loop()

    async def pty_to_ws():
        try:
            while pty_proc.isalive():
                data = await loop.run_in_executor(None, pty_proc.read, 1024)
                if data:
                    await websocket.send_text(data)
        except Exception:
            pass

    async def ws_to_pty():
        try:
            while True:
                msg = await websocket.receive_text()
                if msg.startswith('{"type":"resize"'):
                    try:
                        r = json.loads(msg)
                        cols = int(r.get("cols", 80))
                        rows = int(r.get("rows", 24))
                        pty_proc.setwinsize(rows, cols)
                        continue
                    except Exception:
                        pass
                pty_proc.write(msg)
        except Exception:
            pass

    task1 = asyncio.create_task(pty_to_ws())
    task2 = asyncio.create_task(ws_to_pty())

    done, pending = await asyncio.wait(
        [task1, task2],
        return_when=asyncio.FIRST_COMPLETED
    )
    for p in pending:
        p.cancel()

    try:
        pty_proc.terminate(force=True)
    except Exception:
        pass

# Mount static files and SPA
static_dir = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(static_dir, exist_ok=True)
app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.get("/{full_path:path}")
async def serve_spa(full_path: str):
    index_file = os.path.join(static_dir, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    return HTMLResponse("<h1>ServerDeck starting...</h1>")
