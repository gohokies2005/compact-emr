import os
import sys

# Ensure the assembler dir (vendored pypdf + pycryptodome + assemble.py) is importable when pytest
# runs from the repo root or anywhere else.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# Never COLLECT tests from the vendored packages: pycryptodome ships its own Crypto/SelfTest suite,
# and the vendored binaries are manylinux (Lambda) — importing them on Windows/mac OSErrors at
# collection time and takes the whole run down.
collect_ignore = ["Crypto", "pypdf"]
