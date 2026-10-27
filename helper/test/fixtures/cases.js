const { clawdCase } = require('../../cases/clawd_case.js')

function total(items) {
  let sum = 0
  for (const item of items) sum += item.price * item.qty
  return sum
}

clawdCase('two items', () => total([{ price: 10, qty: 2 }, { price: 5.5, qty: 1 }]), 25.5)
clawdCase('empty', () => total([]), 0)
clawdCase('wrong on purpose', () => total([{ price: 2, qty: 3 }]), 5)
clawdCase('throws', () => total(null), 0)
console.log('done')
