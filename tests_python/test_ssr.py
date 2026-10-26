"""Primary pages must contain database-backed HTML before JavaScript runs."""
import html
import json
import re

import pytest


def page(env, path="/"):
    response = env.client.get(path)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["cache-control"] == "no-store"
    return response.text


def section(document, name):
    return document.split(f'<section id="view-{name}"', 1)[1].split('</section>', 1)[0]


def bootstrap(document):
    return json.loads(re.search(r'<script id="smena-bootstrap" type="application/json">(.*?)</script>', document, re.S)[1])


def add_shift(env, user_id, day, note="Рабочая запись"):
    from datetime import datetime
    start = int(datetime.fromisoformat(f"2026-10-{day:02d}T09:00:00+05:00").timestamp() * 1000)
    response = env.request("POST", "/api/shifts", json={"userId": user_id, "startedAt": start, "endedAt": start + 8 * 3600000, "breaks": [], "note": note})
    assert response.status_code == 201, response.text
    return response.json()["shift"]


@pytest.mark.parametrize("view", ["overview", "history", "employees", "calendar", "requests", "reports", "timesheet", "audit"])
def test_each_primary_view_renders_without_client_fetches(env, view):
    document = page(env, f"/?view={view}")
    assert re.search(f'<section id="view-{view}"[^>]*>', document)
    assert " hidden" not in document.split(f'<section id="view-{view}"', 1)[1].split('>', 1)[0]
    assert 'href="/?view=history' in document
    assert bootstrap(document)["view"] == view
    assert "password_hash" not in document
    assert "jwt_secret" not in document


def test_employee_rows_search_and_real_paging_links(env):
    first = env.employee("alpha")
    second = env.employee("beta")
    document = page(env, "/?view=employees&search=Сотрудник&pageSize=1")
    table = document.split('<div id="employees-table">', 1)[1].split('</section>', 1)[0]
    assert first["name"] in table
    assert second["name"] not in table
    assert 'name="search" value="Сотрудник"' in document
    next_url = html.unescape(re.search(r'href="([^"]+)" rel="next"', table)[1])
    next_doc = page(env, next_url)
    next_table = next_doc.split('<div id="employees-table">', 1)[1].split('</section>', 1)[0]
    assert second["name"] in next_table
    assert bootstrap(next_doc)["employees"]["pagination"]["page"] == 2


def test_history_values_and_pagination_come_from_sql(env):
    owner = env.employee()
    older = add_shift(env, owner["id"], 20, "Первая запись")
    newer = add_shift(env, owner["id"], 21, "Вторая запись")
    document = page(env, f'/?view=history&userId={owner["id"]}&from=2026-10-01&to=2026-10-25&status=finished&pageSize=1')
    history = section(document, "history")
    assert newer["id"] in history and older["id"] not in history
    assert "Вторая запись" in history and "8 ч 00 мин" in history
    next_url = html.unescape(re.search(r'href="([^"]+)" rel="next"', history)[1])
    assert "status=finished" in next_url and "from=2026-10-01" in next_url
    assert older["id"] in section(page(env, next_url), "history")


def test_employee_names_and_shift_notes_are_escaped_in_html_and_bootstrap(env):
    owner = env.employee()
    note = '<img src=x onerror="alert(1)"> & <script>bad</script>'
    add_shift(env, owner["id"], 20, note)
    document = page(env, f'/?view=history&userId={owner["id"]}')
    assert "<img src=x" not in document and "<script>bad</script>" not in document
    assert "&lt;img src=x" in section(document, "history")
    assert bootstrap(document)["history"]["shifts"][0]["note"] == note


def test_employee_cannot_render_other_employee_or_admin_views(env):
    owner = env.employee("own")
    other = env.employee("other")
    add_shift(env, other["id"], 20, "Чужая приватная смена")
    env.login("own")
    document = page(env)
    data = bootstrap(document)
    assert data["users"] == [data["session"]["user"]]
    assert data["dashboard"]["user"]["id"] == owner["id"]
    assert "Чужая приватная смена" not in document
    for path in [f'/?view=history&userId={other["id"]}', "/?view=employees", "/?view=audit", "/?view=timesheet&scope=all"]:
        assert env.client.get(path).status_code == 403


