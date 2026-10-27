<?php
// clawd-debug test cases: copy next to your harness and require it.
//
//   clawd_case('nbsp', fn () => CurrencyPrice::get_content_coins_list($text), ['btc' => [...]]);
//
// Runs one case, compares its result with what is expected (==, which ignores
// the order of array keys: compare array_keys() to check an order), and prints
// one line the debugger reads. With CLAWD_CASE set (a rerun of one case)
// only that case runs, and an error is not caught, so the debugger stops on it.

if (!function_exists('clawd_case')) {
    function clawd_case(string $name, callable $run, $expected): void {
        $only = getenv('CLAWD_CASE');
        if ($only !== false && $only !== '' && $only !== $name) {
            return;
        }
        $out = ['name' => $name, 'expected' => $expected];
        if ($only !== false && $only !== '') {
            $out['actual'] = $run();
        } else {
            try {
                $out['actual'] = $run();
            } catch (Throwable $e) {
                $out['error'] = get_class($e) . ': ' . $e->getMessage();
            }
        }
        $out['ok'] = !isset($out['error']) && $out['actual'] == $expected;
        echo '@@clawd-case ', json_encode($out, JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR), "\n";
    }
}
