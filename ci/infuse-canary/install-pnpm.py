import base64
import hashlib
import io
import os
import pathlib
import tarfile
import urllib.request

URL = "https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.5.1.tgz"
INTEGRITY = "sha512-3PkUBYo5z4dgtlnTNIFj7QGpcDUAuqXz9WGVigPDCeccEnhGiRkWmA5102TmYJHtwJP3LfmE+ZF9PGeWhn8p9Q=="
with urllib.request.urlopen(URL, timeout=120) as response:
    archive = response.read()
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
print("Verified official pnpm 12.5.1 Linux x64 archive and installed native executable.")
