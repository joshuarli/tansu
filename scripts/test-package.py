import json
import os
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / ".work" / "tmp"
SOURCE_ALPHA = "# Package runtime\n\nSaved aurorapackagestageone content.\n"
SOURCE_BETA = "# Package runtime\n\nSaved aurorapackagestagetwo content.\n"
HASH_ALPHA = "blake3-v3:c14067cceb1fb44c7449423480b6f61e3c3bd0cb4651d99765a8cc0d649550de"
HASH_BETA = "blake3-v3:9f848c8c407f8614e21da90a2ac995d9bb639a6f39deac30b63a58159dcfaa2c"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def get_json(opener, url, headers=None, body=None, method=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", **(headers or {})},
        method=method,
    )
    with opener.open(request, timeout=10) as response:
        return json.loads(response.read())


def wait_for_server(process, opener, base_url):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if process.poll() is not None:
            details = process.stderr.read().decode(errors="replace")
            raise RuntimeError(f"release binary exited during startup with {process.returncode}: {details}")
        try:
            health = get_json(opener, f"{base_url}/api/v2/health")
            if health.get("ok") is True and health.get("apiVersion") == 2:
                return
        except (OSError, urllib.error.URLError, TimeoutError):
            time.sleep(0.1)
    raise RuntimeError("release binary did not become healthy")


def stop_server(process):
    if process.poll() is None:
        process.send_signal(signal.SIGINT)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    if process.returncode != 0:
        details = process.stderr.read().decode(errors="replace")
        raise RuntimeError(f"release binary exited with {process.returncode}: {details}")


