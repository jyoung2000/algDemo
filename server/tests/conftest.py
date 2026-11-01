import os
import tempfile

# Keep tests away from the demo's real database and logs.
os.environ.setdefault("AIRWAVE_DISCOVERY_DATA", tempfile.mkdtemp(prefix="airwave-discovery-test-"))
