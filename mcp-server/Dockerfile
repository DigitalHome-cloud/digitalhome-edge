FROM python:3.12-slim

RUN groupadd --gid 1000 dhe && useradd --uid 1000 --gid dhe --shell /usr/sbin/nologin --create-home dhe

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.txt

COPY server.py ./

USER dhe

EXPOSE 8443

ENV DHE_MCP_HOST=0.0.0.0 \
    DHE_MCP_PORT=8443 \
    DHE_CONFIG_CACHE=/config/dhe.config.cache \
    PYTHONUNBUFFERED=1

CMD ["python", "server.py"]
