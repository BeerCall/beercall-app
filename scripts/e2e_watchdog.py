"""Independent Docker-side guard: stop only this disposable project on lease loss.

Runs with a read-only bind of the parent's heartbeat and the local Docker socket.
No network, credentials, images or volumes are deleted by this guard.
"""
import http.client
import json
from pathlib import Path
import re
import socket
import sys
import time
import urllib.parse

project = sys.argv[1]
if not re.fullmatch(r"beercall-release-e2e-[0-9a-f]{10}", project):
    raise SystemExit("Not an owned release-test project")
lease = Path("/lease/heartbeat")
deadline = time.monotonic() + 1200

def request(method, path):
    connection = http.client.HTTPConnection("localhost", timeout=8)
    transport = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    transport.settimeout(8)
    transport.connect("/var/run/docker.sock")
    connection.sock = transport
    try:
        connection.request(method, "/v1.44" + path)
        response = connection.getresponse()
        payload = response.read()
        if response.status >= 400:
            raise RuntimeError(f"Docker guard HTTP {response.status}")
        return json.loads(payload) if payload else None
    finally:
        connection.close()

filters = urllib.parse.quote(json.dumps({"label": [f"com.docker.compose.project={project}"]}))
while time.monotonic() < deadline:
    if not lease.exists() or time.time() - lease.stat().st_mtime > 20:
        break
    time.sleep(3)
print("E2E lease ended: stopping owned test containers", flush=True)
for container in request("GET", "/containers/json?filters=" + filters):
    request("POST", "/containers/" + container["Id"] + "/stop?t=3")
print("E2E watchdog done", flush=True)
