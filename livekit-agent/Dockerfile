FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# Install PyTorch CPU (needed for silero VAD + MultilingualModel turn detector)
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

RUN pip install --no-cache-dir -r requirements.txt

COPY agent.py .

# 'start' connects to LiveKit Cloud (vs 'dev' which is local)
CMD ["python", "agent.py", "start"]
