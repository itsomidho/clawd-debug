<?php
require_once __DIR__ . '/lib.php';
$items = [['price' => 10, 'qty' => 2], ['price' => 5.5, 'qty' => 1]];
$total = clawd_test_total($items);
echo "total: $total\n";
