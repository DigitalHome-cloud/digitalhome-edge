"""Stub sync-agent for Phase 1 side-by-side bring-up.

Freezes the Compose contract so the three-service layout is real from the
first bring-up. Real responsibilities land in Phase 5 (see plan file):
- boot-time cloud C-BOX pull for `homeId`
- deploy-triggered pull on `cbox_updated` push channel
- timeseries write to /data/timeseries/points.db + Parquet flush to S3

For now: log a heartbeat once a minute, honour SIGTERM cleanly.
"""

import os
import signal
import sys
import time

HOME_ID = os.getenv("HOME_ID", "DE-DEMO")
STARTED_AT = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def shutdown(signum, _frame):
    print(f"sync-agent: received signal {signum}, exiting")
    sys.stdout.flush()
    sys.exit(0)


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

print(f"sync-agent: stub started at {STARTED_AT} for homeId={HOME_ID}")
sys.stdout.flush()

interval_s = int(os.getenv("SYNC_AGENT_HEARTBEAT_S", "60"))
while True:
    time.sleep(interval_s)
    print(f"sync-agent: heartbeat homeId={HOME_ID}")
    sys.stdout.flush()
