def calc_total(items, tax=0.09):
    subtotal = 0
    for item in items:
        price = item["price"] * item["qty"]
        subtotal += price
    tax_amount = round(subtotal * tax, 2)
    total = subtotal + tax_amount
    return total


if __name__ == "__main__":
    data = [{"price": 10, "qty": 2}, {"price": 5.5, "qty": 1}]
    result = calc_total(data)
    print("total:", result)
