#!/bin/bash
# Kill ALL agent processes (main + forked children) then restart
echo "→ Killing all agent.py processes..."
pkill -9 -f "agent.py" 2>/dev/null
sleep 1

# Verify clean
REMAINING=$(pgrep -f "agent.py" | wc -l | tr -d ' ')
if [ "$REMAINING" -gt 0 ]; then
  echo "⚠️  Still $REMAINING process(es) running, force killing..."
  pkill -9 -f "python3.*agent" 2>/dev/null
  sleep 1
fi

echo "→ Starting fresh agent..."
python3 agent.py dev
