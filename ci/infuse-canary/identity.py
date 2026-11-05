"""Trusted source inspector; never imports candidate code or follows source symlinks."""
import hashlib
import json
import os
import pathlib
import stat
import subprocess
import sys


def safe_bytes(root, relative):
    if not stat.S_ISDIR(root.lstat().st_mode):
        raise ValueError("source root is not a real directory")
    parts = pathlib.PurePosixPath(relative).parts
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise ValueError("unsafe tracked path")
    parent = root
    for part in parts[:-1]:
        parent = parent / part
        if not stat.S_ISDIR(parent.lstat().st_mode):
            raise ValueError("tracked parent is not a real directory: " + relative)
    path = root / relative
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        return "120000", os.fsencode(os.readlink(path))
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("tracked entry is not a file: " + relative)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("tracked entry changed during open")
        data = stream.read()
    return ("100755" if info.st_mode & stat.S_IXUSR else "100644"), data


def snapshot(root, paths):
    if not stat.S_ISDIR(root.lstat().st_mode):
        raise ValueError("source root is not a real directory")
    digest = hashlib.sha256()
    size = 0
    for relative in paths:
        mode, data = safe_bytes(root, relative)
        digest.update(os.fsencode(relative) + b"\0" + mode.encode("ascii") + b"\0" + data + b"\0")
        size += len(data)
    return {"sha256": digest.hexdigest(), "paths": len(paths), "bytes": size}


def git(root, *args):
    return subprocess.check_output(["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", str(root), *args])


def verify(root, binding, paths):
    result = snapshot(root, paths)
    assert result == {"sha256": binding["sourceSha256"], "paths": binding["sourcePaths"], "bytes": binding["sourceBytes"]}, result
    lock = safe_bytes(root, "pnpm-lock.yaml")[1]
    assert hashlib.sha256(lock).hexdigest() == binding["pnpmLockSha256"]
    return result


if __name__ == "__main__":
    root = pathlib.Path(sys.argv[1]).absolute()
    if not stat.S_ISDIR(root.lstat().st_mode):
        raise ValueError("source root is not a real directory")
    binding = json.loads(pathlib.Path("/harness/binding.json").read_text())
    assert git(root, "rev-parse", "HEAD").decode().strip() == binding["candidateCommit"]
    assert git(root, "merge-base", binding["baseCommit"], "HEAD").decode().strip() == binding["baseCommit"]
    assert git(root, "status", "--porcelain=v1", "--untracked-files=normal") == b""
    paths = sorted(os.fsdecode(item) for item in git(root, "ls-files", "-z").split(b"\0") if item)
    result = verify(root, binding, paths)
    pathlib.Path(sys.argv[2]).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
