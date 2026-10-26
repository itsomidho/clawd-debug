def f(x):
    y = x["missing"]
    return y

f({"a": 1})
