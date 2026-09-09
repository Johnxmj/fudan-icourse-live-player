"""Synthetic secrets only; never include real authentication material."""

import unittest

from live_player.core.redaction import redact_message


class RedactionTest(unittest.TestCase):
    def test_never_logs_credentials_or_signed_query(self):
        value = redact_message("login 22300000000 password=secret https://media.invalid/a.ts?auth_key=abc&t=def")
        for secret in ("22300000000", "secret", "abc", "def"):
            self.assertNotIn(secret, value)
        self.assertIn("[redacted]", value)

    def test_redacts_sensitive_fields_in_objects_and_text(self):
        for key in ("password", "passwd", "pwd", "student_id", "username", "cookie", "access_token", "auth_key", "token", "sign", "clientUUID", "t"):
            for value in ({key: "fixture-private value"}, f'{key}="fixture-private value"', f"{key}=fixture-private"):
                with self.subTest(key=key):
                    self.assertNotIn("fixture-private", redact_message(value))

    def test_redacts_all_url_query_values_and_userinfo(self):
        value = redact_message("failed https://fixture-user:fixture-pass@media.invalid/a?AUTH_KEY=fixture-a&other=fixture-b#fixture-c")
        for secret in ("fixture-user", "fixture-pass", "fixture-a", "fixture-b", "fixture-c"):
            self.assertNotIn(secret, value)
        self.assertIn("media.invalid/a", value)

    def test_redacts_header_values(self):
        for header in ("Authorization: Bearer fixture-private", "Cookie: sid=fixture-private; route=fixture-other", "Set-Cookie: sid=fixture-private; HttpOnly"):
            self.assertNotIn("fixture-", redact_message(header))

    def test_keeps_non_sensitive_diagnostics(self):
        self.assertEqual(redact_message(RuntimeError("connection timed out (503)")), "connection timed out (503)")

    def test_redaction_is_stable_across_multiple_boundaries(self):
        once = redact_message("password=fixture-private https://media.invalid/a?token=fixture-token")
        self.assertEqual(redact_message(once), once)

    def test_quoted_password_with_escaped_quote_is_fully_redacted(self):
        value = redact_message(r'password="first\"fixture-private"')
        self.assertNotIn("fixture-private", value)

    def test_url_query_apostrophe_does_not_expose_suffix(self):
        value = redact_message("https://media.invalid/a?token=first'fixture-private")
        self.assertNotIn("fixture-private", value)

    def test_unquoted_password_delimiters_do_not_expose_suffix(self):
        for separator in (",", ";", "}", "]"):
            value = redact_message("password=first" + separator + "fixture-private")
            self.assertNotIn("fixture-private", value)

    def test_handles_broken_string_conversion_safely(self):
        class Broken:
            def __str__(self):
                raise ValueError("fixture-private")
        self.assertNotIn("fixture-private", redact_message(Broken()))
