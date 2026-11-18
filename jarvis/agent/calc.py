"""Safe calculator for the agent: evaluates math expressions without running arbitrary code."""
from __future__ import annotations

import ast
import math
import operator

_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod, ast.Pow: operator.pow,
        ast.USub: operator.neg, ast.UAdd: operator.pos}
_NAMES = {k: getattr(math, k) for k in ("pi", "e", "tau", "inf")}
_FUNCS = {k: getattr(math, k) for k in ("sqrt", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh",
                                         "log", "log10", "log2", "exp", "floor", "ceil", "factorial", "comb", "perm",
                                         "radians", "degrees", "hypot", "gcd", "lcm", "fabs")}
_FUNCS.update({"abs": abs, "round": round, "min": min, "max": max, "sum": lambda *a: sum(a), "ln": math.log})


def safe_eval(expr: str):
    expr = expr.replace("^", "**").replace("×", "*").replace("÷", "/").replace("−", "-")
    tree = ast.parse(expr, mode="eval")

    def ev(n):
        if isinstance(n, ast.Expression):
            return ev(n.body)
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)):
            return n.value
        if isinstance(n, ast.BinOp) and type(n.op) in _OPS:
            left, right = ev(n.left), ev(n.right)
            if isinstance(n.op, ast.Pow) and (abs(right) > 1000 or abs(left) > 1e12):
                raise ValueError("exponent too large")
            return _OPS[type(n.op)](left, right)
        if isinstance(n, ast.UnaryOp) and type(n.op) in _OPS:
            return _OPS[type(n.op)](ev(n.operand))
        if isinstance(n, ast.Name) and n.id in _NAMES:
            return _NAMES[n.id]
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in _FUNCS and not n.keywords:
            args = [ev(a) for a in n.args]
            if n.func.id == "factorial" and args and args[0] > 1000:
                raise ValueError("number too large")
            return _FUNCS[n.func.id](*args)
        raise ValueError(f"unsupported expression element: {ast.dump(n)[:40]}")

    v = ev(tree)
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e15:
        v = int(v)
    elif isinstance(v, float):
        v = round(v, 10)
    return v
