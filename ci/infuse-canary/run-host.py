"""Trusted disposable-runner owner. Candidate executables run only inside Docker."""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import tarfile
import tempfile
import threading

HARNESS = pathlib.Path(__file__).resolve().parent
binding = json.loads((HARNESS / "binding.json").read_text())
spec = importlib.util.spec_from_file_location("trusted_identity", HARNESS / "identity.py")
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)


def command(*args, capture=False, check=True):
    result = subprocess.run(list(args), check=check, stdout=subprocess.PIPE if capture else None, text=capture)
    return result.stdout.strip() if capture else result.returncode


def firewall(action, *args):
    command("sudo", "iptables", "-w", action, *args)


def sanitize(source, destination):
    """The stopped candidate cannot make an artifact action follow a host symlink."""
    for directory in [source.parent.parent, source.parent, source]:
        assert stat.S_ISDIR(directory.lstat().st_mode), "artifact root/parent is not a real directory"
    destination.mkdir()
    total = 0
    entries = []
    allowed = {".tgz", ".json", ".log", ".md", ".txt", ".tsv"}
    for directory, subdirs, files in os.walk(source, followlinks=False):
        for name in subdirs:
            assert stat.S_ISDIR((pathlib.Path(directory) / name).lstat().st_mode), "artifact directory symlink"
        for name in files:
            path = pathlib.Path(directory) / name
            info = path.lstat()
            assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "artifact is not a regular single-link file"
            assert path.suffix in allowed, "unexpected artifact extension"
            total += info.st_size
            assert total <= 336 * 1024**2, "candidate artifacts exceed 336 MiB ceiling; 64 MiB reserved for trusted failure/output evidence"
            relative = path.relative_to(source)
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "rb", opener=lambda p, flags: os.open(p, flags | os.O_NOFOLLOW)) as stream:
                with target.open("xb") as output:
                    digest = hashlib.sha256()
                    while data := stream.read(1024 * 1024):
                        digest.update(data)
                        output.write(data)
            entries.append({"path": str(relative), "bytes": info.st_size, "sha256": digest.hexdigest()})
    (destination / "artifact-index.json").write_text(json.dumps({"totalBytes": total, "files": sorted(entries, key=lambda item: item["path"])}, indent=2) + "\n")


def retain_failure(output, task, error):
    """Retain only trusted-owned bytes when source/collector/package guards refuse."""
    record = {"binding": binding, "passed": False, "errorType": type(error).__name__, "error": str(error)[:4096]}
    (output / "trusted-runner-failure.json").write_text(json.dumps(record, indent=2) + "\n")
    log = task / "docker-output.log"
    if log.exists():
        # Failed collectors never follow candidate paths, and retention stays bounded.
        with log.open("rb") as stream:
            stream.seek(max(0, log.stat().st_size - 4 * 1024**2))
            data = stream.read()
        used = sum(path.stat().st_size for path in output.rglob("*") if path.is_file())
        remaining = max(0, 400 * 1024**2 - used - 32768)
        if remaining:
            (output / "trusted-docker-failure-tail.log").write_bytes(data[-remaining:])


