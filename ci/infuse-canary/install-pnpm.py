import base64
import hashlib
import io
import os
import pathlib
import tarfile
import urllib.request

URL = "https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.15.0.tgz"
BYTES = 25056098
SHA256 = "402f7045b1e0587acb1542f18d38afbccb6babf3c7451394e6fb3d9f0160c6ca"
INTEGRITY = "sha512-yc+QlZR+9+nr29J4fRzhMoapgxTBDndq/+peyoq1XUufnQFnfbXUMFudDIKzHi545linGqmOmXfn0NoufNgcOg=="
with urllib.request.urlopen(URL, timeout=120) as response:
    archive = response.read()
assert len(archive) == BYTES
assert hashlib.sha256(archive).hexdigest() == SHA256
assert "sha512-" + base64.b64encode(hashlib.sha512(archive).digest()).decode("ascii") == INTEGRITY
with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
    member = package.getmember("package/pnpm")
    assert member.isfile()
    executable = package.extractfile(member).read()
assert executable[:4] == b"\x7fELF"
path = pathlib.Path("/opt/pnpm/pnpm")
path.parent.mkdir(parents=True, exist_ok=True)
path.write_bytes(executable)
os.chmod(path, 0o755)
os.symlink(path, "/usr/local/bin/pnpm")
print("Verified official pnpm 12.15.0 Linux x64 archive and installed native executable.")
