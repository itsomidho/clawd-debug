let calls = 0;
function bump() { calls += 1; return calls; }
function work(n) {
  const first = bump();
  const last = first + n;
  return last;
}
console.log("result", work(10), "calls", calls);