def test_unauthenticated_html_contains_no_database_records(env):
    env.employee("private")
    env.client.cookies.clear()
    document = page(env, "/index.html?view=employees")
    assert "Сотрудник private" not in document
    assert bootstrap(document)["session"]["user"] is None
    assert bootstrap(document)["users"] == []
    assert "С возвращением" in document


def test_leave_requests_are_server_rendered_and_filtered(env):
    response = env.request("POST", "/api/absence-requests", json={"startDate": "2026-11-01", "endDate": "2026-11-03", "type": "vacation", "note": "Семейная поездка"})
    assert response.status_code == 201, response.text
    document = page(env, "/?view=requests&status=pending")
    actual = section(document, "requests")
    assert "Семейная поездка" in actual
    assert "01.11.2026" in actual and "03.11.2026" in actual
    assert 'data-action="approve-request"' in actual
    assert 'method="get" action="/"' in actual
    assert "Семейная поездка" not in section(page(env, "/?view=requests&status=rejected"), "requests")


def test_attendance_reports_and_audit_have_actual_database_values(env):
    owner = env.employee("calendarworker")
    add_shift(env, owner["id"], 20)
    calendar = section(page(env, f'/?view=calendar&userId={owner["id"]}&month=2026-10'), "calendar")
    assert 'data-date="2026-10-20"' in calendar
    assert "Факт 8 ч 00 мин" in calendar
    report = section(page(env, f'/?view=reports&userId={owner["id"]}&from=2026-10-20&to=2026-10-20'), "reports")
    assert 'id="report-hours">8 ч 00 мин' in report
    assert 'id="report-count">1' in report
    timesheet = section(page(env, f'/?view=timesheet&userId={owner["id"]}&month=2026-10'), "timesheet")
    assert owner["name"] in timesheet and 'fact-total">8</td>' in timesheet
    audit = section(page(env, "/?view=audit"), "audit")
    assert "Добавлена смена" in audit and "Создан сотрудник" in audit


def test_admin_selector_and_navigation_preserve_selected_context_and_filters(env):
    from urllib.parse import urlencode
    first, second = env.employee("first"), env.employee("second")
    document = page(env, f'/?view=history&userId={first["id"]}&from=2026-10-01&to=2026-10-21&status=finished&page=3&pageSize=1')
    form = document.split('<form id="selected-user-form"', 1)[1].split('</form>', 1)[0]
    hidden_fields = dict(re.findall(r'<input type="hidden" name="([^"]+)" value="([^"]*)">', form))
    assert hidden_fields["from"] == "2026-10-01"
    assert hidden_fields["to"] == "2026-10-21"
    assert hidden_fields["status"] == "finished"
    assert hidden_fields["pageSize"] == "1" and "page" not in hidden_fields
    chosen = bootstrap(page(env, "/?" + urlencode({**hidden_fields, "userId": second["id"]})))
    assert chosen["dashboard"]["user"]["id"] == second["id"]
    assert chosen["filters"]["status"] == "finished"
    employee_url = html.unescape(re.search(r'data-view="employees" href="([^"]+)"', document)[1])
    team_document = page(env, employee_url)
    assert bootstrap(team_document)["userId"] == first["id"]
    employee_form = team_document.split('<form id="employee-filter-form"', 1)[1].split('</form>', 1)[0]
    assert f'name="userId" value="{first["id"]}"' in employee_form


@pytest.mark.parametrize("query", ["page=0", "pageSize=101", "view=unknown", "view=calendar&month=2026-13", "userId=invalid", "view=history&from=2026-10-26&to=2026-10-01", "view=history&status=rejected"])
def test_html_query_parameters_are_validated_by_pydantic(env, query):
    assert env.client.get("/?" + query).status_code == 422
