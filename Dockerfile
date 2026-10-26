FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SMENA_HOST=0.0.0.0 \
    SMENA_PORT=8000

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && groupadd --gid 10001 smena \
    && useradd --uid 10001 --gid smena --no-create-home smena \
    && mkdir -p /app/data \
    && chown smena:smena /app/data

COPY --chown=smena:smena backend ./backend
COPY --chown=smena:smena public ./public
COPY --chown=smena:smena db/schema.sql ./db/schema.sql
COPY --chown=smena:smena run.py ./

USER smena
VOLUME ["/app/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/session', timeout=3)" || exit 1
CMD ["python", "run.py"]
