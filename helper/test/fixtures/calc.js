function calcTotal(items, tax = 0.09) {
  let subtotal = 0;
  for (const item of items) {
    const price = item.price * item.qty;
    subtotal += price;
  }
  const taxAmount = Math.round(subtotal * tax * 100) / 100;
  const total = subtotal + taxAmount;
  return total;
}

const data = [{ price: 10, qty: 2 }, { price: 5.5, qty: 1 }];
const result = calcTotal(data);
console.log("total:", result);
