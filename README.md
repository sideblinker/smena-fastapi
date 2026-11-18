# Смена — учёт рабочего времени

Курсовой проект по дисциплине «Веб-программирование»: приложение для учёта смен, перерывов и отсутствий сотрудников.

## Возможности

- Вход администратора и сотрудников, разграничение доступа на сервере.
- Начало и завершение смен, учёт перерывов, исправление времени с записью причины.
- Управление сотрудниками, правами и рабочими графиками.
- Заявки на отпуск и отгул с одобрением или отклонением администратором.
- Календарь, табель, отчёты, экспорт и журнал действий.
- Поиск, SQL-пагинация, валидация запросов и защита от одновременного редактирования.

## Технологии

Python 3.10+, FastAPI, Uvicorn, SQLAlchemy, SQLite, Pydantic, Jinja2, HTML, CSS и JavaScript. Аутентификация — OAuth2/JWT и Passlib. Страницы формируются на сервере.

## Запуск на Windows

1. Установите Python 3.10 или новее.
2. Скачайте репозиторий или клонируйте его:

```shell
git clone https://github.com/sideblinker/smena-fastapi.git
cd smena-fastapi
```

3. Запустите `Запустить.cmd` или выполните в PowerShell:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe run.py
```

4. Откройте http://127.0.0.1:8000.
5. При первом запуске задайте пароль администратора `Adilium` (10–128 символов), затем добавьте сотрудников.

На Linux/macOS используйте `python3 -m venv .venv` и `.venv/bin/python` вместо Windows-путей.

База SQLite и ключ подписи создаются локально в `data/`. Аккаунты, рабочая база и секреты в репозиторий не включены. Для FastAPI-версии Node.js не требуется.

## Документация API и тесты

- Swagger UI: http://127.0.0.1:8000/docs
- ReDoc: http://127.0.0.1:8000/redoc
- OpenAPI: http://127.0.0.1:8000/openapi.json

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest tests_python -q
```

Для проверки интерфейса с помощью Node.js выполните

```powershell
node --test tests/frontend.test.cjs tests/daily-progress.test.cjs tests/shift-editor.test.cjs
```

18.11.2026 прошли 116 серверных тестов и 9 тестов интерфейса.

## Структура

| Путь | Назначение |
| --- | --- |
| `backend/main.py` | Приложение FastAPI |
| `backend/models.py` | Модели SQLAlchemy |
| `backend/schemas/` | Схемы Pydantic |
| `backend/routers/` | API и серверные страницы |
| `backend/templates/` | Шаблоны Jinja2 |
| `public/` | CSS, JavaScript, шрифты и изображения |
| `tests_python/` | Автоматические тесты |
| `run.py` | Запуск сервера |

Подробная инструкция — в [README.txt](README.txt). В истории и дереве проекта сохранены файлы предыдущей JavaScript/Sites-версии (`app/`, `src/server/`, `build/` и другие). Актуальная курсовая версия запускается через `run.py` и использует `backend/`.

Этот репозиторий публикует исходный код. Для работы сайта сервер FastAPI запускается отдельно; GitHub Pages не исполняет Python.
