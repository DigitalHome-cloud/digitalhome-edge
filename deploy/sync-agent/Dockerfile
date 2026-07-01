FROM python:3.12-slim

RUN groupadd --gid 1000 dhe && useradd --uid 1000 --gid dhe --shell /usr/sbin/nologin --create-home dhe

WORKDIR /app

COPY sync-agent.py ./
USER dhe

ENV PYTHONUNBUFFERED=1

CMD ["python", "sync-agent.py"]
