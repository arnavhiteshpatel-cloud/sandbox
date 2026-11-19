"""How common school and work sites are laid out, so the AI navigates them like someone who has used them before.

Matched on the page's address; the hint is added to the AI's context and to the result of opening the page.
Paths are relative to the site you're on (e.g. your school's *.instructure.com), never guessed domains.
"""
from __future__ import annotations

import re

HINTS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"instructure\.com|canvas\.", re.I),
     "Canvas: the Dashboard shows a card per course (click the course name to open it). All courses: /courses. "
     "Inside a course (/courses/<id>): Assignments at /courses/<id>/assignments (homework, due dates), Modules at "
     "/courses/<id>/modules, Announcements, Grades at /courses/<id>/grades. Everything due soon: the To Do list on the "
     "Dashboard's right side, or /calendar. To find homework: open the course, then Assignments (or Modules)."),
    (re.compile(r"managebac\.com", re.I),
     "ManageBac: Classes in the left menu (one page per class). Inside a class: Tasks (assignments and due dates), "
     "Units, Files. Upcoming work for all classes: Tasks & Deadlines on the student dashboard."),
    (re.compile(r"classroom\.google\.com", re.I),
     "Google Classroom: the home page shows a card per class. Inside a class: Stream, Classwork (all assignments), People. "
     "All work due: the To-do page (/a/not-turned-in/all)."),
    (re.compile(r"schoology\.com", re.I),
     "Schoology: Courses menu at the top; inside a course: Materials (assignments), Updates, Grades. Upcoming work in the "
     "right sidebar of Home."),
    (re.compile(r"moodle", re.I),
     "Moodle: My courses at /my/courses.php; inside a course, sections list activities and assignments. Timeline block "
     "on the Dashboard shows what's due."),
    (re.compile(r"mail\.google\.com", re.I),
     "Gmail: search box at the top (from:, subject:, has:attachment); press c to compose, / to search."),
]


def hint_for(url: str | None) -> str | None:
    if not url:
        return None
    for rx, text in HINTS:
        if rx.search(url):
            return text
    return None
