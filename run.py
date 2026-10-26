"""Запуск Python-сервера «Смена»: python run.py."""

import argparse
import os
from pathlib import Path
import sys


def main() -> None:
    if sys.version_info < (3, 10):
        raise SystemExit("Для запуска нужен Python 3.10 или новее.")

    parser = argparse.ArgumentParser(description="Смена — сервер FastAPI")
    parser.add_argument("--host", default=os.getenv("SMENA_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=os.getenv("SMENA_PORT", "8000"))
    parser.add_argument("--reload", action="store_true", help="Перезапуск при правке Python-кода")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Порт должен быть числом от 1 до 65535.")

    try:
        import uvicorn
    except ImportError:
        raise SystemExit("Установите зависимости: python -m pip install -r requirements.txt") from None

    os.chdir(Path(__file__).resolve().parent)
    uvicorn.run(
        "backend.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        proxy_headers=True,
        forwarded_allow_ips=os.getenv("SMENA_PROXY_IPS", "127.0.0.1"),
    )


if __name__ == "__main__":
    main()
