<?php
// clawd-debug helper tests: code under test, loaded by the harnesses.

function clawd_test_total(array $items): float {
    $sum = 0;
    foreach ($items as $item) {
        $price = $item['price'] * $item['qty'];
        $sum += $price;
    }
    return $sum;
}

function clawd_test_parse(array $row): int {
    $price = $row['price'] ?? null;
    if ($price === null) {
        throw new InvalidArgumentException('price is missing');
    }
    return (int) $price;
}

function clawd_test_site(): string {
    $url = get_option('siteurl');
    return (string) $url;
}
