"""Pytest wiring for workers/ocr (keystone plan Package 2).

The vendored packages in THIS directory (docx/, lxml/, typing_extensions.py) are manylinux
x86_64 / cp312 binaries for the Lambda runtime — lxml's .so files cannot import on
Windows/mac. Pin `docx` (and transitively its lxml dep) to the LOCAL site-packages install
BEFORE any test imports handler, then keep this directory importable so `import handler`
still resolves. handler.py imports docx lazily, so the pinned sys.modules entry wins
regardless of sys.path order at test time.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# Lambda-style env the handler reads at import/call time (boto3 clients need a region).
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
os.environ.setdefault("COMPACT_EMR_API_URL", "http://localhost:0")
os.environ.setdefault("INTERNAL_WORKER_TOKEN", "test-internal-worker-token")


def _is_here(path: str) -> bool:
    try:
        return os.path.abspath(path if path else os.getcwd()).lower() == HERE.lower()
    except OSError:
        return False


# 1) Make sure THIS directory does not shadow site-packages for docx/lxml.
sys.path[:] = [p for p in sys.path if not _is_here(p)]
for _name in [m for m in sys.modules if m.split(".", 1)[0] in ("docx", "lxml")]:
    del sys.modules[_name]
import docx  # noqa: E402,F401 — site-packages copy, pinned in sys.modules for handler's lazy import
import docx.table  # noqa: E402,F401

# 2) Re-add THIS directory (at the END) so `import handler` resolves.
sys.path.append(HERE)
