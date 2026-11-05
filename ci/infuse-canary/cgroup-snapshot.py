"""Trusted step resource witness; reads only this container's public cgroup counters."""
import datetime
import json
import os
import pathlib
import re
import stat
import sys
import tempfile

label, phase = sys.argv[1:]
assert re.fullmatch(r"[a-z0-9-]+", label) and phase in ["before", "after"]
root = pathlib.Path("/work/evidence/cgroup")
root.mkdir(exist_ok=True)
for directory in [root.parent.parent, root.parent, root]:
    assert stat.S_ISDIR(directory.lstat().st_mode), "resource evidence parent is not a real directory"
cgroup = pathlib.Path("/sys/fs/cgroup")
events = {}
for line in (cgroup / "memory.events").read_text().splitlines():
    key, value = line.split()
    assert key not in events and value.isdigit()
    events[key] = int(value)
maximum = int((cgroup / "memory.max").read_text())
swap = int((cgroup / "memory.swap.max").read_text())
assert maximum == 13 * 1024**3 and swap == 0
record = {"schemaVersion": 1, "step": label, "phase": phase,
          "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
          "memoryEvents": events, "memoryPeakBytes": int((cgroup / "memory.peak").read_text()),
          "memoryCurrentBytes": int((cgroup / "memory.current").read_text()),
          "memoryMaxBytes": maximum, "swapMaxBytes": swap,
          "scope": "whole task container; peak is cumulative, event deltas cover the named step"}
fd, temporary = tempfile.mkstemp(prefix="cgroup-", suffix=".json", dir="/work/tmp")
try:
    # Only public resource counters are recorded; the host collector is not UID501.
    os.fchmod(fd, 0o644)
    with os.fdopen(fd, "w") as stream:
        json.dump(record, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, root / (label + "-" + phase + ".json"))
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
