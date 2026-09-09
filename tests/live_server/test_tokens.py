import concurrent.futures
import unittest

from live_player.server.tokens import TokenStore


class TokenStoreTest(unittest.TestCase):
    def test_bootstrap_token_is_one_use(self):
        store = TokenStore(clock=lambda: 100)
        token = store.issue({"kind": "bootstrap"}, ttl_seconds=30)
        self.assertEqual(store.consume(token), {"kind": "bootstrap"})
        self.assertIsNone(store.consume(token))

    def test_clear_discards_all_tokens(self):
        store = TokenStore(clock=lambda: 100)
        token = store.issue("value", ttl_seconds=30)
        store.clear()
        self.assertIsNone(store.consume(token))

    def test_expiry_boundary_and_unknown_token(self):
        now = [100]
        store = TokenStore(clock=lambda: now[0])
        token = store.issue("secret", 30)
        now[0] = 130
        self.assertIsNone(store.consume(token))
        self.assertIsNone(store.consume("unknown"))

    def test_only_one_concurrent_consumer_succeeds(self):
        store = TokenStore()
        token = store.issue("value", 30)
        with concurrent.futures.ThreadPoolExecutor() as pool:
            results = list(pool.map(store.consume, [token] * 20))
        self.assertEqual(results.count("value"), 1)

    def test_invalid_lifetimes_are_rejected(self):
        for ttl in (0, -1, float("inf"), float("nan")):
            with self.subTest(ttl=ttl), self.assertRaises(ValueError):
                TokenStore().issue("value", ttl)