def available_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def start_server(binary, port, cwd, environment, opener):
    process = subprocess.Popen(
        [str(binary), "--port", str(port)],
        cwd=cwd,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    base_url = f"http://127.0.0.1:{port}"
    try:
        wait_for_server(process, opener, base_url)
    except Exception:
        if process.poll() is None:
            process.kill()
        process.wait()
        raise
    return process, base_url


def v2_headers(server_id):
    return {"X-Tansu-Server-Instance": server_id}


def open_document(opener, base_url, vault_id, note_id, headers):
    document = get_json(opener, f"{base_url}/api/v2/vaults/{vault_id}/notes/{note_id}", headers)
    require("content" in document and "meta" in document, "open note response was incomplete")
    return document


def save_document(opener, base_url, vault_id, document, headers, content, source_hash, mutation_id):
    meta = document["meta"]
    body = {
        "mutationId": mutation_id,
        "precondition": {
            "baseRevision": meta["revision"],
            "baseSourceHash": meta["sourceHash"],
            "baseDiskHash": meta["diskHash"],
        },
        "content": content,
        "sourceHash": source_hash,
    }
    response = get_json(
        opener,
        f"{base_url}/api/v2/vaults/{vault_id}/notes/{meta['noteId']}",
        headers,
        body,
        "PUT",
    )
    require(response.get("mutationId") == mutation_id, "save response did not match its mutation")


def search_for_path(opener, base_url, vault_id, headers, query, path):
    deadline = time.monotonic() + 20
    body = {"query": query, "mode": "default", "limit": 20, "overlays": []}
    while time.monotonic() < deadline:
        response = get_json(
            opener,
            f"{base_url}/api/v2/vaults/{vault_id}/search",
            headers,
            body,
            "POST",
        )
        if any(hit.get("path") == path for hit in response.get("hits", [])):
            return
        time.sleep(0.1)
    raise RuntimeError(f"saved note {path} did not appear in search for {query}")


def run(binary):
    require(binary.is_file() and os.access(binary, os.X_OK), f"release binary is not executable: {binary}")
    WORK.mkdir(parents=True, exist_ok=True)
    run_root = Path(tempfile.mkdtemp(prefix="test-package-", dir=WORK))
    try:
        home = run_root / "home"
        config_home = run_root / "config"
        data_home = run_root / "data"
        cache_home = run_root / "cache"
        temp_home = run_root / "tmp"
        cwd = run_root / "empty-cwd"
        empty_path = run_root / "empty-path"
        vault = run_root / "vault"
        for directory in (home, config_home, data_home, cache_home, temp_home, cwd, empty_path, vault):
            directory.mkdir()
        note_path = vault / "package.md"
        note_path.write_text("# Package runtime\n\nOriginal package source.\n")
        require(not (cwd / "web").exists(), "package working directory contains web assets")
        require(not (home / "d").exists(), "isolated home unexpectedly contains developer checkouts")
        require(not any(shutil.which(tool, path=str(empty_path)) for tool in ("node", "pnpm", "deno")), "package runtime PATH is not empty")
        environment = {
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(config_home),
            "XDG_DATA_HOME": str(data_home),
            "XDG_CACHE_HOME": str(cache_home),
            "TMPDIR": str(temp_home),
            "PATH": str(empty_path),
            "LANG": "C.UTF-8",
            "TANSU2_LOGS": "off",
        }
        subprocess.run(
            [str(binary), "config", "init", "--vault", "Package", str(vault)],
            cwd=cwd,
            env=environment,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        port = available_port()
        process, base_url = start_server(binary, port, cwd, environment, opener)
        try:
            with opener.open(f"{base_url}/", timeout=10) as response:
                shell = response.read()
                require(response.status == 200 and b"<html" in shell.lower(), "embedded app shell was not served")
            bootstrap = get_json(opener, f"{base_url}/api/v2/bootstrap")
            server_id = bootstrap["serverInstanceId"]
            require(bootstrap["apiVersion"] == 2 and len(bootstrap["vaults"]) == 1, "initial bootstrap was incomplete")
            vault_id = bootstrap["vaults"][0]["vaultId"]
            headers = v2_headers(server_id)
            vault_bootstrap = get_json(opener, f"{base_url}/api/v2/vaults/{vault_id}/bootstrap", headers)
            note = next(item for item in vault_bootstrap["notes"] if item["path"] == "package.md")
            document = open_document(opener, base_url, vault_id, note["noteId"], headers)
            require(document["content"] == "# Package runtime\n\nOriginal package source.\n", "initial note content did not open")
            save_document(opener, base_url, vault_id, document, headers, SOURCE_ALPHA, HASH_ALPHA, "package-save-alpha")
            document = open_document(opener, base_url, vault_id, note["noteId"], headers)
            require(document["content"] == SOURCE_ALPHA, "first saved content did not reopen")
            require(note_path.read_text() == SOURCE_ALPHA, "first save was not written to the vault")
            search_for_path(opener, base_url, vault_id, headers, "aurorapackagestageone", "package.md")
        finally:
            stop_server(process)

        process, base_url = start_server(binary, available_port(), cwd, environment, opener)
        try:
            bootstrap = get_json(opener, f"{base_url}/api/v2/bootstrap")
            require(bootstrap["serverInstanceId"] == server_id, "server identity changed after restart")
            require(bootstrap["vaults"][0]["vaultId"] == vault_id, "vault identity changed after restart")
            headers = v2_headers(server_id)
            document = open_document(opener, base_url, vault_id, note["noteId"], headers)
            require(document["content"] == SOURCE_ALPHA, "first save did not survive restart")
            search_for_path(opener, base_url, vault_id, headers, "aurorapackagestageone", "package.md")
            save_document(opener, base_url, vault_id, document, headers, SOURCE_BETA, HASH_BETA, "package-save-beta")
            document = open_document(opener, base_url, vault_id, note["noteId"], headers)
            require(document["content"] == SOURCE_BETA, "second saved content did not reopen")
            require(note_path.read_text() == SOURCE_BETA, "second save was not written to the vault")
            search_for_path(opener, base_url, vault_id, headers, "aurorapackagestagetwo", "package.md")
        finally:
            stop_server(process)

        process, base_url = start_server(binary, available_port(), cwd, environment, opener)
        try:
            bootstrap = get_json(opener, f"{base_url}/api/v2/bootstrap")
            require(bootstrap["serverInstanceId"] == server_id, "server identity changed after second restart")
            headers = v2_headers(server_id)
            document = open_document(opener, base_url, vault_id, note["noteId"], headers)
            require(document["content"] == SOURCE_BETA, "second save did not survive restart")
            search_for_path(opener, base_url, vault_id, headers, "aurorapackagestagetwo", "package.md")
        finally:
            stop_server(process)
        require(not list(cwd.iterdir()), "release binary wrote files into its working directory")
        require(not (run_root / "web").exists(), "package runtime tree unexpectedly contains web assets")
    finally:
        shutil.rmtree(run_root)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 scripts/test-package.py RELEASE_BINARY")
    run(Path(sys.argv[1]).resolve())
