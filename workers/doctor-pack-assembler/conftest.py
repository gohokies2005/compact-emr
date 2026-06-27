import os
import sys

# Ensure the assembler dir (vendored pypdf + assemble.py) is importable when pytest runs from the
# repo root or anywhere else.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
