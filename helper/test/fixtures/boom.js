function f(x) {
  const y = x.missing.deep;
  return y;
}
f({ a: 1 });
