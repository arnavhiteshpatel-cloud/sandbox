import pytest

from jarvis.router import best_element_match, normalize, route, spoken_combo


@pytest.mark.parametrize("text,expected", [
    ("Hey JARVIS, open Arc.", "open arc"),
    ("Jarvis, open my I.B.", "open my ib"),
    ("jarvis open my i b please", "open my ib"),
    ("Could you please scroll down for me", "scroll down"),
    ("go to youtube.com", "go to youtube.com"),
])
def test_normalize(text, expected):
    assert normalize(text) == expected


@pytest.mark.parametrize("text,name,args", [
    ("JARVIS, open Spotify.", "open", {"target": "spotify"}),
    ("stop", "stop", {}),
    ("never mind", "stop", {}),
    ("click assignments", "click", {"target": "assignments"}),
    ("Click on the submit button", "click", {"target": "the submit button"}),
    ("scroll down", "browser_scroll", {"direction": "down"}),
    ("scroll to the bottom", "browser_scroll", {"direction": "bottom"}),
    ("go back", "browser_nav", {"action": "back"}),
    ("refresh the page", "browser_nav", {"action": "reload"}),
    ("set volume to 30", "volume", {"level": 30}),
    ("turn it down", "volume", {"delta": -10}),
    ("mute", "volume", {"mute": True}),
    ("lock my screen", "lock_screen", {}),
    ("switch to maximum performance mode", "power_mode", {"mode": "max_performance"}),
    ("press command shift t", "keys", {"combo": "cmd+shift+t"}),
    ("create a shortcut called Open My IB", "shortcut_create", {"name": "open my ib"}),
    ("delete the shortcut called study mode", "shortcut_delete", {"name": "study mode"}),
    ("what do you remember about my courses", "recall", {"query": "my courses"}),
    ("open youtube dot com", "open_url", {"url": "youtube.com"}),
])
def test_route(text, name, args):
    it = route(text, {"browser_active": True})
    assert it is not None and it.name == name
    for k, v in args.items():
        assert it.args[k] == v


def test_unrecognized_goes_to_ai():
    assert route("find all my resumes, compare them and tell me which is newest") is None
    assert route("read the instructions and tell me what I need to do") is None


def test_raw_text_preserved():
    assert route("type Hello, World").args["text"] == "Hello, World"
    assert "https://ib.example.edu/Course" in route("Remember that my IB course is https://ib.example.edu/Course.").args["content"]


def test_whenever_i_say():
    it = route("JARVIS, whenever I say 'study mode,' open these three websites, activate Do Not Disturb, and arrange my windows.")
    assert it.name == "shortcut_create" and it.args["name"] == "study mode"
    assert "do not disturb" in it.args["description"].lower()


def test_spoken_combo():
    assert spoken_combo("command t") == "cmd+t"
    assert spoken_combo("the return key") is None or spoken_combo("return") == "return"
    assert spoken_combo("submit") is None


ELEMENTS = [
    {"id": "w1", "role": "link", "name": "Home"},
    {"id": "w2", "role": "link", "name": "Assignments"},
    {"id": "w3", "role": "link", "name": "Assignment Groups"},
    {"id": "w4", "role": "button", "name": "Submit Assignment"},
    {"id": "w5", "role": "link", "name": "Grades"},
]


def test_element_match_exact_and_fuzzy():
    assert best_element_match("assignments", ELEMENTS)["id"] == "w2"
    assert best_element_match("the grades tab", ELEMENTS)["id"] == "w5"
    assert best_element_match("submit", ELEMENTS)["id"] == "w4"


def test_element_match_refuses_garbage():
    assert best_element_match("calendar", ELEMENTS) is None
