"""Pack committed sources and Git history without local databases or secrets.

Usage: python scripts/package_coursework.py
The archive is written beside the project; it can be handed in without GitHub.
"""
from io import BytesIO
from pathlib import Path, PurePosixPath
import subprocess
from tempfile import TemporaryDirectory
import zipfile

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT.parent / "Смена-FastAPI-исходники.zip"
LOCAL_DIRECTORIES = {"data", ".venv", "venv", "node_modules", "__pycache__", "qa", ".pytest_cache",
                     ".sites", ".sites-runtime", ".wrangler", ".agents", ".codex", "work", "outputs"}
LOCAL_SUFFIXES = {".sqlite", ".sqlite3", ".sqlite-wal", ".sqlite-shm", ".db", ".db-wal", ".db-shm",
                  ".bak", ".pem", ".key", ".pyc", ".pyo"}


def git(*arguments):
    return subprocess.check_output(["git", *arguments], cwd=ROOT)


def check_path(name):
    path = PurePosixPath(name)
    if any(part.lower() in LOCAL_DIRECTORIES for part in path.parts) or path.name.lower().startswith(".env") or path.suffix.lower() in LOCAL_SUFFIXES:
        raise SystemExit(f"В исходниках или истории Git найден локальный или чувствительный файл: {name}. Архив не создан.")


def main():
    # Refuse a stale hand-in: the archive must match a reproducible Git commit.
    if git("status", "--porcelain").strip():
        raise SystemExit("Сначала сохраните изменения в Git: git add <файлы> и git commit.")
    commit = git("rev-parse", "HEAD").decode().strip()
    # The bundle includes older commits and every branch/tag, not just HEAD.
    # Check their object paths too, including files deleted from today's tree.
    for entry in git("rev-list", "--objects", "HEAD", "--branches", "--tags").decode("utf-8").splitlines():
        if " " in entry:
            check_path(entry.split(" ", 1)[1])
    archive = git("archive", "--format=zip", "--prefix=smena/", "HEAD")
    with zipfile.ZipFile(BytesIO(archive)) as check:
        for name in check.namelist():
            check_path(name)
    # A bundle contains Git objects and history, but no remote credentials/config.
    with TemporaryDirectory(prefix="smena-package-") as directory:
        bundle = Path(directory) / "smena-history.bundle"
        git("bundle", "create", str(bundle), "HEAD", "--branches", "--tags")
        staged_archive = Path(directory) / OUTPUT.name
        staged_archive.write_bytes(archive)
        with zipfile.ZipFile(staged_archive, "a", compression=zipfile.ZIP_DEFLATED) as result:
            result.write(bundle, "smena/smena-history.bundle")
            result.writestr("smena/СДАЧА-ПРОЕКТА.txt", (
                "СМЕНА — исходники приложения FastAPI\n\n"
                f"Версия исходников: {commit}\n"
                "Запуск на Windows: Запустить.cmd, затем http://127.0.0.1:8000\n"
                "Подробная инструкция: README.txt.\n"
                "API: /docs и /redoc. Проверки: python -m pytest tests_python -q\n\n"
                "В архиве нет аккаунтов, базы рабочего времени или ключей.\n"
                "При первом запуске создайте пароль администратора Adilium.\n"
                "smena-history.bundle содержит историю разработки Git.\n"
                "Для просмотра истории: git clone smena-history.bundle smena-history\n"
                "Затем: git -C smena-history log --oneline\n"
                "Для проверки bundle: git bundle verify smena-history.bundle\n"
                "Пояснительная записка сдаётся отдельно.\n"
            ))
        # Do not replace a previous good hand-in until packaging has completed.
        import shutil
        shutil.copyfile(staged_archive, OUTPUT)
    print(str(OUTPUT))
    print(f"Git commit: {commit}; archive size: {OUTPUT.stat().st_size} bytes")


if __name__ == "__main__":
    main()