def verify_packages(root):
    core = root / "packages/core/openclaw-2026.10.2-7494b64ee3.tgz"
    with tarfile.open(core, "r:gz") as package:
        manifest = json.load(package.extractfile("package/package.json"))
        info = json.load(package.extractfile("package/dist/build-info.json"))
    assert manifest["name"] == "openclaw" and manifest["version"] == binding["version"]
    assert info["version"] == binding["version"] and info["commit"] == binding["candidateCommit"] and info["builtAt"] == binding["buildTimestamp"]
    for plugin in binding["plugins"]:
        files = list((root / "packages/plugins" / plugin).glob("*.tgz"))
        assert len(files) == 1, "missing or ambiguous plugin tarball: " + plugin
        with tarfile.open(files[0], "r:gz") as package:
            manifest = json.load(package.extractfile("package/package.json"))
            assert manifest["name"] == "@openclaw/" + plugin
            assert manifest["version"] == binding["version"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    args = parser.parse_args()
    assert os.environ["GITHUB_REPOSITORY"] == binding["repository"]
    assert os.environ["GITHUB_REF"] == "refs/heads/" + binding["bootstrapBranch"]
    event = json.loads(pathlib.Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    assert event["repository"]["private"] is False
    assert event["repository"]["full_name"] == binding["repository"]
    source = pathlib.Path(args.source).absolute()
    assert source == pathlib.Path(os.environ["GITHUB_WORKSPACE"]).absolute() / "candidate-source"
    assert stat.S_ISDIR(source.lstat().st_mode), "source root is not a real directory"
    assert identity.git(source, "rev-parse", "HEAD").decode().strip() == binding["candidateCommit"]
    assert identity.git(source, "merge-base", binding["baseCommit"], "HEAD").decode().strip() == binding["baseCommit"]
    assert identity.git(source, "status", "--porcelain=v1", "--untracked-files=normal") == b""
    credentials = subprocess.run(["git", "-C", str(source), "config", "--local", "--get-regexp", r"^(http\..*extraheader|credential\..*|core\.sshCommand)$"], stdout=subprocess.DEVNULL)
    assert credentials.returncode == 1, "checkout contains credential/command overrides"
    paths = sorted(os.fsdecode(item) for item in identity.git(source, "ls-files", "-z").split(b"\0") if item)
    before = identity.verify(source, binding, paths)
    task = pathlib.Path(tempfile.mkdtemp(prefix="infuse-canary-", dir=os.environ["RUNNER_TEMP"]))
    work = task / "work"
    work.mkdir()
    command("sudo", "chown", "501:501", str(work))
    name = "infuse-canary-" + secrets.token_hex(6)
    network = name + "-net"
    chain = "IC" + secrets.token_hex(5).upper()
    image = name + ":tools"
    sentinel = None
    container_created = False
    network_created = False
    chain_created = False
    output = pathlib.Path(os.environ["GITHUB_WORKSPACE"]) / "canary-artifacts"
    assert not output.exists()
    output.mkdir()
    result = 1
    token = secrets.token_hex(24)
    child = None
    def interrupted(signum, _frame):
        raise KeyboardInterrupt("host owner interrupted: " + str(signum))
    signal.signal(signal.SIGTERM, interrupted)
    try:
        command("docker", "build", "--platform", "linux/amd64", "--tag", image, str(HARNESS))
        command("docker", "network", "create", "--driver", "bridge", "--subnet", "172.31.253.0/28", "--opt", "com.docker.network.bridge.enable_icc=false", network)
        network_created = True
        network_info = json.loads(command("docker", "network", "inspect", network, capture=True))[0]
        assert network_info["EnableIPv6"] is False
        ipam = network_info["IPAM"]["Config"]
        assert len(ipam) == 1 and ipam[0]["Subnet"] == "172.31.253.0/28" and ipam[0]["Gateway"] == "172.31.253.1"
        sentinel = socket.socket()
        sentinel.bind(("172.31.253.1", 41239))
        sentinel.listen(4)
        def serve():
            while True:
                try:
                    client, _ = sentinel.accept()
                except OSError:
                    return
                with client:
                    client.sendall(b"trusted-host-sentinel\n")
        threading.Thread(target=serve, daemon=True).start()
        with socket.create_connection(("172.31.253.1", 41239), timeout=2) as client:
            assert client.recv(100) == b"trusted-host-sentinel\n"
        firewall("-N", chain)
        chain_created = True
        for destination in ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4", "168.63.129.16/32"]:
            firewall("-A", chain, "-d", destination, "-j", "REJECT")
        firewall("-A", chain, "-p", "tcp", "-m", "multiport", "--dports", "80,443", "-j", "RETURN")
        firewall("-A", chain, "-p", "udp", "--dport", "53", "-j", "RETURN")
        firewall("-A", chain, "-p", "tcp", "--dport", "53", "-j", "RETURN")
        firewall("-A", chain, "-j", "REJECT")
        firewall("-I", "DOCKER-USER", "1", "-s", "172.31.253.0/28", "-j", chain)
        firewall("-I", "INPUT", "1", "-s", "172.31.253.0/28", "-j", "REJECT")
        command("docker", "create", "--name", name, "--platform", "linux/amd64", "--init", "--user", "501:501", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--memory", "13g", "--memory-swap", "13g", "--cpus", "4", "--pids-limit", "2048", "--read-only", "--network", network, "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g,uid=501,gid=501", "--mount", "type=bind,src=" + str(source) + ",dst=/input/source,readonly", "--mount", "type=bind,src=" + str(work) + ",dst=/work", image)
        container_created = True
        metadata = json.loads(command("docker", "inspect", name, capture=True))[0]
        assert metadata["Config"]["User"] == "501:501"
        assert metadata["HostConfig"]["CapDrop"] == ["ALL"] and metadata["HostConfig"]["Privileged"] is False
        assert metadata["HostConfig"]["SecurityOpt"] == ["no-new-privileges=true"]
        assert metadata["HostConfig"]["PortBindings"] == {}
        assert sorted((item["Destination"], item["RW"]) for item in metadata["Mounts"] if item["Type"] == "bind") == [("/input/source", False), ("/work", True)]
        endpoint = metadata["NetworkSettings"]["Networks"][network]
        assert endpoint["GlobalIPv6Address"] == ""
        # Disable Actions command interpretation while untrusted candidate stdout is streamed.
        print("::stop-commands::" + token, flush=True)
        try:
            with (task / "docker-output.log").open("w") as log:
                child = subprocess.Popen(["docker", "start", "--attach", name], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                captured_bytes = 0
                for line in child.stdout:
                    captured_bytes += len(line.encode("utf-8"))
                    assert captured_bytes <= 64 * 1024**2, "candidate stdout exceeds 64 MiB ceiling"
                    print(line, end="", flush=True)
                    log.write(line)
                result = child.wait()
        finally:
            print("::" + token + "::", flush=True)
        state = json.loads(command("docker", "inspect", name, capture=True))[0]["State"]
        assert state["Running"] is False
        assert result == state["ExitCode"]
        # No Git invocation on the mutable execution tree: hashing uses captured trusted paths.
        after = identity.verify(work / "source", binding, paths)
        assert identity.verify(source, binding, paths) == before
        sanitized = output / "candidate"
        sanitize(work / "evidence", sanitized)
        artifact_bytes = sum(path.stat().st_size for path in output.rglob("*") if path.is_file())
        assert artifact_bytes + (task / "docker-output.log").stat().st_size + 32768 <= 400 * 1024**2, "complete temporary artifact payload exceeds 400 MiB ceiling"
        shutil.copyfile(task / "docker-output.log", output / "docker-output.log")
        (output / "trusted-runner-summary.json").write_text(json.dumps({"binding": binding, "sourceBefore": before, "sourceAfter": after, "containerExitCode": state["ExitCode"], "oomKilled": state["OOMKilled"], "hostSentinelPositiveControl": True, "hostFirewall": "container-to-host/private/link-local denied; public HTTP(S)/DNS only", "bootstrapCommit": os.environ["GITHUB_SHA"]}, indent=2) + "\n")
        if result == 0:
            verify_packages(sanitized)
        else:
            raise RuntimeError("candidate verification failed with exit " + str(result))
        assert sum(path.stat().st_size for path in output.rglob("*") if path.is_file()) <= 400 * 1024**2, "complete temporary artifact payload exceeds 400 MiB ceiling"
    except BaseException as error:
        retain_failure(output, task, error)
        raise
    finally:
        if container_created:
            command("docker", "rm", "--force", name, check=False)
        if child is not None and child.poll() is None:
            child.terminate()
            child.wait(timeout=10)
        if sentinel is not None:
            sentinel.close()
        if chain_created:
            command("sudo", "iptables", "-w", "-D", "INPUT", "-s", "172.31.253.0/28", "-j", "REJECT", check=False)
            command("sudo", "iptables", "-w", "-D", "DOCKER-USER", "-s", "172.31.253.0/28", "-j", chain, check=False)
            command("sudo", "iptables", "-w", "-F", chain, check=False)
            command("sudo", "iptables", "-w", "-X", chain, check=False)
        if network_created:
            command("docker", "network", "rm", network, check=False)


if __name__ == "__main__":
    main()
