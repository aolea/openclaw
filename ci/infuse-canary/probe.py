"""Trusted pre-candidate proof of the actual fresh Docker boundary."""
import json
import os
import pathlib
import socket
import subprocess

assert os.getuid() == 501 and os.getgid() == 501
assert sorted(os.environ) == ["HOME", "LC_ALL", "LOGNAME", "PATH", "USER"]
assert os.environ["HOME"] == "/work/home"
status = dict(line.split(":", 1) for line in pathlib.Path("/proc/self/status").read_text().splitlines() if ":" in line)
assert int(status["CapEff"].strip(), 16) == 0
assert int(status["CapBnd"].strip(), 16) == 0
assert status["NoNewPrivs"].strip() == "1"
for path in ["/var/run/docker.sock", "/run/docker.sock", "/github", "/home/runner", "/root/.ssh", "/root/.npmrc"]:
    try:
        assert not pathlib.Path(path).exists(), path
    except PermissionError:
        pass
assert pathlib.Path("/sys/fs/cgroup/memory.max").read_text().strip() == str(13 * 1024**3)
assert pathlib.Path("/sys/fs/cgroup/memory.swap.max").read_text().strip() == "0"
assert pathlib.Path("/sys/fs/cgroup/cpu.max").read_text().strip() == "400000 100000"
assert subprocess.check_output(["node", "--version"]).decode().strip() == "v24.21.0"
assert subprocess.check_output(["pnpm", "--version"]).decode().strip() == "12.5.1"
try:
    pathlib.Path("/harness/.write-probe").write_text("denied")
except OSError:
    pass
else:
    raise AssertionError("immutable harness was writable")
try:
    pathlib.Path("/input/source/.write-probe").write_text("denied")
except OSError:
    pass
else:
    raise AssertionError("source input was writable")
for host, port in [("172.31.253.1", 41239), ("169.254.169.254", 80)]:
    try:
        connection = socket.create_connection((host, port), timeout=2)
    except OSError:
        pass
    else:
        connection.close()
        raise AssertionError("host/metadata connection was admitted")
child = subprocess.check_output(["/usr/bin/env"])
assert b"TOKEN" not in child and b"GITHUB" not in child and b"ACTIONS" not in child
print(json.dumps({"uid": 501, "gid": 501, "capabilities": "none", "noNewPrivileges": True, "memoryBytes": 13 * 1024**3, "swapBytes": 0, "cpu": 4, "environment": sorted(os.environ), "hostCredentialsAndSocket": "absent-or-denied", "harnessWritable": False, "sourceInputWritable": False, "hostAndMetadataTcp": "denied", "node": "24.21.0", "pnpm": "12.5.1"}))
